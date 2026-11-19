// Capture-only adapter: the unmodified extension module tree receives the actual Pi API.
// No application source changes; only its node:fs import is replaced in a VM.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';
import * as tui from '@earendil-works/pi-tui';
import * as settings from '@aliou/pi-utils-settings';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.env.CAPTURE_RUN_DIR;
assert.ok(out && path.dirname(out) === path.join(root, 'docs/assets/capture-output'));
const snippetDir = path.join(os.homedir(), '.pi/agent/snippets'); // Compared only, NEVER opened.
const configPath = path.join(os.homedir(), '.pi/agent/prompt-snippets-config.json');
const ledgerPath = path.join(os.homedir(), '.pi/agent/prompt-snippets-defaults-ledger.json');
const sourceDir = path.join(root, 'pi-extension/prompt-snippets');
const sourceNames = ['index', 'snippets', 'defaults', 'state', 'settings', 'menu'];
const bundledDir = path.join(root, 'snippets');
const fixtures = new Map(fs.readdirSync(bundledDir).filter(f => f.endsWith('.md'))
  .map(f => [f, fs.readFileSync(path.join(bundledDir, f), 'utf8')]));
const initial = new Map(fixtures);
let config = JSON.stringify({ visibility: 'visible' });
const audit = [];
const key = p => {
  assert.equal(path.dirname(String(p)), snippetDir, `Denied extension filesystem access: ${p}`);
  assert.ok(fixtures.has(path.basename(String(p))), `Unknown snippet: ${p}`);
  return path.basename(String(p));
};
const adapter = {
  constants: fs.constants,
  existsSync(p) { audit.push(['exists', p === ledgerPath ? 'ledger' : p === configPath ? 'visibility' : p === path.dirname(configPath) ? 'visibility-parent-metadata-only' : p === snippetDir ? 'snippets' : p === bundledDir ? 'bundled' : key(p)]); return true; },
  readdirSync(p, options) { assert.ok(p === snippetDir || p === bundledDir); return [...fixtures.keys()].map(name => options?.withFileTypes ? { name, isFile: () => true } : name); },
  readFileSync(p) { return p === ledgerPath ? JSON.stringify({ seen: [...initial.keys()], pending: [] }) : p === configPath ? config : fixtures.get(key(p)); },
  renameSync() { throw new Error('Capture ledger is already complete; no persistence expected'); },
  writeFileSync(p, value) { if (p === configPath) { config = String(value); audit.push(['write', 'visibility', JSON.parse(config)]); } else { fixtures.set(key(p), String(value)); audit.push(['write', key(p)]); } },
  mkdirSync(p) { assert.equal(p, snippetDir); },
  copyFileSync() { throw new Error('All bundled snippets must already exist in memory'); },
};
export default async function capture(pi) {
  const modules = new Map();
  const loadSource = filename => {
    assert.ok(sourceNames.some(name => filename === path.join(sourceDir, `${name}.ts`)), `Unexpected source: ${filename}`);
    if (!modules.has(filename)) {
      const source = fs.readFileSync(filename, 'utf8');
      const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      modules.set(filename, new vm.SourceTextModule(code, { identifier: filename, initializeImportMeta(meta) { meta.url = pathToFileURL(filename).href; } }));
    }
    return modules.get(filename);
  };
  const module = loadSource(path.join(sourceDir, 'index.ts'));
  const imports = { 'node:fs': adapter, 'node:os': os, 'node:path': path, 'node:url': { fileURLToPath }, '@earendil-works/pi-tui': tui, '@aliou/pi-utils-settings': settings };
  await module.link((specifier, referencing) => {
    if (specifier.startsWith('./')) return loadSource(path.resolve(path.dirname(referencing.identifier), specifier.replace(/\.js$/, '.ts')));
    const values = imports[specifier]; assert.ok(values, `Unexpected import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); });
  });
  await module.evaluate();
  module.namespace.default(pi);
  pi.registerProvider('capture-offline', {
    name: 'Capture offline', baseUrl: 'http://invalid.invalid', apiKey: 'capture-only-not-a-secret', api: 'capture-empty',
    models: [{ id: 'GPT-Ivan', name: 'GPT-Ivan', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const payload = await options?.onPayload?.({ messages: context.messages }, model) ?? { messages: context.messages };
        fs.writeFileSync(path.join(out, 'request.json'), JSON.stringify(payload, null, 2));
        const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: { ...message, stopReason: 'pending' } });
        stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      });
      return stream;
    },
  });
  pi.on('agent_settled', (_event, ctx) => {
    assert.deepEqual(fixtures, initial, 'Temporary selection must not change snippet files');
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ visibility: JSON.parse(config).visibility, unchangedSnippetFixtures: true, fsAudit: audit, entries: ctx.sessionManager.getEntries() }, null, 2));
  });
}
