import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'pi-snippets-pack-'));
const npm = (...args) => execFileSync('npm', args, { cwd: root, encoding: 'utf8' });
try {
  npm('run', 'build');
  const [pack] = JSON.parse(npm('pack', '--json', '--pack-destination', temp));
  const files = pack.files.map(({ path }) => path);
  for (const path of ['index.ts', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE', 'CHANGELOG.md', 'package.json', 'docs/assets/menu.png', 'docs/assets/demo.gif', 'snippets/session-kickoff.md']) {
    assert.ok(files.includes(path), `Missing tarball file: ${path}`);
  }
  for (const path of files) {
    assert.match(path, /^(?:package\.json|README\.md|LICENSE|CHANGELOG\.md|index\.ts|dist\/index\.(?:js|js\.map|d\.ts|d\.ts\.map)|snippets\/[^/]+\.md|docs\/assets\/[^/]+\.(?:png|gif))$/, `Unexpected tarball file: ${path}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  assert.equal(pkg.name, '@ivannovr/pi-prompt-snippets');
  assert.ok(pkg.keywords.includes('pi-package'));
  assert.equal(pkg.publishConfig?.registry, undefined, 'Registry must remain selectable');
  const image = new URL(pkg.pi.image);
  assert.equal(image.origin, 'https://raw.githubusercontent.com');
  assert.equal(image.pathname, '/IvanNovR/pi-prompt-snippets/main/docs/assets/menu.png');
  assert.ok(files.includes('docs/assets/menu.png'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  const installed = join(temp, 'installed');
  mkdirSync(installed);
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--package-lock=false', join(temp, pack.filename)], { cwd: installed, stdio: 'inherit' });
  // Pi provides this peer at runtime. Use the locked local host copy, not a registry install.
  const scope = join(installed, 'node_modules', '@earendil-works');
  mkdirSync(scope, { recursive: true });
  symlinkSync(join(root, 'node_modules', '@earendil-works', 'pi-tui'), join(scope, 'pi-tui'), 'dir');
  // Use Pi's locked Jiti dependency for TypeScript in node_modules; native
  // Node type stripping intentionally refuses installed TypeScript packages.
  const hostRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const jitiURL = pathToFileURL(hostRequire.resolve('jiti')).href;
  for (const entry of ['index.ts', 'dist/index.js']) {
    const fixtureHome = join(temp, entry === 'index.ts' ? 'source-fixture' : 'compiled-fixture');
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { existsSync, readdirSync } from 'node:fs';
      import { join } from 'node:path';
      import os from 'node:os';
      import { syncBuiltinESMExports } from 'node:module';
      // Test injection only: leave HOME, XDG and npm/cache configuration intact.
      os.homedir = () => ${JSON.stringify(fixtureHome)};
      syncBuiltinESMExports();
      const entryURL = ${JSON.stringify(pathToFileURL(join(installed, 'node_modules', '@ivannovr', 'pi-prompt-snippets', entry)).href)};
      const extension = ${entry === 'index.ts' ? `await (await import(${JSON.stringify(jitiURL)})).createJiti(import.meta.url, { tryNative: false, moduleCache: false, fsCache: false }).import(entryURL, { default: true })` : '(await import(entryURL)).default'};
      const handlers = new Map();
      extension({ on: (name, fn) => handlers.set(name, fn), registerShortcut() {}, registerCommand() {} });
      assert.ok(handlers.has('session_start'));
      await handlers.get('session_start')({}, { hasUI: false, mode: 'json', sessionManager: { getEntries: () => [] } });
      const snippets = join(${JSON.stringify(fixtureHome)}, '.pi', 'agent', 'snippets');
      assert.ok(existsSync(join(snippets, 'session-kickoff.md')));
      assert.equal(readdirSync(snippets).filter(name => name.endsWith('.md')).length, 6);
    `], { cwd: installed, stdio: 'inherit' });
  }
  console.log(`Tarball allowlist, manifest, offline installation, source/compiled registration and bundled snippet smoke passed (${files.length} files).`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
