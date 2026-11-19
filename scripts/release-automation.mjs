import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { route, pending, tagged, promotion, versionFiles, releaseIdentity, installation } from './release-policy.mjs';
const repo = process.env.GITHUB_REPOSITORY;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
async function api(path, method = 'GET', body, missing = false) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (missing && response.status === 404) return null;
  assert(response.ok, `GitHub ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
async function pulls() {
  const result = [];
  for (let page = 1; ; page++) {
    const rows = await api(`pulls?state=all&per_page=100&page=${page}`);
    result.push(...rows);
    if (rows.length < 100) return result;
  }
}
const output = (key, value) => fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
const jsonAt = (sha, file) => JSON.parse(git('show', `${sha}:${file}`));
const versions = sha => versionFiles(jsonAt(sha, 'package.json'), jsonAt(sha, 'package-lock.json'), jsonAt(sha, '.release-please-manifest.json'), git('show', `${sha}:CHANGELOG.md`));
const ancestor = (a, b) => { git('merge-base', '--is-ancestor', a, b); };
const isAncestor = (a, b) => {
  try { ancestor(a, b); return true; } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
};
async function dispatch(pr) {
  assert.equal(pr.head.repo.full_name, repo);
  await api('actions/workflows/ci.yml/dispatches', 'POST', { ref: 'main', inputs: { pr_number: String(pr.number), expected_sha: pr.head.sha } });
}
const all = await pulls();
const preparations = all.filter(p => p.base.ref === 'dev' && p.head.ref.startsWith('release-please--'));
const incomplete = preparations.filter(p => p.merged_at && pending(p));
assert(incomplete.length <= 1, 'Multiple incomplete release cycles');
async function sync(prep) {
  const existing = all.find(p => p.state === 'open' && p.base.ref === 'dev' && p.head.ref === 'main' && p.head.repo?.full_name === repo);
  const pr = existing || await api('pulls', 'POST', { base: 'dev', head: 'main', title: `chore: synchronize main after ${versions(prep.merge_commit_sha).version}`, body: 'Merge with a merge commit only. Preserve the release tag ancestry before resuming development.' });
  await dispatch(pr);
}
const operation = process.argv[2];
if (operation === 'ci') {
  const pr = await api(`pulls/${process.env.PR_NUMBER}`);
  assert.equal(pr.state, 'open');
  assert.equal(pr.head.sha, process.env.EXPECTED_SHA, 'PR head moved');
  const kind = route(pr, repo);
  const initial = process.env.INITIAL_INSTALL === 'true';
  if (initial) {
    assert.equal(process.env.EVENT_NAME, 'pull_request', 'Installation fallback is ordinary PR CI only');
    assert(/^[0-9a-f]{40}$/.test(process.env.TRUSTED_MAIN_SHA), 'Immutable trusted main SHA required');
    assert.equal(git('rev-parse', 'origin/main'), process.env.TRUSTED_MAIN_SHA, 'Trusted main moved');
    assert.equal(git('ls-tree', process.env.TRUSTED_MAIN_SHA, '--', 'scripts/release-automation.mjs', 'scripts/release-policy.mjs'), '', 'Pipeline already installed or partially installed');
    assert.equal(process.env.RELEASE_AUTOMATION_READY, 'false', 'Installation requires release automation explicitly disabled');
    assert.equal(process.env.PUBLICATION_READY, 'false', 'Installation requires publication explicitly disabled');
  }
  if (process.env.EVENT_NAME === 'workflow_dispatch') {
    assert(['preparation', 'sync'].includes(kind), 'Dispatch only for automation PRs');
    assert.equal(pr.user.login, 'github-actions[bot]');
    assert.equal(process.env.WORKFLOW_REF, 'refs/heads/main', 'Dispatch must use trusted main');
  }
  if (pr.base.ref === 'dev') {
    if (pr.head.ref === 'main') {
      assert.equal(pr.head.repo?.full_name, repo);
      assert.equal(pr.head.sha, git('rev-parse', 'origin/main'), 'Synchronization head differs from trusted main');
      ancestor(pr.base.sha, pr.head.sha);
      assert.equal(incomplete.length, 0, 'Publication incomplete, synchronization blocked');
    } else assert.equal(incomplete.length, 0, 'Release freeze: no dev changes until publication and sync');
    const latest = preparations.find(p => p.merged_at && tagged(p));
    if (latest && pr.head.ref !== 'main') ancestor(`v${versions(latest.merge_commit_sha).version}`, pr.base.sha);
    if (kind === 'work') ancestor(pr.base.sha, pr.head.sha);
  } else if (initial) {
    assert.equal(incomplete.length, 0, 'Installation cannot overlap a release cycle');
    assert.equal(pr.base.sha, process.env.TRUSTED_MAIN_SHA, 'Installation base differs from trusted main');
    ancestor(pr.base.sha, pr.head.sha);
    const bytes = (sha, file) => execFileSync('git', ['show', `${sha}:${file}`], { encoding: 'utf8' });
    const snapshot = sha => ({ ...versions(sha), manifest: bytes(sha, '.release-please-manifest.json'), changelog: bytes(sha, 'CHANGELOG.md') });
    installation(pr, repo, snapshot(pr.base.sha), snapshot(pr.head.sha), { release: process.env.RELEASE_AUTOMATION_READY, publication: process.env.PUBLICATION_READY });
  } else {
    assert.equal(incomplete.length, 1, 'Promotion requires pending preparation');
    assert.equal(incomplete[0].merge_commit_sha, pr.head.sha, 'Promotion contains unprepared changes');
    versions(pr.head.sha);
  }
  output('sha', pr.head.sha); output('base', pr.base.sha); output('title', JSON.stringify(pr.title));
} else if (operation === 'prepare') {
  if (incomplete.length) output('ready', 'false');
  else {
    const latest = preparations.find(p => p.merged_at && tagged(p));
    if (latest) ancestor(`v${versions(latest.merge_commit_sha).version}`, 'origin/dev');
    assert(!all.some(p => p.state === 'open' && p.base.ref === 'dev' && p.head.ref === 'main'), 'Synchronization still open');
    output('ready', 'true');
  }
} else if (operation === 'dispatch') {
  for (const pr of all.filter(p => p.state === 'open' && p.base.ref === 'dev' && p.head.repo?.full_name === repo && p.user.login === 'github-actions[bot]' && p.head.ref.startsWith('release-please--'))) { route(pr, repo); await dispatch(pr); }
} else if (operation === 'finalize' || operation === 'complete') {
  let pr;
  if (process.env.OPERATION === 'retry') {
    assert(/^v\d+\.\d+\.\d+$/.test(process.env.RELEASE_TAG), 'Stable retry tag required');
    const release = await api(`releases/tags/${process.env.RELEASE_TAG}`);
    const matches = all.filter(p => p.merged_at && p.base.ref === 'main' && p.merge_commit_sha === release.target_commitish);
    assert.equal(matches.length, 1, 'Retry release has no unique promotion association');
    pr = await api(`pulls/${matches[0].number}`);
  } else pr = await api(`pulls/${process.env.PR_NUMBER}`);
  const prepCandidates = preparations.filter(p => p.merged_at && p.merge_commit_sha === pr.head.sha);
  assert.equal(prepCandidates.length, 1, 'Expected exactly one preparation');
  const prep = await api(`pulls/${prepCandidates[0].number}`);
  const dev = await api('git/ref/heads/dev');
  const synchronized = tagged(prep) && isAncestor(pr.merge_commit_sha, 'origin/dev');
  if (!synchronized) assert.equal(git('rev-parse', 'origin/main'), pr.merge_commit_sha, 'main advanced during release freeze');
  promotion(pr, prep, repo, synchronized ? pr.head.sha : dev.object.sha, git('show', '-s', '--format=%P', pr.merge_commit_sha).split(' '));
  ancestor(pr.merge_commit_sha, 'origin/main');
  assert.equal(git('rev-parse', `${pr.merge_commit_sha}^{tree}`), git('rev-parse', `${pr.head.sha}^{tree}`), 'Promotion tree differs from prepared dev');
  const conventional = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^\r\n()]+\))?!?: \S.*$/;
  assert(conventional.test(pr.title), 'Promotion title must be conventional');
  assert(conventional.test(git('show', '-s', '--format=%s', pr.merge_commit_sha)), 'Promotion merge subject must be conventional');
  const { version, notes } = versions(pr.merge_commit_sha);
  assert.equal(versions(prep.merge_commit_sha).version, version);
  const tag = `v${version}`;
  if (process.env.OPERATION === 'retry') assert.equal(tag, process.env.RELEASE_TAG);
  const ref = await api(`git/ref/tags/${tag}`, 'GET', undefined, true);
  if (ref) {
    let object = ref.object;
    const seen = new Set();
    while (object.type === 'tag') {
      assert(!seen.has(object.sha), 'Cyclic tag'); seen.add(object.sha);
      object = (await api(`git/tags/${object.sha}`)).object;
    }
    assert(object.type === 'commit' && object.sha === pr.merge_commit_sha, 'Tag does not point exactly to promotion');
  }
  else { assert.notEqual(process.env.OPERATION, 'retry', 'Retry cannot create tags'); await api('git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: pr.merge_commit_sha }); }
  let release = await api(`releases/tags/${tag}`, 'GET', undefined, true);
  if (!release) {
    assert.notEqual(process.env.OPERATION, 'retry', 'Retry requires an existing release');
    release = await api('releases', 'POST', { tag_name: tag, target_commitish: pr.merge_commit_sha, name: tag, body: notes, draft: false, prerelease: false });
  }
  releaseIdentity(release, tag, pr.merge_commit_sha);
  if (operation === 'complete') {
    // Publication succeeded. A failed sync create/dispatch is recoverable with retry.
    // Preparation also requires the released tag to be reachable from dev.
    await api(`issues/${prep.number}/labels`, 'POST', { labels: ['autorelease: tagged'] });
    if (pending(prep)) await api(`issues/${prep.number}/labels/${encodeURIComponent('autorelease: pending')}`, 'DELETE');
    if (!synchronized) await sync(prep);
  }
  output('tag', tag); output('sha', pr.merge_commit_sha);
} else throw new Error(`Unknown operation: ${operation}`);
