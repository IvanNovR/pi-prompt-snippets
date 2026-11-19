import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import fs, { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { queuedSession } from './runtime-helper.mjs';
import { visibleWidth } from '@earendil-works/pi-tui';

const root = resolve(import.meta.dirname, '..');
const user = (content = 'hello') => ({ role: 'user', content, timestamp: 123 });
const entry = (message) => ({ type: 'message', message });

async function fixture(t, { compiled = false, mode = 'tui', entries = [], reason = 'startup', defaults = false, visibility = 'visible', home, prepare } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-snippets-test-'));
  const oldHomedir = os.homedir;
  const fixtureHome = home ?? join(dir, 'home');
  // Inject only the extension's filesystem location; do not relocate HOME,
  // XDG directories, npm configuration or caches for this test process.
  if (!home) {
    os.homedir = () => fixtureHome;
    syncBuiltinESMExports();
  }
  t.after(() => {
    if (!home) {
      os.homedir = oldHomedir;
      syncBuiltinESMExports();
    }
    rmSync(dir, { recursive: true, force: true });
  });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const snippetsDir = join(fixtureHome, '.pi', 'agent', 'snippets');
  const configPath = join(fixtureHome, '.pi', 'agent', 'prompt-snippets-config.json');
  const ledgerPath = join(fixtureHome, '.pi', 'agent', 'prompt-snippets-defaults-ledger.json');
  mkdirSync(snippetsDir, { recursive: true });
  if (visibility && !home) writeFileSync(configPath, JSON.stringify({ visibility }, null, 2), 'utf8');
  if (defaults) cpSync(join(root, 'snippets'), join(dir, 'snippets'), { recursive: true });
  else if (!home) {
    for (const [file, placement, persistent, body, order] of [
      ['a.md', 'prepend', true, 'PRE', 2],
      ['b.md', 'append', true, 'POST', 1],
      ['c.md', 'append', false, 'MANUAL', 3],
    ]) writeFileSync(join(snippetsDir, file), `---\nname: ${file}\nplacement: ${placement}\npersistent: ${persistent}\norder: ${order}\n---\n${body}`);
  }
  const modulePath = compiled ? join(dir, 'dist', 'pi-extension', 'prompt-snippets', 'index.js') : join(dir, 'pi-extension', 'prompt-snippets', 'index.ts');
  mkdirSync(join(dir, 'dist', 'pi-extension', 'prompt-snippets'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  // Relocate the entry, not just its fixture data: module-level filesystem
  // constants must be initialized afresh, and bundled paths must be real.
  if (compiled) {
    cpSync(join(root, 'dist', 'pi-extension', 'prompt-snippets'), join(dir, 'dist', 'pi-extension', 'prompt-snippets'), { recursive: true });
  } else {
    // Copy all source files
    cpSync(join(root, 'pi-extension', 'prompt-snippets'), join(dir, 'pi-extension', 'prompt-snippets'), { recursive: true });
  }
  prepare?.({ dir, snippetsDir, ledgerPath });
  const jiti = createJiti(import.meta.url, { interopDefault: true, esmResolve: true });
  const piAgent = await import('@earendil-works/pi-coding-agent');
  piAgent.initTheme('dark', false);
  const beforeImport = readdirSync(snippetsDir);
  const hadLedger = existsSync(ledgerPath);
  const extension = (await jiti.import(modulePath)).default;
  assert.deepEqual(readdirSync(snippetsDir), beforeImport, 'import must not seed files');
  assert.equal(existsSync(ledgerPath), hadLedger, 'import must not write ledger');
  const handlers = new Map();
  let menuKeys = [];
  let widget;
  let commandHandler;
  let commandCompletions;
  const notifications = [];
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
    mode, hasUI: mode === 'tui' || mode === 'rpc',
    sessionManager: { getEntries: () => entries, getBranch: () => { throw new Error('must inspect all entries'); } },
    ui: {
      theme, setWidget(_id, lines) { widget = lines; }, notify(message, level) { notifications.push({ message, level }); },
      async confirm(title, message) {
        // Default to cancel in tests unless overridden
        return false;
      },
      async custom(factory) {
        let result;
        let closed = false;
        const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value) => { closed = true; result = value; });
        for (const key of menuKeys) {
          if (typeof key === 'function') {
            await key(component.render(80));
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
  extension({
    on: (name, handler) => handlers.set(name, handler),
    registerShortcut() {},
    registerCommand: (_, options) => {
      commandHandler = options.handler;
      commandCompletions = options.getArgumentCompletions;
    }
  });
  const emit = (name, event) => handlers.get(name)?.(event, ctx);
  await emit('session_start', { reason });
  return {
    dir, home: fixtureHome, snippetsDir, configPath, ledgerPath, entries, emit, extension, notifications,
    get widget() { return widget; },
    menuUI(keys) { menuKeys = keys; return ctx.ui; },
    input: async (text = 'hello', source = 'interactive', images) => await emit('input', { text, source, images }),
    async record(message) {
      const result = await emit('message_end', { message });
      entries.push(entry(result?.message ?? message));
      return result;
    },
    async menu(keys) { menuKeys = keys; await commandHandler('', ctx); },
    async command(args, uiOverrides = {}) {
      const testCtx = { ...ctx, ui: { ...ctx.ui, ...uiOverrides } };
      await commandHandler(args, testCtx);
    },
    getCompletions(prefix) {
      return commandCompletions ? commandCompletions(prefix) : null;
    },
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

  test(`${compiled ? 'compiled' : 'source'}: first launch seeds all bundled defaults`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });
    const ledger = JSON.parse(readFileSync(f.ledgerPath, 'utf8'));
    assert.ok(ledger.seen.includes('session-kickoff.md'));
    assert.ok(ledger.seen.includes('ask-questions.md'));
    assert.equal(ledger.seen.length, 6);
  });

  test(`${compiled ? 'compiled' : 'source'}: deleted bundled default not restored on subsequent session`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });
    // Delete a bundled default
    rmSync(join(f.snippetsDir, 'session-kickoff.md'));

    // Start a fresh module in another installation sharing the same home/ledger.
    const f2 = await fixture(t, { compiled, defaults: true, home: f.home });

    // The deleted file should NOT be restored automatically
    assert.equal(existsSync(join(f2.snippetsDir, 'session-kickoff.md')), false);

    // Ledger still tracks it as seen
    const ledger = JSON.parse(readFileSync(f2.ledgerPath, 'utf8'));
    assert.ok(ledger.seen.includes('session-kickoff.md'));
  });

  test(`${compiled ? 'compiled' : 'source'}: new bundled default added in update is seeded`, async (t) => {
    const f = await fixture(t, { compiled, defaults: false });

    // Simulate initial state: only a.md, b.md, c.md
    const initialLedger = { seen: ['a.md', 'b.md', 'c.md'] };
    writeFileSync(f.ledgerPath, JSON.stringify(initialLedger, null, 2));

    // Now start with defaults=true (simulating package update with new bundled snippets)
    const f2 = await fixture(t, { compiled, defaults: true, home: f.home });

    // New bundled defaults should be seeded
    assert.ok(existsSync(join(f2.snippetsDir, 'session-kickoff.md')));

    // Ledger should include the new ones
    const ledger = JSON.parse(readFileSync(f2.ledgerPath, 'utf8'));
    assert.ok(ledger.seen.includes('session-kickoff.md'));
  });

  test(`${compiled ? 'compiled' : 'source'}: collision with user's existing file preserves user file`, async (t) => {
    const f = await fixture(t, { compiled, defaults: false });

    // User creates their own session-kickoff.md
    const userContent = '---\nname: My Custom\n---\nUser custom content';
    writeFileSync(join(f.snippetsDir, 'session-kickoff.md'), userContent);

    // Mark it as not seen yet in ledger
    const initialLedger = { seen: [] };
    writeFileSync(f.ledgerPath, JSON.stringify(initialLedger, null, 2));

    // Start with defaults=true
    const f2 = await fixture(t, { compiled, defaults: true, home: f.home });

    // User's file should be preserved
    const content = readFileSync(join(f2.snippetsDir, 'session-kickoff.md'), 'utf8');
    assert.equal(content, userContent);

    // Ledger should mark it as seen (to not try again)
    const ledger = JSON.parse(readFileSync(f2.ledgerPath, 'utf8'));
    assert.ok(ledger.seen.includes('session-kickoff.md'));
  });

  test(`${compiled ? 'compiled' : 'source'}: restore with confirmation (cancel)`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });

    // User deletes a file
    rmSync(join(f.snippetsDir, 'session-kickoff.md'));

    // Restore without --yes, user cancels
    let notifyMsg = '';
    await f.command('restore', {
      confirm: async () => false,
      notify: (msg) => { notifyMsg = msg; },
    });

    // File should NOT be restored
    assert.equal(existsSync(join(f.snippetsDir, 'session-kickoff.md')), false);
    assert.equal(notifyMsg, ''); // No success message
  });

  test(`${compiled ? 'compiled' : 'source'}: restore with confirmation (accept)`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });

    // User modifies a bundled file
    writeFileSync(join(f.snippetsDir, 'session-kickoff.md'), '---\nname: Modified\n---\nModified content');
    const originalContent = readFileSync(join(root, 'snippets', 'session-kickoff.md'), 'utf8');

    // Restore without --yes, user accepts
    let notifyMsg = '';
    await f.command('restore', {
      confirm: async () => true,
      notify: (msg, level) => { notifyMsg = msg; },
    });

    // File should be restored to original
    const content = readFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'utf8');
    assert.equal(content, originalContent);
    assert.match(notifyMsg, /Restored \d+ default snippets/);
  });

  test(`${compiled ? 'compiled' : 'source'}: restore with --yes flag bypasses confirmation`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });

    rmSync(join(f.snippetsDir, 'session-kickoff.md'));

    let confirmCalled = false;
    let notifyMsg = '';
    await f.command('restore --yes', {
      confirm: async () => { confirmCalled = true; return false; },
      notify: (msg) => { notifyMsg = msg; },
    });

    // Confirmation should NOT be called
    assert.equal(confirmCalled, false);

    // File should be restored
    assert.ok(existsSync(join(f.snippetsDir, 'session-kickoff.md')));
    assert.match(notifyMsg, /Restored \d+ default snippets/);
  });

  test(`${compiled ? 'compiled' : 'source'}: restore in non-interactive mode requires --yes`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true, mode: 'print' });

    let notifyMsg = '';
    let notifyLevel = '';
    await f.command('restore', {
      notify: (msg, level) => { notifyMsg = msg; notifyLevel = level; },
    });

    assert.match(notifyMsg, /requires --yes flag/);
    assert.equal(notifyLevel, 'error');
  });

  test(`${compiled ? 'compiled' : 'source'}: restore preserves custom snippets and renamed copies`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });

    // User creates custom snippet
    const customContent = '---\nname: Custom\n---\nMy custom snippet';
    writeFileSync(join(f.snippetsDir, 'my-custom.md'), customContent);

    // User renames a bundled default
    const renamedContent = readFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'utf8');
    writeFileSync(join(f.snippetsDir, 'my-kickoff-copy.md'), renamedContent);

    // Restore with --yes
    await f.command('restore --yes', {
      notify: () => {},
    });

    // Custom and renamed files should be preserved
    assert.equal(readFileSync(join(f.snippetsDir, 'my-custom.md'), 'utf8'), customContent);
    assert.equal(readFileSync(join(f.snippetsDir, 'my-kickoff-copy.md'), 'utf8'), renamedContent);

    // Original bundled file should exist
    assert.ok(existsSync(join(f.snippetsDir, 'session-kickoff.md')));
  });

  test(`${compiled ? 'compiled' : 'source'}: restore preserves current selection and mode`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });

    // Manually enable a snippet
    await f.menu([' ', ' ', '\u001b']); // a.md persistent -> off -> temporary
    assert.ok(f.widget); // Should have active widget

    // Restore
    await f.command('restore --yes', {
      notify: () => {},
    });

    // Widget should still show the temporary selection
    assert.ok(f.widget);
  });

  test(`${compiled ? 'compiled' : 'source'}: restore does not autoactivate newly restored snippets`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });

    // Start with no automatic eligibility (already recorded)
    await f.record(user('initial'));

    // Delete all bundled snippets
    rmSync(join(f.snippetsDir, 'session-kickoff.md'));
    rmSync(join(f.snippetsDir, 'ask-questions.md'));

    // Restore
    await f.command('restore --yes', {
      notify: () => {},
    });

    // No snippets should be auto-activated
    assert.equal(await f.input('test'), undefined);
  });

  test(`${compiled ? 'compiled' : 'source'}: restore unknown argument shows error`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });

    let notifyMsg = '';
    let notifyLevel = '';
    await f.command('restore --unknown --yes', {
      notify: (msg, level) => { notifyMsg = msg; notifyLevel = level; },
    });

    assert.match(notifyMsg, /Unknown arguments:.*--unknown/);
    assert.equal(notifyLevel, 'error');
  });

  test(`${compiled ? 'compiled' : 'source'}: settings alias opens the default menu`, async (t) => {
    const f = await fixture(t, { compiled });
    const notificationsBefore = [...f.notifications];
    let defaultRows;
    await f.menu([(rows) => { defaultRows = rows; }, '\u001b']);
    let opened = 0;
    await f.command('  settings  ', f.menuUI([(rows) => {
      opened++;
      assert.deepEqual(rows, defaultRows);
    }, '\u001b']));
    assert.equal(opened, 1);
    assert.deepEqual(f.notifications, notificationsBefore);
  });

  test(`${compiled ? 'compiled' : 'source'}: settings rejects extra arguments without restoring files`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });
    const file = join(f.snippetsDir, 'session-kickoff.md');
    writeFileSync(file, 'CUSTOM');
    const ledger = readFileSync(f.ledgerPath, 'utf8');
    for (const args of ['settings --yes', 'settings restore', 'settings extra', 'setting', 'unknown --yes']) {
      await f.command(args, { custom: async () => assert.fail('invalid command must not open menu'), confirm: async () => assert.fail('invalid command must not confirm restore') });
      assert.equal(f.notifications.at(-1).level, 'error');
      assert.equal(readFileSync(file, 'utf8'), 'CUSTOM');
      assert.equal(readFileSync(f.ledgerPath, 'utf8'), ledger);
    }
  });

  test(`${compiled ? 'compiled' : 'source'}: command completion offers settings and restore`, async (t) => {
    const f = await fixture(t, { compiled });

    const completions = f.getCompletions('');
    assert.ok(completions);
    assert.deepEqual(completions.map(({ value }) => value), ['settings', 'restore']);
    assert.deepEqual(f.getCompletions('set').map(({ value }) => value), ['settings']);
    assert.deepEqual(f.getCompletions('settings').map(({ value }) => value), ['settings']);

    const partialCompletions = f.getCompletions('res');
    assert.ok(partialCompletions);
    assert.equal(partialCompletions[0].value, 'restore');
  });

  test(`${compiled ? 'compiled' : 'source'}: command completion offers --yes after restore`, async (t) => {
    const f = await fixture(t, { compiled });

    const completions = f.getCompletions('restore ');
    assert.ok(completions);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].value, 'restore --yes');

    const completionsWithSpace = f.getCompletions('restore ');
    assert.ok(completionsWithSpace);
    assert.equal(completionsWithSpace[0].value, 'restore --yes');

    const partialCompletions = f.getCompletions('restore --y');
    assert.ok(partialCompletions);
    assert.equal(partialCompletions[0].value, 'restore --yes');
  });

  test(`${compiled ? 'compiled' : 'source'}: command completion handles whitespace and partial tokens`, async (t) => {
    const f = await fixture(t, { compiled });

    // Empty string
    const empty = f.getCompletions('');
    assert.ok(empty && empty.length > 0);

    // Multiple spaces
    const spaces = f.getCompletions('   ');
    assert.ok(spaces && spaces.length > 0);

    // Partial with spaces
    const partial = f.getCompletions('  res');
    assert.ok(partial && partial.length > 0);

    // After restore with trailing spaces
    const afterRestore = f.getCompletions('restore   ');
    assert.ok(afterRestore && afterRestore.length > 0);
  });

  test(`${compiled ? 'compiled' : 'source'}: unknown command shows error`, async (t) => {
    const f = await fixture(t, { compiled });

    let notifyMsg = '';
    let notifyLevel = '';
    await f.command('unknown', {
      notify: (msg, level) => { notifyMsg = msg; notifyLevel = level; },
    });

    assert.match(notifyMsg, /Unknown command: unknown/);
    assert.equal(notifyLevel, 'error');
  });
}

// Continue with existing tests for behavior preservation
for (const compiled of [false, true]) {
  for (const visibility of ['visible', 'hidden']) {
    const label = `${compiled ? 'compiled' : 'source'} ${visibility}`;
    const persistentRow = (rows) => assert.match(stripVTControlCharacters(rows.join('\n')), /a\.md\s+persistent/);
    const persistentPreview = (rows) => assert.ok(rows.join('\n').includes('a.md (persistent)'));
    const inspectPersistent = [persistentRow, '\t', persistentPreview, '\t'];
    const saved = (f) => ['a.md', 'b.md', 'c.md'].map((id) => readFileSync(join(f.snippetsDir, id), 'utf8'));
    const send = async (f, text) => {
      const input = await f.input(text);
      const recorded = await f.record(user(input?.text ?? text));
      return recorded?.message.content ?? input?.text ?? text;
    };

    test(`${label}: consumed persistent configuration stays visible without pending application`, async (t) => {
      const f = await fixture(t, { compiled, visibility });
      const bytes = saved(f);
      await f.menu([...inspectPersistent, '\u001b']);
      assert.equal(await send(f, 'first'), 'PRE\n\nfirst\n\nPOST');
      assert.equal(f.widget, undefined);
      for (let i = 0; i < 3; i++) {
        await f.menu([...inspectPersistent, '\u001b']);
        await f.menu(['\u001b[A', '\r', '\u001b']); // Visibility only
        assert.equal(f.widget, undefined);
      }
      assert.deepEqual(saved(f), bytes, 'sending and no-op/Visibility-only menus preserve file bytes');
      assert.equal(await send(f, 'next'), 'next');
      for (const reason of ['resume', 'reload', 'fork']) {
        await f.emit('session_start', { reason });
        await f.menu([...inspectPersistent, '\u001b']);
        assert.equal(f.widget, undefined);
        assert.equal(await send(f, reason), reason);
      }
      f.entries.length = 0;
      await f.emit('session_start', { reason: 'new' });
      assert.ok(f.widget);
      assert.equal(await send(f, 'new first'), 'PRE\n\nnew first\n\nPOST');
      assert.equal(f.widget, undefined);
      assert.equal(await send(f, 'new next'), 'new next');
      assert.deepEqual(saved(f), bytes);
    });

    for (const target of ['off', 'temporary']) {
      test(`${label}: explicit consumed persistent -> ${target} changes configuration and runtime`, async (t) => {
        const f = await fixture(t, { compiled, visibility });
        await send(f, 'first');
        await f.menu([...inspectPersistent, ' ', ...(target === 'temporary' ? [' '] : []), '\u001b']);
        assert.match(saved(f)[0], /persistent: false/);
        assert.equal(!!f.widget, target === 'temporary');
        assert.equal(await send(f, 'manual'), target === 'temporary' ? 'PRE\n\nmanual' : 'manual');
        assert.equal(f.widget, undefined);
        await f.menu([(rows) => assert.match(stripVTControlCharacters(rows.join('\n')), /a\.md\s+off/), '\t', (rows) => {
          assert.ok(!rows.join('\n').includes('a.md (persistent)'));
          assert.ok(!rows.join('\n').includes('a.md (temporary)'));
        }, '\t', '\u001b']);
        assert.equal(await send(f, 'later'), 'later');
        f.entries.length = 0;
        await f.emit('session_start', { reason: 'new' });
        assert.equal(await send(f, 'new'), 'new\n\nPOST');
        assert.equal(await send(f, 'new next'), 'new next');
      });
    }

    test(`${label}: consume while menu open never restores untouched persistent or temporary selections`, async (t) => {
      const f = await fixture(t, { compiled, visibility });
      // Add nonpersistent temporary c alongside automatic persistent defaults.
      await f.menu(['\u001b[B', '\u001b[B', ' ', '\u001b']);
      const bytes = saved(f);
      await f.menu([...inspectPersistent, async () => {
        assert.equal(await send(f, 'during'), 'PRE\n\nduring\n\nPOST\n\nMANUAL');
        assert.equal(f.widget, undefined);
      }, '\u001b[A', '\r', '\u001b']);
      assert.equal(f.widget, undefined);
      assert.deepEqual(saved(f), bytes);
      await f.menu([...inspectPersistent, '\u001b[B', '\u001b[B', (rows) => assert.match(stripVTControlCharacters(rows.join('\n')), /c\.md\s+off/), '\u001b']);
      assert.equal(await send(f, 'after'), 'after');
    });
  }
}

// Continue with more existing behavior tests...
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
  await f.menu([' ', ' ', '\u001b']); // persistent -> off -> temporary
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
  await f.menu([' ', ' ', '\u001b']); // saved persistent -> off -> temporary
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
  await f.menu([' ', ' ', '\u001b']);
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
    await f.menu(['\r', '\r', '\r', '\u001b']); // A full cycle leaves intent unchanged, so must not rearm.
    assert.equal(await f.input('unchanged'), undefined);
    await f.menu(['\r', '\u001b']); // persistent -> off
    await f.menu(['\r', '\r', '\u0013', '\u001b']); // off -> temporary -> persistent
    assert.match(readFileSync(join(f.snippetsDir, 'a.md'), 'utf8'), /persistent: true/);
    assert.equal((await f.input('manual')).text, 'PRE\n\nmanual');
    await f.menu([' ', ' ', '\u001b']); // consumed persistent stays persistent -> off -> temporary
    assert.match(readFileSync(join(f.snippetsDir, 'a.md'), 'utf8'), /persistent: false/);
    assert.equal((await f.input('again')).text, 'PRE\n\nagain');
  });
}

for (const visibility of ['visible', 'hidden']) {
  test(`${visibility}: manual selection in used session is one-shot and preserves images`, async (t) => {
    const f = await fixture(t, { entries: [entry(user('old'))], visibility });
    await f.menu([' ', ' ', '\u001b']); // persistent -> off -> temporary
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
  await f.menu([' ', ' ', '\u001b']);
  assert.equal(await f.input('rejected'), undefined);
  assert.equal(await f.input('accepted'), undefined);
  assert.equal((await f.record(user('accepted'))).message.content, 'PRE\n\naccepted');
  assert.equal(await f.record(user('next')), undefined);
});

test('Visible manual selection is consumed by a rejected input transform, not retried', async (t) => {
  const f = await fixture(t, { entries: [entry(user('old'))], visibility: 'visible' });
  await f.menu([' ', ' ', '\u001b']);
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
        await runtime.menu([' ', ' ', '\u001b']); // persistent -> off -> temporary for the next send/record.
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

for (const compiled of [false, true]) {
  const label = compiled ? 'compiled' : 'source';
  const snapshot = (f) => Object.fromEntries(readdirSync(f.snippetsDir).filter((name) => name.endsWith('.md')).map((name) => [name, readFileSync(join(f.snippetsDir, name), 'utf8')]));

  test(`${label}: actual bundle update adds only unseen names and remembers collisions`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });
    const custom = '---\nname: customized\n---\nCUSTOM';
    writeFileSync(join(f.snippetsDir, 'session-kickoff.md'), custom);
    rmSync(join(f.snippetsDir, 'ask-questions.md'));
    writeFileSync(join(f.dir, 'snippets', 'new-default.md'), '---\nname: new\n---\nNEW');
    writeFileSync(join(f.dir, 'snippets', 'collision.md'), '---\nname: shipped\n---\nSHIPPED');
    writeFileSync(join(f.snippetsDir, 'collision.md'), custom);
    await f.emit('session_start', { reason: 'reload' });
    assert.match(readFileSync(join(f.snippetsDir, 'new-default.md'), 'utf8'), /NEW/);
    assert.equal(readFileSync(join(f.snippetsDir, 'collision.md'), 'utf8'), custom);
    assert.equal(readFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'utf8'), custom);
    assert.equal(existsSync(join(f.snippetsDir, 'ask-questions.md')), false);
    rmSync(join(f.snippetsDir, 'collision.md'));
    await f.emit('session_start', { reason: 'new' });
    assert.equal(existsSync(join(f.snippetsDir, 'collision.md')), false);
    assert.ok(JSON.parse(readFileSync(f.ledgerPath)).seen.includes('collision.md'));
  });

  test(`${label}: corrupt ledger rebuild is reported and missing defaults recover without overwrite`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });
    const original = '---\npersistent: true\n---\nCUSTOM';
    writeFileSync(join(f.snippetsDir, 'session-kickoff.md'), original);
    rmSync(join(f.snippetsDir, 'ask-questions.md'));
    writeFileSync(f.ledgerPath, '{broken');
    await f.emit('session_start', { reason: 'reload' });
    assert.ok(existsSync(join(f.snippetsDir, 'ask-questions.md')));
    assert.equal(readFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'utf8'), original);
    assert.ok(f.notifications.some(({ message }) => /rebuilding as a first launch/.test(message)));
    assert.equal(JSON.parse(readFileSync(f.ledgerPath)).seen.length, 6);
  });

  test(`${label}: unreadable existing ledger recovers with warning when persistence is available`, async (t) => {
    const originalRead = fs.readFileSync;
    let f;
    try {
      f = await fixture(t, { compiled, defaults: true, prepare({ ledgerPath }) {
        writeFileSync(ledgerPath, JSON.stringify({ seen: ['session-kickoff.md'] }));
        fs.readFileSync = (path, ...args) => {
          if (path === ledgerPath) throw new Error('simulated unreadable ledger');
          return originalRead(path, ...args);
        };
        syncBuiltinESMExports();
      } });
    } finally {
      fs.readFileSync = originalRead;
      syncBuiltinESMExports();
    }
    assert.ok(f.notifications.some(({ message }) => /rebuilding as a first launch.*unreadable ledger/.test(message)));
    assert.ok(existsSync(join(f.snippetsDir, 'session-kickoff.md')));
    assert.equal(JSON.parse(readFileSync(f.ledgerPath)).seen.length, 6);
  });

  test(`${label}: automatic copy failures stay pending and retry in fresh module`, async (t) => {
    const originalCopy = fs.copyFileSync;
    let f;
    try {
      f = await fixture(t, { compiled, defaults: true, prepare() {
        fs.copyFileSync = (source, target, flags) => {
          if (target.endsWith('session-kickoff.md')) throw new Error('simulated copy failure');
          return originalCopy(source, target, flags);
        };
        syncBuiltinESMExports();
      } });
    } finally {
      fs.copyFileSync = originalCopy;
      syncBuiltinESMExports();
    }
    const ledger = JSON.parse(readFileSync(f.ledgerPath));
    assert.ok(!ledger.seen.includes('session-kickoff.md'));
    assert.ok(ledger.pending.includes('session-kickoff.md'));
    assert.ok(f.notifications.some(({ message }) => /will retry.*session-kickoff.md/.test(message)));
    const next = await fixture(t, { compiled, defaults: true, home: f.home });
    assert.ok(existsSync(join(next.snippetsDir, 'session-kickoff.md')));
    assert.ok(JSON.parse(readFileSync(next.ledgerPath)).seen.includes('session-kickoff.md'));
    rmSync(join(next.snippetsDir, 'session-kickoff.md'));
    await next.emit('session_start', { reason: 'reload' });
    assert.equal(existsSync(join(next.snippetsDir, 'session-kickoff.md')), false);
  });

  test(`${label}: failed ledger persistence prevents seed mutation but existing snippets work`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true, prepare({ snippetsDir, ledgerPath }) {
      writeFileSync(join(snippetsDir, 'custom.md'), '---\npersistent: true\n---\nEXISTING');
      mkdirSync(ledgerPath); // unreadable ledger and cannot atomically replace a directory
    } });
    assert.deepEqual(readdirSync(f.snippetsDir), ['custom.md']);
    assert.ok(f.notifications.some(({ message }) => /Could not seed default snippets/.test(message)));
    assert.equal((await f.input()).text, 'hello\n\nEXISTING');
  });

  for (const mode of ['print', 'json']) {
    test(`${label} ${mode}: plain restore refuses; --yes restores without UI`, async (t) => {
      const f = await fixture(t, { compiled, defaults: true, mode });
      rmSync(join(f.snippetsDir, 'session-kickoff.md'));
      const before = snapshot(f);
      const ledger = readFileSync(f.ledgerPath, 'utf8');
      const overrides = { confirm: () => assert.fail('no UI must not prompt') };
      await f.command('restore', overrides);
      assert.deepEqual(snapshot(f), before);
      assert.equal(readFileSync(f.ledgerPath, 'utf8'), ledger);
      await f.command('restore --yes', overrides);
      assert.ok(existsSync(join(f.snippetsDir, 'session-kickoff.md')));
    });
  }

  test(`${label}: RPC confirmation, cancel and unknown args are non-destructive`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true, mode: 'rpc' });
    writeFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'CUSTOM EDIT');
    rmSync(join(f.snippetsDir, 'ask-questions.md'));
    const before = snapshot(f);
    const ledger = readFileSync(f.ledgerPath, 'utf8');
    const config = readFileSync(f.configPath, 'utf8');
    let asked = 0;
    await f.command('restore', { confirm: async (_title, text) => { asked++; assert.match(text, /overwrite custom edits/); return false; } });
    assert.equal(asked, 1);
    for (const args of ['restore --bogus --yes', 'restor --yes', '--yes']) await f.command(args);
    assert.deepEqual(snapshot(f), before);
    assert.equal(readFileSync(f.ledgerPath, 'utf8'), ledger);
    assert.equal(readFileSync(f.configPath, 'utf8'), config);
    await f.command('restore', { confirm: async () => true });
    assert.match(readFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'utf8'), /name: Session kickoff/);
  });

  for (const visibility of ['visible', 'hidden']) {
    test(`${label} ${visibility}: restore retains saved modes and runtime one-shots, not consumed or missing activation`, async (t) => {
      const f = await fixture(t, { compiled, defaults: true, visibility });
      // Turn the first default persistent, consume it, then restore its edited body.
      await f.menu([' ', ' ', '\u001b']);
      assert.match(readFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'utf8'), /persistent: true/);
      const initialInput = await f.input('already sent');
      const sent = user(initialInput?.text ?? 'already sent');
      await f.record(sent);
      const oldEntries = structuredClone(f.entries);
      await f.command('restore --yes');
      assert.match(readFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'utf8'), /persistent: true/);
      assert.equal(f.widget, undefined);
      assert.equal(await f.input('not rearmed'), undefined);
      // Add an existing temporary selection; changing its body must not clear it.
      await f.menu([' ', ' ', '\u001b']);
      const priorWidget = f.widget;
      rmSync(join(f.snippetsDir, 'ask-questions.md'));
      await f.command('restore --yes');
      assert.deepEqual(f.widget, priorWidget);
      assert.doesNotMatch(readFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'utf8'), /persistent: true/);
      assert.deepEqual(f.entries, oldEntries, 'restore must never rewrite sent messages');
      const input = await f.input('selected');
      const recorded = await f.record(user(input?.text ?? 'selected'));
      const text = recorded?.message.content ?? input?.text;
      const shippedBody = readFileSync(join(root, 'snippets', 'session-kickoff.md'), 'utf8').split(/\r?\n---\r?\n/)[1].trim();
      assert.equal(text, `${shippedBody}\n\nselected`, 'only the existing temporary selection applies');
      assert.equal(f.widget, undefined);
      assert.equal(await f.input('after'), undefined);
      assert.equal(await f.record(user('after')), undefined);
    });
  }

  for (const visibility of ['visible', 'hidden']) {
    test(`${label} ${visibility}: missing automatic default is not reactivated by restore in unused session`, async (t) => {
      const f = await fixture(t, { compiled, defaults: true, visibility, prepare({ snippetsDir }) {
        writeFileSync(join(snippetsDir, 'session-kickoff.md'), '---\nplacement: prepend\npersistent: true\n---\nAUTO BEFORE DELETION');
        writeFileSync(join(snippetsDir, 'ask-questions.md'), '---\npersistent: true\n---\nEXISTING AUTO');
      } });
      assert.ok(f.widget.some((line) => line.includes('session-kickoff')));
      rmSync(join(f.snippetsDir, 'session-kickoff.md'));
      await f.command('restore --yes');
      assert.ok(existsSync(join(f.snippetsDir, 'session-kickoff.md')));
      assert.ok(f.widget.every((line) => !line.includes('Session kickoff')));
      const input = await f.input('first message');
      const recorded = await f.record(user(input?.text ?? 'first message'));
      const body = readFileSync(join(root, 'snippets', 'ask-questions.md'), 'utf8').split(/\r?\n---\r?\n/)[1].trim();
      assert.equal(recorded?.message.content ?? input?.text, `first message\n\n${body}`, 'only the existing valid automatic selection is retained');
    });
  }

  test(`${label}: restore preserves saved mode even if custom body was emptied`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });
    writeFileSync(join(f.snippetsDir, 'session-kickoff.md'), '---\npersistent: true\n---\n');
    await f.command('restore --yes');
    assert.match(readFileSync(join(f.snippetsDir, 'session-kickoff.md'), 'utf8'), /persistent: true/);
  });

  test(`${label}: partial restore reports file error, keeps successes and reloads actual content`, async (t) => {
    const f = await fixture(t, { compiled, defaults: true });
    rmSync(join(f.snippetsDir, 'session-kickoff.md'));
    mkdirSync(join(f.snippetsDir, 'session-kickoff.md'));
    writeFileSync(join(f.snippetsDir, 'ask-questions.md'), '---\nname: EDITED\n---\nEDITED BODY');
    writeFileSync(join(f.snippetsDir, 'old-bundle.md'), 'OLD FILE');
    let notification;
    await f.command('restore --yes', { notify: (message, level) => { notification = { message, level }; } });
    assert.equal(notification.level, 'warning');
    assert.match(notification.message, /Restored 5 snippets, 1 failed: session-kickoff.md:/);
    assert.match(readFileSync(join(f.snippetsDir, 'ask-questions.md'), 'utf8'), /name: Ask questions/);
    assert.equal(readFileSync(join(f.snippetsDir, 'old-bundle.md'), 'utf8'), 'OLD FILE');
    await f.menu([(rows) => { assert.ok(rows.join('\n').includes('Ask questions')); assert.ok(!rows.join('\n').includes('EDITED')); }, '\u001b']);
  });

  test(`${label}: native completion replaces full argument text and rejects unrelated tokens`, async (t) => {
    const f = await fixture(t, { compiled });
    const { CombinedAutocompleteProvider } = await import('@earendil-works/pi-tui');
    const provider = new CombinedAutocompleteProvider([{ name: 'snippets', getArgumentCompletions: f.getCompletions }], root);
    for (const [line, expectedValues] of [
      ['/snippets ', ['settings', 'restore']],
      ['/snippets set', ['settings']],
      ['/snippets settings', ['settings']],
      ['/snippets res', ['restore']],
      ['/snippets restore ', ['restore --yes']],
      ['/snippets restore --y', ['restore --yes']],
      ['/snippets restore   --y', ['restore --yes']],
    ]) {
      const suggestions = await provider.getSuggestions([line], 0, line.length, {});
      assert.deepEqual(suggestions.items.map(({ value }) => value), expectedValues);
      for (const item of suggestions.items) {
        const applied = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
        assert.equal(applied.lines[0].trimEnd(), `/snippets ${item.value}`);
      }
    }
    for (const value of ['settings ', 'settings --yes', 'settingx', 'restorex ', 'restore --no', 'restore --yes extra', 'res ']) assert.equal(f.getCompletions(value), null);
  });
}

test('package manifest exposes a shipped source entry and declares replacement API minimum', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.pi.extensions, ['./pi-extension/prompt-snippets/index.ts']);
  assert.ok(pkg.files.includes('pi-extension'));
  assert.ok(pkg.files.includes('snippets'));
  assert.equal(pkg.peerDependencies['@earendil-works/pi-coding-agent'], '>=1.5.0');
});
