import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { queuedSession } from './runtime-helper.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';

const root = resolve(import.meta.dirname, '..');
const source = readFileSync(join(root, 'index.ts'), 'utf8');
const user = (content = 'hello') => ({ role: 'user', content, timestamp: 123 });
const entry = (message) => ({ type: 'message', message });

async function fixture(t, { compiled = false, mode = 'tui', entries = [], reason = 'startup', defaults = false, visibility = 'visible' } = {}) {
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
  const configPath = join(fixtureHome, '.pi', 'agent', 'prompt-snippets-config.json');
  mkdirSync(snippetsDir, { recursive: true });
  if (visibility) writeFileSync(configPath, JSON.stringify({ visibility }, null, 2), 'utf8');
  if (defaults) cpSync(join(root, 'snippets'), join(dir, 'snippets'), { recursive: true });
  else {
    for (const [file, placement, persistent, body, order] of [
      ['a.md', 'prepend', true, 'PRE', 2],
      ['b.md', 'append', true, 'POST', 1],
      ['c.md', 'append', false, 'MANUAL', 3],
    ]) writeFileSync(join(snippetsDir, file), `---\nname: ${file}\nplacement: ${placement}\npersistent: ${persistent}\norder: ${order}\n---\n${body}`);
  }
  const modulePath = compiled ? join(dir, 'dist', 'index.js') : join(dir, 'index.ts');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  // Relocate the entry, not just its fixture data: module-level filesystem
  // constants must be initialized afresh, and bundled paths must be real.
  writeFileSync(modulePath, compiled ? readFileSync(join(root, 'dist', 'index.js'), 'utf8') : source);
  const jiti = createJiti(import.meta.url, { interopDefault: true, esmResolve: true });
  const piAgent = await import('@earendil-works/pi-coding-agent');
  piAgent.initTheme('dark', false);
  const extension = (await jiti.import(modulePath)).default;
  const handlers = new Map();
  let menuKeys = [];
  // Initialize a theme compatible with pi-coding-agent's theme system
  const theme = {
    fg: (color, text) => text,
    bold: (text) => text,
    dim: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
    strikethrough: (text) => text,
    style: (text, opts) => text,
    // Provide properties needed by getSettingsTheme
    get colors() {
      return {
        accent: '#00ffff',
        foreground: '#ffffff',
        dim: '#666666',
        background: '#000000',
      };
    },
    appearance: 'dark',
  };
  const ctx = {
    mode, hasUI: mode === 'tui',
    sessionManager: { getEntries: () => entries, getBranch: () => { throw new Error('must inspect all entries'); } },
    ui: {
      theme, setWidget() {}, notify() {},
      async custom(factory) {
        let result;
        let closed = false;
        const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value) => { closed = true; result = value; });
        for (const key of menuKeys) {
          if (typeof key === 'function') {
            key(component.render(80));
            for (const width of [1, 10, 35]) {
              assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
            }
          } else component.handleInput(key);
        }
        assert.equal(closed, true, 'menu must close with Esc, not Enter or Ctrl+S');
        return result;
      },
    },
  };
  let command;
  extension({ on: (name, handler) => handlers.set(name, handler), registerShortcut() {}, registerCommand: (_, options) => { command = options.handler; } });
  const emit = (name, event) => handlers.get(name)?.(event, ctx);
  await emit('session_start', { reason });
  return {
    dir, snippetsDir, configPath, entries, emit, extension,
    menuUI(keys) { menuKeys = keys; return ctx.ui; },
    input: async (text = 'hello', source = 'interactive', images) => await emit('input', { text, source, images }),
    async record(message) {
      const result = await emit('message_end', { message });
      entries.push(entry(result?.message ?? message));
      return result;
    },
    async menu(keys) { menuKeys = keys; await command('', ctx); },
  };
}

for (const compiled of [false, true]) {
  test(`${compiled ? 'compiled' : 'source'}: automatic transform is returned at recording, only once (hidden mode)`, async (t) => {
    const f = await fixture(t, { compiled, visibility: 'hidden' });
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
  test(`${compiled ? 'compiled' : 'source'}: automatic transform via input (visible mode, default)`, async (t) => {
    const f = await fixture(t, { compiled, visibility: 'visible' });
    const inputResult = await f.input();
    assert.equal(inputResult.action, 'transform');
    assert.equal(inputResult.text, 'PRE\n\nhello\n\nPOST');
    const message = user(inputResult.text);
    const recordResult = await f.record(message);
    assert.equal(recordResult, undefined, 'visible mode does not transform at message_end');
    assert.equal(await f.input('second'), undefined, 'second input has no automatic selection');
  });
  test(`${compiled ? 'compiled' : 'source'}: bundled snippets resolve from package root`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });
    assert.ok(existsSync(join(f.snippetsDir, 'session-kickoff.md')));
  });
}

for (const reason of ['startup', 'new', 'resume', 'reload', 'fork']) {
  test(`${reason}: empty session eligible, retained user history ineligible (hidden mode)`, async (t) => {
    const f = await fixture(t, { reason, entries: [entry({ role: 'system', content: '' }), { type: 'custom', data: 'metadata' }], visibility: 'hidden' });
    assert.ok(await f.record(user()));
    // Reinitialize as a used session, including an off-branch user entry.
    await f.emit('session_start', { reason });
    assert.equal(await f.record(user('later')), undefined);
  });
}

test('rejected/intercepted inputs do not consume eligibility; source does not matter (visible mode)', async (t) => {
  const f = await fixture(t, { visibility: 'visible' });
  // A later input handler may intercept, or model/auth preflight may reject:
  // neither emits message_end. Exercise repeated attempts without recording.
  for (const source of ['interactive', 'rpc', 'extension']) {
    const result = await f.input('rejected', source);
    assert.equal(result.action, 'transform', 'automatic selection still active');
    assert.equal(result.text, 'PRE\n\nrejected\n\nPOST');
  }
  // First recorded message consumes automatic selection
  const inputResult = await f.input('accepted');
  assert.equal(inputResult.text, 'PRE\n\naccepted\n\nPOST');
  const recordResult = await f.record(user(inputResult.text));
  assert.equal(recordResult, undefined);
  // An assistant error after the user was recorded must not restore eligibility.
  await f.emit('message_end', { message: { role: 'assistant', stopReason: 'error' } });
  assert.equal(await f.input('retry'), undefined, 'automatic selection consumed');
});

test('Hidden queued inputs inject only into the first actually recorded message', async (t) => {
  const f = await fixture(t, { visibility: 'hidden' });
  for (const text of ['queued first', 'queued second', 'discarded queue item']) {
    assert.equal(await f.input(text), undefined);
  }
  // Deliver out of input order, and never deliver the discarded item.
  assert.equal((await f.record(user('queued second'))).message.content, 'PRE\n\nqueued second\n\nPOST');
  assert.equal(await f.input('queued first'), undefined);
  assert.equal(await f.record(user('queued first')), undefined);
});

test('expanded content and image blocks retain order and identity (hidden mode)', async (t) => {
  const f = await fixture(t, { visibility: 'hidden' });
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

test('image-only first user message counts (hidden mode)', async (t) => {
  const f = await fixture(t, { visibility: 'hidden' });
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
  test(`${mode} remains eligible (hidden mode)`, async (t) => {
    const f = await fixture(t, { mode, visibility: 'hidden' });
    assert.ok(await f.record(user()));
  });
}

test('unchanged menu preserves automatic selection until first recording', async (t) => {
  const f = await fixture(t);
  await f.menu(['\u001b']);
  assert.equal((await f.input('rejected attempt')).text, 'PRE\n\nrejected attempt\n\nPOST');
  const result = await f.input('manual');
  assert.equal(result.text, 'PRE\n\nmanual\n\nPOST');
  assert.equal(await f.record(user(result.text)), undefined);
  assert.equal(await f.input('next'), undefined);
});

test('Visibility-only menu preserves automatic eligibility across rejected attempts', async (t) => {
  const f = await fixture(t, { visibility: 'hidden' });
  await f.menu(['\u001b[A', '\r', '\u001b']);
  assert.equal((await f.input('rejected one')).text, 'PRE\n\nrejected one\n\nPOST');
  assert.equal((await f.input('rejected two')).text, 'PRE\n\nrejected two\n\nPOST');
});

test('Visible→Hidden excludes already inserted IDs even if manually reselected; fresh Hidden still works', async (t) => {
  const f = await fixture(t);
  const transformed = await f.input('pending');
  // Automatic persistent PRE -> off -> temporary, plus a new manual append.
  await f.menu([' ', ' ', '\u001b[B', '\u001b[B', ' ', '\u001b[B', '\r', '\u001b']);
  const result = await f.record(user(transformed.text));
  assert.equal(result.message.content, 'PRE\n\npending\n\nPOST\n\nMANUAL');
  await f.menu(['\u001b']); // No-op must not restore consumed selections.
  assert.equal(await f.record(user('later')), undefined);
  await f.menu([' ', '\u001b']);
  assert.equal((await f.record(user('fresh Hidden'))).message.content, 'PRE\n\nfresh Hidden');
});

test('rejected Visible→Hidden attempt may omit snippets but recording and session initialization clear provenance', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.input('rejected')).text, 'PRE\n\nrejected\n\nPOST');
  await f.menu(['\u001b[A', '\r', '\u001b']);
  assert.equal(await f.record(user('accepted Hidden')), undefined, 'conservative omission is allowed after rejected Visible input');
  await f.menu([' ', '\u001b']);
  assert.equal((await f.record(user('fresh Hidden'))).message.content, 'PRE\n\nfresh Hidden');

  // A new empty session must not inherit even unrecorded Visible provenance.
  f.entries.length = 0;
  await f.menu(['\u001b[A', '\r', '\u001b']);
  await f.emit('session_start', { reason: 'new' });
  assert.equal((await f.input('abandoned')).text, 'abandoned\n\nPOST');
  await f.menu(['\u001b[A', '\r', '\u001b']);
  await f.emit('session_start', { reason: 'new' });
  assert.equal((await f.record(user('new Hidden session'))).message.content, 'new Hidden session\n\nPOST');
});

test('repeated Visibility-only changes neither reapply nor rearm consumed automatic selections', async (t) => {
  const f = await fixture(t);
  const transformed = await f.input('pending');
  for (let i = 0; i < 3; i++) await f.menu(['\u001b[A', '\r', '\u001b']);
  assert.equal(await f.record(user(transformed.text)), undefined);
  for (let i = 0; i < 4; i++) await f.menu(['\u001b[A', '\r', '\u001b']);
  await f.menu(['\u001b']);
  assert.equal(await f.input('later'), undefined);
  assert.equal(await f.record(user('later')), undefined);
});

test('menu close does not restore selections consumed while open', async (t) => {
  const f = await fixture(t, { entries: [entry(user('old'))] });
  await f.menu([' ', '\u001b']);
  let attempt;
  await f.menu([() => { attempt = f.input('during menu'); }, '\u001b']);
  assert.equal((await attempt).text, 'PRE\n\nduring menu');
  assert.equal(await f.input('after menu'), undefined);
});

test('explicit empty menu selection suppresses automatic defaults', async (t) => {
  const f = await fixture(t);
  await f.menu([' ', '\u001b[B', ' ', '\u001b']); // persistent -> off for both defaults
  assert.equal(await f.input(), undefined);
  assert.equal(await f.record(user()), undefined);
});

test('Esc saves changes rather than cancelling', async (t) => {
  const f = await fixture(t);
  await f.menu([' ', '\u001b']);
  assert.equal((await f.input()).text, 'hello\n\nPOST');
  assert.equal(await f.record(user('hello\n\nPOST')), undefined);
  assert.equal(await f.input('later'), undefined);
  assert.match(readFileSync(join(f.snippetsDir, 'a.md'), 'utf8'), /persistent: false/);
});

test('manual selection remains available in used sessions', async (t) => {
  const f = await fixture(t, { entries: [entry(user('old'))] });
  await f.menu([' ', '\u001b']);
  assert.equal((await f.input()).text, 'PRE\n\nhello');
  assert.equal(await f.record(user('manual')), undefined);
});

for (const compiled of [false, true]) {
  const label = compiled ? 'compiled' : 'source';
  test(`${label}: second and last snippet preview follow selection, including after cycling`, async (t) => {
    const f = await fixture(t, { compiled });
    const has = (text) => (rows) => assert.ok(rows.join('\n').includes(text), rows.join('\n'));
    await f.menu([
      '\u001b[B', '\t', has('Preview: b.md'), has('POST'),
      '\u001b', ' ', '\t', has('Preview: b.md'),
      '\t', '\u001b[B', '\t', has('Preview: c.md'), has('MANUAL'),
      '\t', '\u001b[B', '\t', has('Prompt snippets'),
      '\u001b',
    ]);
  });
  test(`${label}: Enter and Space cycle off/temporary/persistent and Esc saves`, async (t) => {
    const f = await fixture(t, { compiled, entries: [entry(user('old'))] });
    await f.menu(['\r', '\r', '\u0013', '\u001b']);
    assert.match(readFileSync(join(f.snippetsDir, 'a.md'), 'utf8'), /persistent: true/);
    assert.equal((await f.input('manual')).text, 'PRE\n\nmanual');
    await f.menu([' ', '\u001b']); // used persistent snippet starts off -> temporary
    assert.match(readFileSync(join(f.snippetsDir, 'a.md'), 'utf8'), /persistent: false/);
    assert.equal((await f.input('again')).text, 'PRE\n\nagain');
  });
}

for (const visibility of ['visible', 'hidden']) {
  test(`${visibility}: manual selection in used session is one-shot and preserves images`, async (t) => {
    const f = await fixture(t, { entries: [entry(user('old'))], visibility });
    await f.menu([' ', '\u001b']);
    const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
    const result = await f.input('hello', 'interactive', [image]);
    if (visibility === 'visible') {
      assert.equal(result.text, 'PRE\n\nhello');
      assert.equal(result.images, undefined, 'omitted images are preserved by Pi input chaining');
      assert.equal(await f.record(user([{ type: 'text', text: result.text }, image])), undefined);
    } else {
      assert.equal(result, undefined);
      const recorded = await f.record(user([image, { type: 'text', text: 'hello' }]));
      assert.deepEqual(recorded.message.content, [{ type: 'text', text: 'PRE\n\n' }, image, { type: 'text', text: 'hello' }]);
      assert.equal(recorded.message.content[1], image);
    }
    assert.equal(await f.input('next'), undefined);
    assert.equal(await f.record(user('next')), undefined);
  });
}

test('Visibility changes persist globally and do not alter snippet files', async (t) => {
  const f = await fixture(t);
  const before = readFileSync(join(f.snippetsDir, 'a.md'), 'utf8');
  await f.menu(['\u001b[A', '\r', '\t', (rows) => assert.ok(rows.join('\n').includes('Prompt snippets')), '\u001b']);
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, 'utf8')), { visibility: 'hidden' });
  assert.equal(readFileSync(join(f.snippetsDir, 'a.md'), 'utf8'), before);
  await f.emit('session_start', { reason: 'new' });
  assert.equal(await f.input(), undefined);
  assert.equal((await f.record(user())).message.content, 'PRE\n\nhello\n\nPOST');
});

test('missing, malformed and invalid global Visibility default to Visible', async (t) => {
  const f = await fixture(t, { visibility: null });
  for (const config of [null, '{invalid', '{"visibility":"other"}']) {
    if (config !== null) writeFileSync(f.configPath, config);
    await f.emit('session_start', { reason: 'reload' });
    assert.equal((await f.input()).text, 'PRE\n\nhello\n\nPOST');
  }
});

test('Hidden manual selection survives rejected inputs until a user message records', async (t) => {
  const f = await fixture(t, { entries: [entry(user('old'))], visibility: 'hidden' });
  await f.menu([' ', '\u001b']);
  assert.equal(await f.input('rejected'), undefined);
  assert.equal(await f.input('accepted'), undefined);
  assert.equal((await f.record(user('accepted'))).message.content, 'PRE\n\naccepted');
  assert.equal(await f.record(user('next')), undefined);
});

test('Visible manual selection is consumed by a rejected input transform, not retried', async (t) => {
  const f = await fixture(t, { entries: [entry(user('old'))], visibility: 'visible' });
  await f.menu([' ', '\u001b']);
  assert.equal((await f.input('rejected')).text, 'PRE\n\nrejected');
  // A later handler handles this attempt, or preflight rejects it: no recording.
  assert.equal(await f.input('accepted'), undefined);
  assert.equal(await f.record(user('accepted')), undefined);
});

for (const visibility of ['visible', 'hidden']) {
  test(`real AgentSession ${visibility} queued manual send: mid-flight toggle never duplicates snippets`, async (t) => {
      const f = await fixture(t, { visibility });
      const runtime = await queuedSession(t, f);
      await runtime.session.prompt('warmup'); // Consume automatic defaults.
      const hold = runtime.holdNextResponse();
      const running = runtime.session.prompt('busy');
      await hold.started;
      try {
        await runtime.menu([' ', '\u001b']); // Manual prepend for the next send/record.
        await runtime.session.followUp('queued A');
        await runtime.menu(['\u001b[A', '\r', '\u001b']); // Visibility only.
      } finally {
        hold.release();
        await running;
      }
      const recorded = runtime.session.sessionManager.getEntries()
        .filter((e) => e.type === 'message' && e.message.role === 'user');
      const queued = recorded.find((e) => e.message.content.some((part) => part.type === 'text' && part.text.includes('queued A')));
      assert.equal(queued.message.content.filter((part) => part.type === 'text').map((part) => part.text).join(''), visibility === 'visible' ? 'PRE\n\nqueued A' : 'queued A', 'Hidden→Visible mid-flight omission is allowed');
      const live = runtime.starts.find((message) => message.content.some((part) => part.type === 'text' && part.text.includes('queued A')));
      assert.equal(live.content.filter((part) => part.type === 'text').map((part) => part.text).join(''), visibility === 'visible' ? 'PRE\n\nqueued A' : 'queued A');
    });
}

for (const pending of ['paused input', 'queued input']) {
  test(`real AgentSession automatic Visible→Hidden ${pending}: never double PRE/POST`, async (t) => {
    const f = await fixture(t);
    let entered;
    let release;
    const paused = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const extension = (pi) => {
      f.extension(pi);
      if (pending === 'paused input') pi.on('input', async () => { entered(); await gate; });
    };
    const runtime = await queuedSession(t, { ...f, extension });
    if (pending === 'paused input') {
      const running = runtime.session.prompt('pending');
      await paused;
      try { await runtime.menu(['\u001b[A', '\r', '\u001b']); }
      finally { release(); await running; }
    } else {
      await runtime.session.steer('pending');
      await runtime.menu(['\u001b[A', '\r', '\u001b']);
      await runtime.session.prompt('starting');
    }
    const recorded = runtime.session.sessionManager.getEntries()
      .filter((e) => e.type === 'message' && e.message.role === 'user').map((e) => e.message);
    const text = (message) => message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    const message = recorded.find((m) => text(m).includes('pending'));
    assert.equal(text(message), 'PRE\n\npending\n\nPOST');
    assert.equal(text(runtime.starts.find((m) => text(m).includes('pending'))), text(message));
    await runtime.session.prompt('after recording');
    assert.equal(text(runtime.starts.at(-1)), 'after recording');
  });
}

for (const withImages of [false, true]) {
  test(`real AgentSession Visible→Hidden paused input: downstream edit and manual overlap${withImages ? ' with images' : ''}`, async (t) => {
    const f = await fixture(t);
    let entered;
    let release;
    const paused = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const extension = (pi) => {
      f.extension(pi);
      pi.on('input', async (event) => {
        entered();
        await gate;
        return { action: 'transform', text: event.text.replace('pending', 'edited downstream') };
      });
    };
    const runtime = await queuedSession(t, { ...f, extension });
    const image = { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png' };
    const running = runtime.session.prompt('pending', withImages ? { images: [image] } : {});
    await paused;
    try {
      // Reselect PRE manually while automatic PRE is already in the paused input.
      await runtime.menu([' ', ' ', '\u001b[A', '\r', '\u001b']);
    } finally {
      release();
      await running;
    }
    const message = runtime.session.sessionManager.getEntries()
      .find((e) => e.type === 'message' && e.message.role === 'user').message;
    const text = (m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    assert.equal(text(message), 'PRE\n\nedited downstream\n\nPOST');
    assert.equal(text(runtime.starts[0]), text(message));
    assert.deepEqual(message.content.filter((c) => c.type === 'image'), withImages ? [image] : []);
    assert.deepEqual(runtime.starts[0].content.filter((c) => c.type === 'image'), withImages ? [image] : []);
    await runtime.menu([' ', '\u001b']);
    await runtime.session.prompt('fresh Hidden');
    const users = runtime.session.sessionManager.getEntries()
      .filter((e) => e.type === 'message' && e.message.role === 'user');
    assert.equal(text(users.at(-1).message), 'PRE\n\nfresh Hidden');
  });
}

for (const visibility of ['hidden', 'visible']) {
  const behavior = visibility === 'visible'
    ? 'all inputs processed before first recording retain automatic snippets live and persisted'
    : 'only first recorded queued message receives automatic snippets';
  test(`real AgentSession ${visibility}: ${behavior}`, async (t) => {
    const f = await fixture(t, { visibility });
    const { session, starts } = await queuedSession(t, f);
    await session.steer('queued A');
    await session.prompt('starting B');
    const texts = (messages) => messages.map((m) => m.content.filter((c) => c.type === 'text').map((c) => c.text).join(''));
    const recorded = session.sessionManager.getEntries().filter((e) => e.type === 'message' && e.message.role === 'user').map((e) => e.message);
    if (visibility === 'hidden') {
      assert.deepEqual(texts(starts), ['starting B', 'queued A']);
    } else {
      assert.deepEqual(texts(starts), ['PRE\n\nstarting B\n\nPOST', 'PRE\n\nqueued A\n\nPOST'], 'both Visible inputs were transformed before the first recording');
    }
    assert.deepEqual(texts(recorded), visibility === 'visible'
      ? ['PRE\n\nstarting B\n\nPOST', 'PRE\n\nqueued A\n\nPOST']
      : ['PRE\n\nstarting B\n\nPOST', 'queued A']);
    if (visibility === 'visible') {
      assert.deepEqual(texts(recorded), texts(starts), 'no late stripping may diverge from the live Visible render');
    }
    await session.prompt('after recording');
    assert.equal(starts.at(-1).content[0].text, 'after recording');
  });
}

test('preview scrolls without changing selection and every rendered line fits narrow widths', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.snippetsDir, 'c.md'), `---\nname: Long snippet\nplacement: append\norder: 3\n---\n${Array.from({ length: 60 }, (_, i) => `body-line-${i}`).join('\n')}`);
  await f.menu([
    '\u001b[B', '\u001b[B', '\t',
    (rows) => assert.ok(rows.join('\n').includes('body-line-0')),
    '\u001b[B', '\u001b[B', '\u001b[B', '\u001b[B',
    (rows) => assert.ok(!rows.join('\n').includes('body-line-0\n')),
    '\u001b[A', '\u001b', '\t',
    (rows) => assert.ok(rows.join('\n').includes('Preview: Long snippet')),
    '\t', '\u001b',
  ]);
});

for (const visibility of ['visible', 'hidden']) {
  test(`real AgentSession ${visibility}: images preserved through input chaining and persistence`, async (t) => {
    const f = await fixture(t, { visibility });
    const { session, starts } = await queuedSession(t, f);
    // Real PNG bytes: the host correctly rejects the synthetic 'abc' used
    // by unit-level identity tests when its image normalizer is exercised.
    const image = { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png' };
    await session.prompt('hello', { images: [image] });
    assert.deepEqual(starts[0].content.filter((c) => c.type === 'image'), [image]);
    const recorded = session.sessionManager.getEntries().find((e) => e.type === 'message' && e.message.role === 'user').message;
    assert.deepEqual(recorded.content.filter((c) => c.type === 'image'), [image]);
    assert.equal(recorded.content.filter((c) => c.type === 'text').map((c) => c.text).join(''), 'PRE\n\nhello\n\nPOST');
  });
}

test('real AgentSession: later handled input does not consume automatic eligibility', async (t) => {
  const f = await fixture(t);
  let intercept = true;
  const extension = (pi) => {
    f.extension(pi);
    pi.on('input', () => intercept ? { action: 'handled' } : undefined);
  };
  const { session, starts } = await queuedSession(t, { ...f, extension });
  await session.prompt('intercepted');
  assert.equal(starts.length, 0);
  intercept = false;
  await session.prompt('accepted');
  assert.equal(starts[0].content[0].text, 'PRE\n\naccepted\n\nPOST');
});

test('package manifest exposes a shipped source entry and declares replacement API minimum', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.pi.extensions, ['./index.ts']);
  assert.ok(pkg.files.includes('index.ts'));
  assert.ok(pkg.files.includes('snippets'));
  assert.equal(pkg.peerDependencies['@earendil-works/pi-coding-agent'], '>=1.5.0');
});
