import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, 'index.ts'), 'utf8');
const user = (content = 'hello') => ({ role: 'user', content, timestamp: 123 });
const entry = (message) => ({ type: 'message', message });

async function fixture(t, { compiled = false, mode = 'tui', entries = [], reason = 'startup', defaults = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-snippets-test-'));
  const oldHomedir = os.homedir;
  const fixtureHome = join(dir, 'home');
  // Inject only the extension's filesystem location; do not relocate HOME,
  // XDG directories, npm configuration or caches for this test process.
  os.homedir = () => fixtureHome;
  syncBuiltinESMExports();
  t.after(() => {
    os.homedir = oldHomedir;
    syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const snippetsDir = join(fixtureHome, '.pi', 'agent', 'snippets');
  mkdirSync(snippetsDir, { recursive: true });
  if (defaults) cpSync(join(root, 'snippets'), join(dir, 'snippets'), { recursive: true });
  else {
    for (const [file, placement, persistent, body, order] of [
      ['a.md', 'prepend', true, 'PRE', 2],
      ['b.md', 'append', true, 'POST', 1],
      ['c.md', 'append', false, 'MANUAL', 3],
    ]) writeFileSync(join(snippetsDir, file), `---\nname: ${file}\nplacement: ${placement}\npersistent: ${persistent}\norder: ${order}\n---\n${body}`);
  }
  const modulePath = compiled ? join(dir, 'dist', 'index.js') : join(dir, 'index.mjs');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(modulePath, compiled ? readFileSync(join(root, 'dist/index.js'), 'utf8') : ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText);
  const { default: extension } = await import(pathToFileURL(modulePath).href);
  const handlers = new Map();
  let menuKeys = [];
  const theme = { fg: (_, text) => text, bold: (text) => text };
  const ctx = {
    mode, hasUI: mode === 'tui',
    sessionManager: { getEntries: () => entries, getBranch: () => { throw new Error('must inspect all entries'); } },
    ui: {
      theme, setWidget() {}, notify() {},
      async custom(factory) {
        let result;
        const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value) => { result = value; });
        for (const key of menuKeys) component.handleInput(key);
        return result;
      },
    },
  };
  let command;
  extension({ on: (name, handler) => handlers.set(name, handler), registerShortcut() {}, registerCommand: (_, options) => { command = options.handler; } });
  const emit = (name, event) => handlers.get(name)?.(event, ctx);
  await emit('session_start', { reason });
  return {
    dir, snippetsDir, entries, emit,
    input: (text = 'hello', source = 'interactive', images) => emit('input', { text, source, images }),
    async record(message) {
      const result = await emit('message_end', { message });
      entries.push(entry(result?.message ?? message));
      return result;
    },
    async menu(keys) { menuKeys = keys; await command('', ctx); },
  };
}

for (const compiled of [false, true]) {
  test(`${compiled ? 'compiled' : 'source'}: automatic transform is returned at recording, only once`, async (t) => {
    const f = await fixture(t, { compiled });
    assert.equal(await f.input(), undefined);
    const message = user();
    const snapshot = structuredClone(message);
    const result = await f.record(message);
    assert.deepEqual(message, snapshot, 'must return replacement, never mutate event message');
    assert.equal(result.message.content, 'PRE\n\nhello\n\nPOST');
    assert.equal(result.message.timestamp, 123);
    assert.equal(await f.input('second'), undefined);
    assert.equal(await f.record(user('second')), undefined);
  });
  test(`${compiled ? 'compiled' : 'source'}: bundled snippets resolve from package root`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });
    assert.ok(existsSync(join(f.snippetsDir, 'session-kickoff.md')));
  });
}

for (const reason of ['startup', 'new', 'resume', 'reload', 'fork']) {
  test(`${reason}: empty session eligible, retained user history ineligible`, async (t) => {
    const f = await fixture(t, { reason, entries: [entry({ role: 'system', content: '' }), { type: 'custom', data: 'metadata' }] });
    assert.ok(await f.record(user()));
    // Reinitialize as a used session, including an off-branch user entry.
    await f.emit('session_start', { reason });
    assert.equal(await f.record(user('later')), undefined);
  });
}

test('rejected/intercepted inputs do not consume eligibility; source does not matter', async (t) => {
  const f = await fixture(t);
  // A later input handler may intercept, or model/auth preflight may reject:
  // neither emits message_end. Exercise repeated attempts without recording.
  for (const source of ['interactive', 'rpc', 'extension']) assert.equal(await f.input('rejected', source), undefined);
  assert.equal((await f.record(user('accepted'))).message.content, 'PRE\n\naccepted\n\nPOST');
  // An assistant error after the user was recorded must not restore eligibility.
  await f.emit('message_end', { message: { role: 'assistant', stopReason: 'error' } });
  assert.equal(await f.record(user('retry')), undefined);
});

test('multiple queued inputs apply only to the first actually recorded message', async (t) => {
  const f = await fixture(t);
  await f.input('queued first', 'extension');
  await f.input('queued second', 'rpc');
  await f.input('discarded queue item');
  // Deliver out of input order, and never deliver the discarded item.
  assert.equal((await f.record(user('queued second'))).message.content, 'PRE\n\nqueued second\n\nPOST');
  assert.equal(await f.record(user('queued first')), undefined);
});

test('expanded content and image blocks retain order and identity', async (t) => {
  const f = await fixture(t);
  const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
  const text = { type: 'text', text: '<skill>expanded instructions</skill>\n\narguments' };
  await f.input('/skill:example arguments', 'extension', [image]);
  const content = [image, text];
  const result = await f.record(user(content));
  assert.deepEqual(content, [image, text]);
  assert.deepEqual(result.message.content, [{ type: 'text', text: 'PRE\n\n' }, image, text, { type: 'text', text: '\n\nPOST' }]);
  assert.equal(result.message.content[1], image);
  assert.equal(result.message.content[2], text);
});

test('image-only first user message counts', async (t) => {
  const f = await fixture(t);
  assert.ok(await f.record(user([{ type: 'image', data: 'abc', mimeType: 'image/png' }])));
  assert.equal(await f.record(user()), undefined);
});

test('directly inserted user history prevents automatic injection', async (t) => {
  const f = await fixture(t);
  f.entries.push(entry(user('inserted by extension')));
  assert.equal(await f.input(), undefined);
  assert.equal(await f.record(user()), undefined);
});

test('JSON excludes automatic selection', async (t) => {
  const f = await fixture(t, { mode: 'json' });
  assert.equal(await f.input(), undefined);
  assert.equal(await f.record(user()), undefined);
});

for (const mode of ['rpc', 'print']) {
  test(`${mode} remains eligible`, async (t) => {
    const f = await fixture(t, { mode });
    assert.ok(await f.record(user()));
  });
}

test('confirmed manual selection remains one-shot without automatic double injection', async (t) => {
  const f = await fixture(t);
  await f.menu(['\r']); // Confirm persistent defaults explicitly as a manual selection.
  const result = await f.input('manual');
  assert.equal(result.text, 'PRE\n\nmanual\n\nPOST');
  assert.equal(await f.record(user(result.text)), undefined);
  assert.equal(await f.input('next'), undefined);
});

test('explicit empty menu selection suppresses automatic defaults', async (t) => {
  const f = await fixture(t);
  await f.menu([' ', '\u001b[B', ' ', '\r']); // persistent -> off for both defaults
  assert.equal(await f.input(), undefined);
  assert.equal(await f.record(user()), undefined);
});

test('menu cancellation does not suppress automatic selection', async (t) => {
  const f = await fixture(t);
  await f.menu([' ', '\u001b']);
  assert.ok(await f.record(user()));
});

test('manual selection remains available in used sessions', async (t) => {
  const f = await fixture(t, { entries: [entry(user('old'))] });
  await f.menu([' ', '\r']);
  assert.equal((await f.input()).text, 'PRE\n\nhello');
  assert.equal(await f.record(user('manual')), undefined);
});

test('package manifest exposes a shipped source entry and declares replacement API minimum', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.pi.extensions, ['./index.ts']);
  assert.ok(pkg.files.includes('index.ts'));
  assert.ok(pkg.files.includes('snippets'));
  assert.equal(pkg.peerDependencies['@earendil-works/pi-coding-agent'], '>=1.5.0');
});
