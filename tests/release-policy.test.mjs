import assert from 'node:assert/strict';
import { test } from 'node:test';
import { route, prepBranch, promotion, versionFiles, releaseIdentity } from '../scripts/release-policy.mjs';
const repo = 'IvanNovR/pi-prompt-snippets';
const pr = (head, base = 'dev', extra = {}) => ({ head: { ref: head, sha: 'prepared', repo: { full_name: repo } }, base: { ref: base, sha: 'previous-main' }, ...extra });
const prep = () => pr(prepBranch, 'dev', { merged: true, merge_commit_sha: 'prepared', user: { login: 'github-actions[bot]' }, labels: [{ name: 'autorelease: pending' }] });
const release = () => pr('dev', 'main', { merged: true, merge_commit_sha: 'promotion' });
test('branch routes permit working branches, trusted prep, literal promotion and reverse sync', () => {
  assert.equal(route(pr('feat/work'), repo), 'work');
  assert.equal(route(prep(), repo), 'preparation');
  assert.equal(route(release(), repo), 'promotion');
  assert.equal(route(pr('main'), repo), 'sync');
});
for (const [head, base] of [['feat/work', 'main'], [prepBranch, 'main'], ['dev', 'dev'], ['feat/work', 'other']]) {
  test(`reject invalid route ${head} -> ${base}`, () => assert.throws(() => route(pr(head, base), repo)));
}
test('fork cannot impersonate promotion, preparation or reverse sync', () => {
  for (const p of [prep(), release(), pr('main')]) {
    p.head.repo.full_name = 'attacker/repo';
    assert.throws(() => route(p, repo));
  }
  const forkWork = pr('feat/work'); forkWork.head.repo.full_name = 'contributor/repo';
  assert.equal(route(forkWork, repo), 'work');
});
test('promotion requires exact merged preparation, head and ordered two-parent merge', () => {
  const check = (r = release(), p = prep(), dev = 'prepared', parents = ['previous-main', 'prepared']) => promotion(r, p, repo, dev, parents);
  check();
  assert.throws(() => check(undefined, undefined, 'drift'));
  assert.throws(() => check(undefined, undefined, undefined, ['prepared']));
  assert.throws(() => check(undefined, undefined, undefined, ['prepared', 'previous-main']));
  for (const mutate of [p => { p.merged = false; }, p => { p.merge_commit_sha = 'other'; }, p => { p.labels = []; }, p => { p.user.login = 'human'; }]) {
    const p = prep(); mutate(p); assert.throws(() => check(undefined, p));
  }
});
const files = () => [{ name: '@ivannovr/pi-prompt-snippets', version: '1.2.0' }, { version: '1.2.0', packages: { '': { version: '1.2.0' } } }, { '.': '1.2.0' }, '# Changelog\n\n## [1.2.0](https://example.test) (2026-01-01)\n\n### Features\n\n* Something\n\n## 1.1.0\nold'];
test('stable version, all lock fields, manifest and exact changelog section agree', () => {
  const valid = files();
  assert.equal(versionFiles(...valid).version, '1.2.0');
  assert(!versionFiles(...valid).notes.includes('old'));
  for (const mutate of [f => { f[0].version = '1.2.0-beta.1'; }, f => { f[1].version = '1.1.0'; }, f => { f[1].packages[''].version = '1.1.0'; }, f => { f[2]['.'] = '1.1.0'; }, f => { f[3] = '## 1.2.01\nwrong'; }]) {
    const f = files(); mutate(f); assert.throws(() => versionFiles(...f));
  }
});
test('retry requires exact stable public release target, not merely main ancestry', () => {
  const r = { tag_name: 'v1.2.0', target_commitish: 'promotion', draft: false, prerelease: false };
  releaseIdentity(r, 'v1.2.0', 'promotion');
  for (const patch of [{ target_commitish: 'main' }, { target_commitish: 'other' }, { draft: true }, { prerelease: true }, { tag_name: 'v1.2.1' }]) assert.throws(() => releaseIdentity({ ...r, ...patch }, 'v1.2.0', 'promotion'));
});
