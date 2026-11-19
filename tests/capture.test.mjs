import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('capture adapter loads the modular source in its filesystem-isolated VM without regenerating media', (t) => {
  const parent = join(root, 'docs/assets/capture-output');
  mkdirSync(parent, { recursive: true });
  const out = mkdtempSync(join(parent, 'smoke-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createJiti } from 'jiti';
    const jiti = createJiti(import.meta.url, { esmResolve: true });
    const { initTheme } = await import('@earendil-works/pi-coding-agent');
    initTheme('dark', false);
    const capture = await jiti.import('./docs/assets/capture.mjs', { default: true });
    const handlers = new Map();
    let command;
    let widget;
    await capture({
      on(name, handler) { handlers.set(name, handler); },
      registerCommand(_name, options) { command = options.handler; },
      registerShortcut() {}, registerProvider() {},
    });
    const theme = { fg: (_color, text) => text, bold: text => text, colors: { accent: '#ffffff', foreground: '#ffffff', dim: '#666666', background: '#000000' }, appearance: 'dark' };
    const ctx = { mode: 'tui', hasUI: true, sessionManager: { getEntries: () => [] }, ui: {
      theme, setWidget(_id, value) { widget = value; },
      notify(message) { assert.fail(message); },
      async custom(factory) {
        let closed = false;
        const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, () => { closed = true; });
        for (const key of [' ', '\\u001b[B', ' ', '\\u001b[B', ' ', '\\u001b']) component.handleInput(key);
        assert.equal(closed, true);
      },
    } };
    await handlers.get('session_start')({}, ctx);
    await command('', ctx);
    assert.equal(widget.length, 2);
    const result = await handlers.get('input')({ text: 'capture smoke' }, ctx);
    assert.ok(result.text.includes('capture smoke'));
    assert.ok(result.text.includes('Familiarize yourself'));
    await handlers.get('agent_settled')({}, ctx);
  `], { cwd: root, env: { ...process.env, CAPTURE_RUN_DIR: out }, stdio: 'pipe' });
  const verification = JSON.parse(readFileSync(join(out, 'verification.json'), 'utf8'));
  assert.equal(verification.unchangedSnippetFixtures, true);
  assert.equal(verification.visibility, 'visible');
  assert.ok(verification.fsAudit.some(([action, target]) => action === 'exists' && target === 'ledger'));
});
