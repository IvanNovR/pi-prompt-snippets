import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const conventional = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^\r\n()]+\))?!?: \S.*$/;
// Verified read-only against the existing upstream repository before preparation.
const historicalRoot = 'a90c48ecebeee15614da720f2bf5c70ae434cbed';
const failures = [];
if (process.env.PR_TITLE && !conventional.test(process.env.PR_TITLE)) failures.push('PR title must be a Conventional Commit');
const head = process.env.HEAD_SHA || 'HEAD';
const base = process.env.BASE_SHA;
const range = base && !/^0+$/.test(base) ? `${base}..${head}` : head;
for (const sha of git('rev-list', range).split('\n').filter(Boolean)) {
  const subject = git('show', '-s', '--format=%s', sha);
  const parents = git('show', '-s', '--format=%P', sha);
  if (sha === historicalRoot && subject === 'Initial commit' && !parents) continue;
  if (!conventional.test(subject)) failures.push(`${sha}: ${subject}`);
}
if (failures.length) throw new Error(failures.join('\n'));
console.log('Conventional Commit subjects and PR title passed.');
