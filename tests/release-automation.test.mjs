import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { prepBranch } from '../scripts/release-policy.mjs';
const script = pathToFileURL(resolve('scripts/release-automation.mjs')).href;
const repo = 'IvanNovR/pi-prompt-snippets';
const prep = { number: 1, state: 'closed', merged: true, merged_at: 'date', merge_commit_sha: 'prepared', user: { login: 'github-actions[bot]' }, base: { ref: 'dev', sha: 'base' }, head: { ref: prepBranch, sha: 'prep-head', repo: { full_name: repo } }, labels: [{ name: 'autorelease: pending' }] };
const promotion = { number: 2, state: 'closed', merged: true, merged_at: 'date', merge_commit_sha: 'promotion', title: 'chore: release 1.2.0', base: { ref: 'main', sha: 'main-parent' }, head: { ref: 'dev', sha: 'prepared', repo: { full_name: repo } }, labels: [] };
function run(operation, changes = {}) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import cp from 'node:child_process';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const c = ${JSON.stringify(changes)};
    const prep = ${JSON.stringify(prep)};
    const promotion = ${JSON.stringify(promotion)};
    if (c.prep) Object.assign(prep, c.prep);
    if (c.promotion) Object.assign(promotion, c.promotion);
    const calls = [], outputs = [];
    cp.execFileSync = (cmd, args) => {
      if (cmd !== 'git') throw new Error('Unexpected executable');
      if (args[0] === 'merge-base') { if (c.notAncestor) throw new Error('not ancestor'); return ''; }
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return c.main || 'promotion';
      if (args[0] === 'rev-parse') return c.treeMismatch && args[1].startsWith('promotion') ? 'other-tree' : 'tree';
      if (args[2] === '--format=%P') return c.parents || 'main-parent prepared';
      if (args[2] === '--format=%s') return c.subject || 'chore: release 1.2.0';
      if (args[1]?.endsWith(':package.json')) return JSON.stringify({ name: '@ivannovr/pi-prompt-snippets', version: '1.2.0' });
      if (args[1]?.endsWith(':package-lock.json')) return JSON.stringify({ version: '1.2.0', packages: { '': { version: '1.2.0' } } });
      if (args[1]?.endsWith(':.release-please-manifest.json')) return JSON.stringify({ '.': '1.2.0' });
      if (args[1]?.endsWith(':CHANGELOG.md')) return '## 1.2.0 (2026-01-01)\\nnotes';
      throw new Error('Unexpected git ' + args);
    };
    fs.appendFileSync = (path, value) => outputs.push(value.trim());
    syncBuiltinESMExports();
    globalThis.fetch = async (url, options) => {
      const path = url.split('/repos/${repo}/')[1];
      const method = options.method;
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method, body });
      if (c.http && path === c.http.path) return new Response('{}', { status: c.http.status });
      let data;
      if (path.startsWith('pulls?')) data = [prep, promotion, ...(c.extra || [])];
      else if (path === 'pulls/1') data = prep;
      else if (path === 'pulls/2') data = promotion;
      else if (path === 'git/ref/heads/dev') data = { object: { sha: c.dev || 'prepared' } };
      else if (path === 'git/ref/tags/v1.2.0') data = c.tag;
      else if (path === 'git/tags/annotation') data = { object: { type: 'commit', sha: c.annotatedTarget || 'promotion' } };
      else if (path === 'releases/tags/v1.2.0') data = c.release;
      else if (path === 'releases') data = body;
      else if (path === 'pulls' && method === 'POST') data = { number: 3, user: { login: 'github-actions[bot]' }, base: { ref: 'dev' }, head: { ref: 'main', sha: 'promotion', repo: { full_name: '${repo}' } } };
      else data = {};
      if (data === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(data), { status: 200 });
    };
    Object.assign(process.env, { GITHUB_REPOSITORY: '${repo}', GITHUB_OUTPUT: 'output', GH_TOKEN: 'not-real', PR_NUMBER: '2', EXPECTED_SHA: 'prepared', EVENT_NAME: 'pull_request', WORKFLOW_REF: 'refs/heads/main', ...(c.env || {}) });
    process.argv[2] = ${JSON.stringify(operation)};
    let error;
    try { await import(${JSON.stringify(script)}); } catch (e) { error = e.message; }
    process.stdout.write(JSON.stringify({ calls, outputs, error }));
  `], { encoding: 'utf8' }));
}
const existing = { tag: { object: { type: 'commit', sha: 'promotion' } }, release: { tag_name: 'v1.2.0', target_commitish: 'promotion', draft: false, prerelease: false } };
test('verified merged promotion creates exact tag and release notes', () => {
  const r = run('finalize'); assert.equal(r.error, undefined);
  assert.deepEqual(r.calls.find(c => c.path === 'git/refs').body, { ref: 'refs/tags/v1.2.0', sha: 'promotion' });
  assert.equal(r.calls.find(c => c.path === 'releases').body.body, '## 1.2.0 (2026-01-01)\nnotes');
});
for (const changes of [{ main: 'drift' }, { dev: 'drift' }, { parents: 'prepared' }, { treeMismatch: true }, { subject: 'Merge pull request #2' }, { prep: { user: { login: 'human' } } }, { tag: { object: { type: 'commit', sha: 'wrong' } } }, { ...existing, release: { ...existing.release, target_commitish: 'main' } }]) {
  test(`reject promotion or retry drift ${JSON.stringify(changes)}`, () => {
    const r = run('finalize', changes); assert(r.error); assert(!r.calls.some(c => c.path === 'git/refs' && c.method === 'POST'));
  });
}
test('annotated and lightweight tags must peel to exact promotion', () => {
  assert.equal(run('finalize', existing).error, undefined);
  assert.equal(run('finalize', { ...existing, tag: { object: { type: 'tag', sha: 'annotation' } } }).error, undefined);
  assert(run('finalize', { ...existing, tag: { object: { type: 'tag', sha: 'annotation' } }, annotatedTarget: 'wrong' }).error);
});
test('retry never invents missing tag or release', () => {
  const env = { OPERATION: 'retry', RELEASE_TAG: 'v1.2.0' };
  assert(run('finalize', { env, release: existing.release }).error);
  assert(run('finalize', { env, tag: existing.tag }).error);
  assert.equal(run('finalize', { env, ...existing }).error, undefined);
});
test('pending preparation freezes dev and preparation, promotion requires exact prepared head', () => {
  assert(run('ci', { promotion: { state: 'open', head: { ref: 'feat/work', sha: 'prepared', repo: { full_name: repo } }, base: { ref: 'dev', sha: 'base' } } }).error);
  assert(run('prepare').outputs.includes('ready=false'));
  assert.equal(run('ci', { promotion: { state: 'open' } }).error, undefined);
  assert(run('ci', { promotion: { state: 'open', head: { ref: 'dev', sha: 'drift', repo: { full_name: repo } } }, env: { EXPECTED_SHA: 'drift' } }).error);
});
test('successful completion consumes exact prep and dispatches reverse sync on main', () => {
  const r = run('complete', existing); assert.equal(r.error, undefined);
  assert(r.calls.some(c => c.path === 'issues/1/labels' && c.body.labels[0] === 'autorelease: tagged'));
  assert(r.calls.some(c => c.method === 'DELETE' && c.path.includes('autorelease%3A%20pending')));
  const dispatch = r.calls.find(c => c.path.includes('dispatches'));
  assert.equal(dispatch.body.ref, 'main'); assert.equal(dispatch.body.inputs.expected_sha, 'promotion');
});
test('API errors are fatal and never convert into missing state', () => {
  for (const status of [401, 403, 429, 500]) assert.match(run('finalize', { http: { path: 'git/ref/tags/v1.2.0', status } }).error, new RegExp('HTTP ' + status));
});
test('next preparation blocked until exact release tag is ancestor of dev', () => {
  const completed = { prep: { labels: [{ name: 'autorelease: tagged' }] } };
  assert.equal(run('prepare', completed).error, undefined);
  assert(run('prepare', { ...completed, notAncestor: true }).error);
});
