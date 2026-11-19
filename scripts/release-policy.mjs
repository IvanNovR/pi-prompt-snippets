import assert from 'node:assert/strict';

export const prepBranch = 'release-please--branches--dev--components--pi-prompt-snippets';
export const syncBranch = 'main';
export const stable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export function route(pr, repo) {
  const same = pr.head.repo?.full_name === repo;
  if (pr.base.ref === 'dev' && pr.head.ref === syncBranch) {
    assert(same, 'Synchronization requires same repository');
    return 'sync';
  }
  if (pr.base.ref === 'main') {
    assert(same && pr.head.ref === 'dev', 'main accepts only same-repository dev');
    return 'promotion';
  }
  assert.equal(pr.base.ref, 'dev', 'PR target must be dev or main');
  assert(!['dev'].includes(pr.head.ref), 'Invalid source branch');
  if (pr.head.ref === 'main') {
    assert(same, 'Sync must be same-repository main');
    return 'sync';
  }
  if (pr.head.ref.startsWith('release-please--')) {
    assert(same && pr.head.ref === prepBranch && pr.user.login === 'github-actions[bot]', 'Untrusted preparation branch');
    return 'preparation';
  }
  return 'work';
}
export function installation(pr, repo, base, head, flags) {
  assert.equal(route(pr, repo), 'promotion');
  assert.notEqual(pr.user?.login, 'github-actions[bot]', 'Installation must be reviewed human work');
  assert.equal(flags.release, 'false', 'Installation requires release automation explicitly disabled');
  assert.equal(flags.publication, 'false', 'Installation requires publication explicitly disabled');
  assert.equal(base.version, head.version, 'Installation cannot change version');
  assert.equal(base.manifest, head.manifest, 'Installation cannot change manifest');
  assert.equal(base.changelog, head.changelog, 'Installation cannot change changelog');
}
export function pending(pr) { return pr.labels.some(l => l.name === 'autorelease: pending'); }
export function tagged(pr) { return pr.labels.some(l => l.name === 'autorelease: tagged'); }
export function versionFiles(pkg, lock, manifest, changelog) {
  assert.equal(pkg.name, '@ivannovr/pi-prompt-snippets');
  assert(stable.test(pkg.version), 'Expected stable semver');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest['.'], pkg.version);
  const sections = changelog.split(/(?=^## )/m);
  const section = sections.find(s => new RegExp(`^## \\[?${pkg.version.replaceAll('.', '\\.')}[\\] (]`).test(s));
  assert(section, 'Missing prepared changelog section');
  return { version: pkg.version, notes: section.trim() };
}
export function promotion(pr, prep, repo, devSha, parents) {
  assert.equal(route(pr, repo), 'promotion');
  assert(pr.merged && pr.merge_commit_sha, 'Promotion must be merged');
  assert.equal(prep.user.login, 'github-actions[bot]', 'Preparation must be automation-owned');
  assert.equal(pr.head.sha, devSha, 'dev drifted after promotion');
  assert.equal(route(prep, repo), 'preparation');
  assert(prep.merged && (pending(prep) || tagged(prep)), 'Missing merged preparation association');
  assert.equal(prep.merge_commit_sha, pr.head.sha, 'Unprepared changes after preparation');
  assert.equal(parents.length, 2, 'Promotion must use a merge commit');
  assert.equal(parents[0], pr.base.sha, 'Unexpected main parent');
  assert.equal(parents[1], pr.head.sha, 'Unexpected dev parent');
}
export function releaseIdentity(release, tag, sha) {
  assert.equal(release.tag_name, tag);
  assert(!release.draft && !release.prerelease, 'Expected public stable release');
  assert.equal(release.target_commitish, sha, 'Release target differs from promotion SHA');
}
