import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conclusion, reportChecks } from '../scripts/report-checks.mjs';
import { prepBranch } from '../scripts/release-policy.mjs';
const repository = 'IvanNovR/pi-prompt-snippets';
const expectedSha = 'a'.repeat(40);
const context = () => ({ repository, prNumber: '3', expectedSha, event: 'workflow_dispatch', ref: 'refs/heads/main', runId: '100', results: Object.fromEntries(['source', 'branch-policy', 'commits', 'package'].map(n => [n, { result: 'success' }])) });
const pr = () => ({ state: 'open', user: { login: 'github-actions[bot]' }, base: { ref: 'dev' }, head: { ref: prepBranch, sha: expectedSha, repo: { full_name: repository } } });
function fixture(mutate = () => {}) {
  const calls = [];
  let reads = 0;
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (method === 'GET') { const p = pr(); mutate(p, ++reads); return p; }
    return {};
  };
  return { calls, api };
}
test('trusted reporter writes all fixed required names at exact PR head, not workflow main SHA', async () => {
  const f = fixture(); await reportChecks(context(), f.api);
  const writes = f.calls.filter(c => c.method === 'POST');
  assert.deepEqual(writes.map(c => c.body.name), ['source', 'branch-policy', 'commits', 'package']);
  for (const { path, body } of writes) {
    assert.equal(path, 'check-runs'); assert.equal(body.head_sha, expectedSha);
    assert.equal(body.status, 'completed'); assert.equal(body.conclusion, 'success');
    assert.equal(body.details_url, `https://github.com/${repository}/actions/runs/100`);
  }
  assert.equal(f.calls.filter(c => c.method === 'GET').length, 5);
});
test('every non-success job result blocks and skipped or missing results never pass', async () => {
  assert.equal(conclusion('success'), 'success');
  for (const r of ['failure', 'skipped', 'unknown', undefined]) assert.equal(conclusion(r), 'failure');
  assert.equal(conclusion('cancelled'), 'cancelled');
  const c = context(); c.results.commits.result = 'cancelled'; delete c.results.package;
  const f = fixture(); await reportChecks(c, f.api);
  assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.body.conclusion), ['success', 'success', 'cancelled', 'failure']);
});
test('source failure forces all dependent head checks to failure', async () => {
  const c = context(); c.results.source.result = 'failure';
  const f = fixture(); await reportChecks(c, f.api);
  assert(f.calls.filter(c => c.method === 'POST').every(c => c.body.conclusion === 'failure'));
});
test('moved, closed, forked, human or nonsensical PRs get no passing head checks', async () => {
  for (const mutate of [p => { p.state = 'closed'; }, p => { p.head.sha = 'b'.repeat(40); }, p => { p.head.repo.full_name = 'attacker/repo'; }, p => { p.user.login = 'human'; }, p => { p.base.ref = 'other'; }]) {
    const f = fixture(mutate); await assert.rejects(reportChecks(context(), f.api));
    assert(!f.calls.some(c => c.method === 'POST'));
  }
});
test('head is revalidated before each write, never transferring stale pass to new SHA', async () => {
  const f = fixture((p, count) => { if (count === 3) p.head.sha = 'b'.repeat(40); });
  await assert.rejects(reportChecks(context(), f.api));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal(f.calls.find(c => c.method === 'POST').body.head_sha, expectedSha);
});
test('only main workflow dispatch may report and untrusted inputs cannot inject check fields', async () => {
  for (const patch of [{ event: 'pull_request' }, { ref: 'refs/heads/dev' }, { prNumber: '3\nfoo' }, { expectedSha: 'main' }, { runId: 'x' }]) {
    const f = fixture(); await assert.rejects(reportChecks({ ...context(), ...patch }, f.api));
    assert.equal(f.calls.length, 0);
  }
});
test('read/write API errors remain fatal, no success fallback', async () => {
  await assert.rejects(reportChecks(context(), async () => { throw new Error('HTTP 403'); }), /HTTP 403/);
  const f = fixture();
  await assert.rejects(reportChecks(context(), async (...args) => {
    if (args[1] === 'POST') throw new Error('HTTP 500');
    return f.api(...args);
  }), /HTTP 500/);
});
