// Run from the repository root: node --experimental-vm-modules docs/assets/capture.mjs
// Executes unmodified index.ts with an in-memory snippet filesystem and mocked host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as url from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import * as tui from '@earendil-works/pi-tui';
import { loadThemeFromPath } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'docs/assets/capture-output');
fs.mkdirSync(out, { recursive: true });
const snippetDir = path.join(os.homedir(), '.pi/agent/snippets'); // Compared only; never accessed.
const bundledDir = path.join(root, 'snippets');
const fixtures = new Map(fs.readdirSync(bundledDir).filter(f => f.endsWith('.md'))
  .map(f => [f, fs.readFileSync(path.join(bundledDir, f), 'utf8')]));
const key = p => {
  assert.equal(path.dirname(String(p)), snippetDir, `Denied extension filesystem access: ${p}`);
  return path.basename(String(p));
};
const mockFs = {
  existsSync(p) { if (p === snippetDir || p === bundledDir) return true; return fixtures.has(key(p)); },
  readdirSync(p) { assert.ok(p === snippetDir || p === bundledDir); return [...fixtures.keys()]; },
  readFileSync(p) { const value = fixtures.get(key(p)); assert.notEqual(value, undefined); return value; },
  writeFileSync(p, value) { fixtures.set(key(p), value); },
  mkdirSync(p) { assert.equal(p, snippetDir); },
  copyFileSync() { throw new Error('Unexpected default copy: fixtures already include all bundled snippets'); },
};
const theme = loadThemeFromPath(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json'), 'truecolor');
const source = fs.readFileSync(path.join(root, 'index.ts'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const module = new vm.SourceTextModule(code, {
  identifier: path.join(root, 'index.ts'),
  initializeImportMeta(meta) { meta.url = url.pathToFileURL(path.join(root, 'index.ts')).href; },
});
const imports = { 'node:fs': mockFs, 'node:os': os, 'node:path': path, 'node:url': url, '@earendil-works/pi-tui': tui };
await module.link(specifier => {
  const values = imports[specifier];
  assert.ok(values, `Unexpected import: ${specifier}`);
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  });
});
await module.evaluate();
const events = new Map();
const commands = new Map();
let component;
let finish;
let widget = [];
const ctx = {
  hasUI: true, mode: 'tui',
  sessionManager: { getBranch: () => [], getEntries: () => [], getSessionFile: () => undefined },
  ui: {
    theme,
    notify(message) { throw new Error(message); },
    setWidget(_id, lines) { widget = lines ?? []; },
    custom(factory) {
      return new Promise(resolve => {
        finish = resolve;
        component = factory({ terminal: { rows: 28 }, requestRender() {} }, theme, {}, resolve);
      });
    },
  },
};
module.namespace.default({
  on(name, handler) { events.set(name, handler); },
  registerCommand(name, command) { commands.set(name, command); },
  registerShortcut() {},
});
await events.get('session_start')({ reason: 'startup' }, ctx);
const pending = commands.get('snippets').handler('', ctx);
const frames = [];
function capture(name, label, lines = component.render(100)) {
  assert.ok(lines.length);
  frames.push({ name, label, lines });
}
capture('01-menu', 'Open /snippets');
component.handleInput(' ');
capture('02-temporary', 'Space: temporary selection');
component.handleInput(' ');
capture('03-persistent', 'Space again: persistent selection');
component.handleInput('\x1b[B'); // Orchestrator mode
component.handleInput('\x1b[B'); // Ask questions
component.handleInput(' ');
capture('04-selection', 'Combine prepend and append snippets');
component.handleInput('\t');
capture('05-preview', 'Tab: preview the selected snippet');
component.handleInput('\t');
component.handleInput('\r');
await pending;
assert.equal(widget.length, 2);
capture('06-widget', 'Enter: active-snippet widget', new tui.Text(widget.join('\n'), 0, 0).render(100));
assert.match(fixtures.get('session-kickoff.md'), /persistent: true/);

const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
// Strict SGR converter: fail rather than silently drop unsupported terminal controls.
function ansiHtml(text) {
  let result = '', position = 0, color = '', bold = false;
  const emit = value => {
    if (!value) return;
    result += `<span style="${color ? `color:${color};` : ''}${bold ? 'font-weight:700;' : ''}">${escape(value)}</span>`;
  };
  for (const match of text.matchAll(/\x1b\[([\d;]*)m/g)) {
    emit(text.slice(position, match.index));
    const codes = match[1] ? match[1].split(';').map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { color = ''; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) color = '';
      else if (c === 38 && codes[i + 1] === 2) { color = `rgb(${codes.slice(i + 2, i + 5).join(',')})`; i += 4; }
      else throw new Error(`Unsupported SGR ${match[0]}`);
    }
    position = match.index + match[0].length;
  }
  emit(text.slice(position));
  assert.ok(!result.includes('\x1b'), 'Unconverted terminal escape');
  return result;
}
for (const frame of frames) {
  fs.writeFileSync(path.join(out, `${frame.name}.ansi`), frame.lines.join('\n') + '\n');
  fs.writeFileSync(path.join(out, `${frame.name}.html`), `<!doctype html><meta charset="utf-8"><style>
    * { box-sizing:border-box } body { margin:0; padding:28px; background:#15171c; color:#dedede; }
    header { font:14px system-ui; color:#9199aa; margin-bottom:24px; }
    pre { margin:0; font:16px/25px 'SFMono-Regular',Menlo,monospace; white-space:pre; font-variant-ligatures:none; }
    </style><header>Fixture-rendered extension UI · ${escape(frame.label)}</header><pre>${ansiHtml(frame.lines.join('\n'))}</pre>`);
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({
  sourceSha256: (await import('node:crypto')).createHash('sha256').update(source).digest('hex'),
  piVersion: JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@earendil-works/pi-coding-agent/package.json'))).version,
  frames: frames.map(({ name, label }) => ({ name, label })),
}, null, 2) + '\n');
console.log(`Captured ${frames.length} actual extension component frames in ${out}`);
