import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { route } from './release-policy.mjs';

const names = ['source', 'branch-policy', 'commits', 'package'];
export function conclusion(result) {
  if (result === 'success') return 'success';
  if (result === 'cancelled') return 'cancelled';
  return 'failure';
}
export async function reportChecks(context, api) {
  const { repository, prNumber, expectedSha, event, ref, results, runId } = context;
  assert.equal(event, 'workflow_dispatch');
  assert.equal(ref, 'refs/heads/main', 'Check reporter requires trusted main workflow');
  assert(/^\d+$/.test(prNumber), 'Expected numeric PR number');
  assert(/^[0-9a-f]{40}$/.test(expectedSha), 'Expected full head SHA');
  assert(/^\d+$/.test(runId), 'Expected workflow run ID');
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Expected repository');
  async function verify() {
    const pr = await api(`pulls/${prNumber}`);
    assert.equal(pr.state, 'open', 'PR closed before reporting');
    assert.equal(pr.head.sha, expectedSha, 'PR moved before reporting');
    assert.equal(pr.head.repo?.full_name, repository, 'Reporter only supports same-repository PRs');
    assert.equal(pr.user.login, 'github-actions[bot]', 'Reporter only supports automation-owned PRs');
    assert(['preparation', 'sync'].includes(route(pr, repository)), 'Reporter only supports preparation and synchronization');
  }
  await verify();
  for (const name of names) {
    await verify();
    const result = name !== 'source' && results.source?.result !== 'success' ? 'failure' : results[name]?.result;
    await api('check-runs', 'POST', {
      name, head_sha: expectedSha, status: 'completed', conclusion: conclusion(result),
      details_url: `https://github.com/${repository}/actions/runs/${runId}`,
      output: { title: `${name}: ${conclusion(result)}`, summary: 'Exact-head read-only CI result reported by the trusted main workflow. Skipped or unknown results never pass.' },
    });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repository = process.env.GITHUB_REPOSITORY;
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, `GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
  await reportChecks({ repository, prNumber: process.env.PR_NUMBER, expectedSha: process.env.EXPECTED_SHA,
    event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF, results: JSON.parse(process.env.JOB_RESULTS), runId: process.env.GITHUB_RUN_ID }, api);
}
