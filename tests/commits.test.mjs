import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const script = pathToFileURL(resolve('scripts/check-commits.mjs')).href;
const historicalRoot = 'a90c48ecebeee15614da720f2bf5c70ae434cbed';

// Stub git responses rather than initialize a repository or alter local history.
function check(commits, { base, head, title } = {}) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const commits = ${JSON.stringify(commits)};
    const calls = [];
    cp.execFileSync = (cmd, args) => {
      if (cmd !== 'git') throw new Error('Unexpected executable');
      calls.push(args);
      if (args[0] === 'rev-list') return commits.map(c => c.sha).join('\\n');
      const commit = commits.find(c => c.sha === args.at(-1));
      if (!commit) throw new Error('Unknown test commit');
      if (args[2] === '--format=%s') return commit.subject;
      if (args[2] === '--format=%P') return commit.parents ?? 'parent';
      throw new Error('Unexpected git arguments');
    };
    syncBuiltinESMExports();
    for (const key of ['BASE_SHA', 'HEAD_SHA', 'PR_TITLE']) delete process.env[key];
    Object.assign(process.env, ${JSON.stringify({ ...(base === undefined ? {} : { BASE_SHA: base }), ...(head === undefined ? {} : { HEAD_SHA: head }), ...(title === undefined ? {} : { PR_TITLE: title }) })});
    console.log = () => {};
    let error;
    try { await import(${JSON.stringify(script)}); } catch (e) { error = e.message; }
    process.stdout.write(JSON.stringify({ calls, error }));
  `], { encoding: 'utf8' }));
}
const commit = (sha, subject, parents = 'parent') => ({ sha, subject, parents });

test('checks every commit in the supplied base..head range', () => {
  const result = check([commit('new', 'fix: newest'), commit('older', 'feat: earlier')], { base: 'base-sha', head: 'head-sha' });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.calls[0], ['rev-list', 'base-sha..head-sha']);
  assert.deepEqual(result.calls.filter(args => args[2] === '--format=%s').map(args => args.at(-1)), ['new', 'older']);
});

test('reports all invalid commits, including one hidden before a valid tip', () => {
  const result = check([commit('tip', 'fix: valid tip'), commit('bad1', 'not conventional'), commit('bad2', 'Merge pull request #1')]);
  assert.match(result.error, /bad1: not conventional/);
  assert.match(result.error, /bad2: Merge pull request/);
  assert.equal(result.calls.filter(args => args[2] === '--format=%s').length, 3);
});

test('only the verified root SHA, subject and parentlessness are exempt', () => {
  assert.equal(check([commit(historicalRoot, 'Initial commit', '')]).error, undefined);
  assert.match(check([commit('another-root', 'Initial commit', '')]).error, /another-root/);
  assert.match(check([commit(historicalRoot, 'Initial commit', 'parent')]).error, /Initial commit/);
  assert.match(check([commit(historicalRoot, 'Unverified initial subject', '')]).error, /Unverified/);
});

test('accepts breaking-change and release bot conventional subjects', () => {
  assert.equal(check([
    commit('a', 'feat!: change format'),
    commit('b', 'fix(parser)!: remove obsolete syntax'),
    commit('c', 'chore(main): release 1.0.0'),
    commit('d', 'revert: undo an earlier change'),
  ]).error, undefined);
});

test('PR titles are checked independently of valid commit subjects', () => {
  const commits = [commit('a', 'fix: valid commit')];
  assert.equal(check(commits, { title: 'feat(ui)!: redesign selection' }).error, undefined);
  assert.match(check(commits, { title: 'New feature' }).error, /PR title must be a Conventional Commit/);
});

test('new branch and manual checks inspect full history without an invalid zero base', () => {
  const commits = [commit('a', 'ci: prepare checks')];
  assert.deepEqual(check(commits, { base: '0'.repeat(40), head: 'tip' }).calls[0], ['rev-list', 'tip']);
  assert.deepEqual(check(commits).calls[0], ['rev-list', 'HEAD']);
});
