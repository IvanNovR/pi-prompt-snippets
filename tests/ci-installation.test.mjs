import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = process.cwd();
const workflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
// Exercise the actual source step, not a second implementation of its resolver.
const source = workflow.split('          export TRUSTED_MAIN_SHA=')[1].split('\n\n  branch-policy:')[0];
const shell = 'set -euo pipefail\nexport TRUSTED_MAIN_SHA=' + source.replace(/^          /gm, '');
const repo = 'IvanNovR/pi-prompt-snippets';
function run(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-installation-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (file, data) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), data); };
  const version = (value, metadata = 'old') => {
    write('package.json', JSON.stringify({ name: '@ivannovr/pi-prompt-snippets', version: value, description: metadata }));
    write('package-lock.json', JSON.stringify({ version: value, packages: { '': { version: options.badLock && metadata === 'new' ? '1.2.0' : value } } }));
    write('.release-please-manifest.json', JSON.stringify({ '.': value }));
    write('CHANGELOG.md', `## ${value} (2026-01-01)\nnotes\n`);
  };
  const helpers = () => {
    for (const name of ['release-automation.mjs', 'release-policy.mjs']) write(`scripts/${name}`, fs.readFileSync(path.join(root, 'scripts', name)));
  };
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'CI test'); git('config', 'user.email', 'ci@example.test');
    version('1.1.0');
    if (options.installed) helpers();
    if (options.partial) write(`scripts/${options.partial}`, fs.readFileSync(path.join(root, 'scripts', options.partial)));
    if (options.missingBase) fs.rmSync(path.join(dir, options.missingBase));
    git('add', '.'); git('commit', '-m', 'chore: baseline');
    const base = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', base);
    helpers(); version(options.version || '1.1.0', 'new');
    if (options.changelog) fs.appendFileSync(path.join(dir, 'CHANGELOG.md'), options.changelog);
    if (options.manifest) fs.appendFileSync(path.join(dir, '.release-please-manifest.json'), '\n');
    git('add', '.'); git('commit', '-m', 'ci: install pipeline');
    const head = options.unrelatedHead ? git('commit-tree', 'HEAD^{tree}', '-m', 'ci: unrelated installation') : git('rev-parse', 'HEAD');
    git('update-ref', 'refs/pull/6/head', options.fetchedMismatch ? base : head); git('remote', 'add', 'origin', dir);
    const pr = { number: 6, state: options.closed ? 'closed' : 'open', title: 'ci: install pipeline', labels: [], user: { login: options.bot ? 'github-actions[bot]' : 'maintainer' }, base: { ref: options.target || 'main', sha: options.baseMismatch ? head : base }, head: { ref: options.branch || 'dev', sha: options.stale ? base : head, repo: { full_name: options.fork ? 'outsider/fork' : repo } } };
    const preparations = options.pendingPreparation ? [{ number: 5, state: 'closed', merged_at: '2026-01-01T00:00:00Z', merged: true, merge_commit_sha: base, labels: [{ name: 'autorelease: pending' }], user: { login: 'github-actions[bot]' }, base: { ref: 'dev', sha: base }, head: { ref: 'release-please--branches--dev--components--pi-prompt-snippets', sha: base, repo: { full_name: repo } } }] : [];
    write('api.json', JSON.stringify({ pr, preparations }));
    write('mock.mjs', `import fs from 'node:fs';\nglobalThis.fetch = async url => { fs.appendFileSync(process.env.PR_FIXTURE + '.calls', url + '\\n'); const fixture = JSON.parse(fs.readFileSync(process.env.PR_FIXTURE)); return new Response(JSON.stringify(url.includes('pulls?') ? fixture.preparations : fixture.pr), { status: 200 }); };\n`);
    const trusted = options.branch === 'main' && options.installed && !options.syncMismatch ? head : base;
    git('update-ref', 'refs/remotes/origin/main', trusted);
    git('checkout', '--detach', trusted);
    const output = path.join(dir, 'output');
    const result = spawnSync('bash', ['-c', shell], { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(path.join(dir, 'mock.mjs')).href}`, PR_FIXTURE: path.join(dir, 'api.json'), GITHUB_REPOSITORY: repo, GH_TOKEN: 'read-only-test', GITHUB_OUTPUT: output, PR_NUMBER: options.number || '6', EXPECTED_SHA: options.expected || head, EVENT_NAME: options.dispatch ? 'workflow_dispatch' : 'pull_request', WORKFLOW_REF: options.dispatch ? 'refs/heads/main' : 'refs/pull/6/merge', RELEASE_AUTOMATION_READY: options.release ?? 'false', PUBLICATION_READY: options.publication ?? 'false' } });
    return { status: result.status, stderr: result.stderr, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '', apiCalls: fs.existsSync(path.join(dir, 'api.json.calls')) ? fs.readFileSync(path.join(dir, 'api.json.calls'), 'utf8') : '', head, base };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('old main installs via real read-only source checks at immutable event head with changed package metadata', () => {
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, `sha=${result.head}\nbase=${result.base}\ntitle="ci: install pipeline"\n`);
});
test('first work PR targeting dev also runs real checks before main installation', () => {
  const result = run({ target: 'dev', branch: 'feat/pipeline' }); assert.equal(result.status, 0, result.stderr);
});
for (const options of [
  { release: 'true' }, { publication: 'true' }, { release: '' }, { publication: '' },
  { version: '1.2.0' }, { version: '1.1.0-beta' }, { badLock: true },
  { changelog: '\n' }, { manifest: true }, { stale: true }, { closed: true },
  { fork: true }, { bot: true }, { expected: 'not-a-sha' }, { number: '../6' },
  { dispatch: true }, { target: 'other' },
]) test(`initial installation fails closed: ${JSON.stringify(options)}`, () => {
  const result = run(options); assert.notEqual(result.status, 0); assert.equal(result.output, '');
});
test('updated main never permits another nonrelease promotion even with both gates disabled', () => {
  const result = run({ installed: true }); assert.notEqual(result.status, 0); assert.match(result.stderr, /Promotion requires pending preparation/);
});
test('updated main runs ordinary work with no installation fallback even if automation enabled', () => {
  const result = run({ installed: true, target: 'dev', branch: 'feat/work', release: 'true', publication: 'true' }); assert.equal(result.status, 0, result.stderr);
});
test('first main to dev reverse sync needs no pending or tagged dev preparation', () => {
  const result = run({ installed: true, target: 'dev', branch: 'main' }); assert.equal(result.status, 0, result.stderr);
});
for (const [name, options, error] of [
  ['initial installation rejects an incomplete merged preparation', { pendingPreparation: true }, /Installation cannot overlap a release cycle/],
  ['initial reverse sync rejects an incomplete merged preparation', { installed: true, target: 'dev', branch: 'main', pendingPreparation: true }, /Publication incomplete, synchronization blocked/],
  ['initial installation rejects unrelated head ancestry', { unrelatedHead: true }, /merge-base --is-ancestor/],
  ['initial reverse sync rejects unrelated head ancestry', { installed: true, target: 'dev', branch: 'main', unrelatedHead: true }, /merge-base --is-ancestor/],
  ['initial installation rejects a base different from trusted main', { baseMismatch: true }, /Installation base differs from trusted main/],
  ['initial reverse sync rejects a head different from trusted main', { installed: true, target: 'dev', branch: 'main', syncMismatch: true }, /Synchronization head differs from trusted main/],
  ['initial installation rejects a fetched pull ref different from the event head', { fetchedMismatch: true }, /From /],
  ['initial installation rejects a policy-only partial installation', { partial: 'release-policy.mjs' }, /From /],
  ['initial installation rejects an automation-only partial installation', { partial: 'release-automation.mjs' }, /ERR_MODULE_NOT_FOUND/],
]) test(name, () => {
  const result = run(options);
  assert.notEqual(result.status, 0);
  assert.equal(result.output, '');
  assert.match(result.stderr, error);
  if (options.fetchedMismatch || options.partial) assert.equal(result.apiCalls, '', 'Source guard must reject before any GitHub API policy lookup');
});
for (const missingBase of ['package.json', 'package-lock.json', '.release-please-manifest.json', 'CHANGELOG.md']) {
  test(`initial installation rejects missing historical ${missingBase}`, () => {
    const result = run({ missingBase });
    assert.notEqual(result.status, 0);
    assert.equal(result.output, '');
    assert(result.stderr.includes(`Error: Command failed: git show ${result.base}:${missingBase}\n`), result.stderr);
    const missingPathErrors = [
      `fatal: path '${missingBase}' does not exist in '${result.base}'`,
      `fatal: path '${missingBase}' exists on disk, but not in '${result.base}'`,
    ];
    assert(result.stderr.split('\n').some(line => missingPathErrors.includes(line)), result.stderr);
  });
}
test('ordinary fork work targeting dev remains allowed during initial installation', () => {
  const result = run({ fork: true, target: 'dev', branch: 'feat/work' });
  assert.equal(result.status, 0, result.stderr);
});
test('ordinary fork work targeting dev remains allowed after installation', () => {
  const result = run({ installed: true, fork: true, target: 'dev', branch: 'feat/work' });
  assert.equal(result.status, 0, result.stderr);
});
