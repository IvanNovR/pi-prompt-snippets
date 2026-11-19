# Maintainer release guide

## Release model

Normal work goes from a branch created from dev through a PR into dev. There is no direct-main hotfix path. The release cycle is:

1. **Prepare** on dev. `prepare-release.yml` runs release-please with `target-branch: dev` and `skip-github-release: true`. Its bot PR updates `package.json`, `package-lock.json`, `CHANGELOG.md` and `.release-please-manifest.json`. It does not tag, release or publish. Review its exact head and merge with squash or rebase using Conventional Commit subjects.
2. **Freeze** when that preparation merges. Stop all normal dev merges, including documentation and dependency updates. Independent work branches may continue. Keep the preparation's `autorelease: pending` label until both registries succeed. release-please itself blocks subsequent preparation while a merged preparation remains pending.
3. **Promote** by manually opening a literal same-repository `dev` -> `main` PR. Use a conventional title such as `chore: release 1.2.0`. The dev head must be exactly the merged preparation commit. Do not add commits after preparation. Merge using a **merge commit**, not squash or rebase. Set the merge commit subject to the conventional PR title instead of GitHub's default `Merge pull request ...`.
4. **Release and publish** from the merged PR's `release.yml` run on main. It verifies the repository, branch route, exact preparation association, two ordered parents, unchanged dev head and prepared tree. Package, both lockfile versions and manifest must agree on stable semver. The changelog must contain that version's section. The workflow creates `vX.Y.Z` at the exact promotion merge SHA and a public stable GitHub release with that section as notes. Arbitrary main pushes and manually supplied refs cannot create releases.
5. **Complete and synchronize** after successful publication to both registries. The exact preparation changes from pending to `autorelease: tagged`. Automation opens a same-repository `main` -> `dev` PR and explicitly dispatches its CI. Merge this PR with a **merge commit** and conventional subject. Do not squash or rebase. Resume normal merges and new preparation only after the release tag is an ancestor of dev and no incomplete cycle or open sync remains.

The existing version is **1.1.0** and the existing release tag is **v1.1.0**. Preserve the manifest's `1.1.0` baseline. Do not reset versions, create a new initial release or add a persistent `release-as` override. The configuration's historical `initial-version` is not a reset instruction when a manifest baseline exists.

## Trust, CI and freeze limits

`source`, `commits` and `package` retain their names. `branch-policy` makes invalid targets visible rather than silently filtering PRs. Only same-repository dev may target main. Dev permits work branches, the exact trusted release-please bot branch and same-repository main synchronization. PR title and every retained subject must follow Conventional Commits 1.0.0. Only the verified historical parentless `Initial commit` is exempt.

Bot-created PR events do not normally start workflows when created using `GITHUB_TOKEN`. Both preparation and synchronization therefore dispatch `ci.yml` using the trusted **main workflow ref**, passing the PR number and exact expected head separately. The read-only source job fetches current PR metadata and rejects a moved head or spoofed automation branch/author. Tests check out that exact head without persisted credentials. Native dispatch job checks belong to the main workflow SHA, not the checked-out PR SHA. A separate main-dispatch-only reporter with narrowly scoped `checks: write` checks out only the immutable trusted workflow SHA and creates the required `source`, `branch-policy`, `commits` and `package` check runs explicitly at the expected PR head. It revalidates that the bot PR is still open at that SHA before each write. Only actual successful jobs pass. Failure, cancellation, skipped or unknown results cannot become success. A moved or closed head stops reporting, and new heads need a new dispatch. If the entire workflow is cancelled before reporting, checks may be missing and merge remains blocked. No PR checkout code executes with write tokens or publication secrets. Read-only policy logic is loaded from main. Manual redispatch is:

```bash
gh workflow run ci.yml --ref main -f pr_number=<number> -f expected_sha=<current-full-head-sha>
```

The preparation workflow runs from dev. The finalizer and publisher run only from main. The publisher checks promotion and tag identity again **after** `publication` environment approval. A tag must peel to the exact promotion SHA, whether lightweight or annotated. A GitHub release must name that tag and its `target_commitish` must be the full promotion SHA, not `main` or another ancestor.

These checks do not create an absolute GitHub merge freeze. Checks are snapshots, administrators can bypass rules, and concurrent merges can race. The finalizer rejects observed drift instead of releasing unprepared changes. Maintainers must freeze dev, inspect current heads and avoid races through publication and sync. Git cannot prove a branch's historical creation point. CI enforces actionable target/current ancestry instead. If a sync is incorrectly squashed or rebased, the tag ancestry gate stays blocked until an explicitly reviewed ancestry-preserving repair.

## Required external setup (not performed by these files)

- Configure dev and main rulesets to require PRs and current `source`, `branch-policy`, `commits` and `package` checks, prohibit force pushes/deletion and allow the agreed administrator bypass. Main is merge-only. Dev must allow merge, squash and rebase because normal PRs use squash/rebase but sync needs merge. GitHub's static merge-method settings cannot express every per-PR method rule. Enforce those methods through the guarded maintainer process.
- Keep **Actions -> Workflow permissions -> Allow GitHub Actions to create and approve pull requests** enabled. There is no PAT requirement. Job permissions are narrowly scoped.
- Retain the **`publication`** environment approval and restrict it to main. Environment branch policy evaluates the workflow ref, not the tag checked out later. Do not dispatch from a tag.
- npm trusted publishing must identify owner `IvanNovR`, repository `pi-prompt-snippets`, workflow filename **`release.yml`** and environment **`publication`**. Allow direct npm publishing. Verify current npm trusted-publisher requirements and expiry when enabling it. This implementation does not verify or change live npm settings.
- OIDC uses GitHub-hosted runners, Node **24.21.0**, npm **11.19.0** and `id-token: write`. No npm write token is stored. GitHub Packages uses `packages: write` and isolated scoped authentication. Verify repository Actions access and public visibility separately for the GitHub package.
- Set **`RELEASE_AUTOMATION_READY=true`** only when release automation is ready. Set **`PUBLICATION_READY=true`** only when both registries and trust are ready. Unset or other values disable that phase. A disabled publication gate leaves the cycle pending and frozen. A disabled release gate at merge means no automatic finalization occurs. Re-enable and rerun the original trusted merged-PR workflow, rather than dispatching an arbitrary new release.

No repository setting, readiness variable, trust configuration or remote state is changed by this implementation.

## First installation of this pipeline

**Operational rollout is unresolved and requires separate approval before enabling it remotely.** These files are designed for the steady state in which main already contains the trusted workflow and policy scripts. Existing main has an older CI dispatch contract. Dispatching a new dev preparation to that older workflow fails closed rather than falling back to an untrusted workflow ref.

Candidate rollout for explicit maintainer review: keep both readiness variables disabled, review and install the pipeline code on dev, then agree a one-time reviewed installation promotion to main with publication disabled so the trusted-main workflow and scripts exist. That installation cannot be represented as a normal prepared-version promotion by this finalizer. Establish and review an ancestry-preserving main-to-dev synchronization, then enable preparation for the first ordinary release cycle. The exact installation authorization, ruleset handling and any initial failing policy checks must be resolved separately. Do not silently bypass policy, synthesize a version preparation or change settings to make this happen. No bootstrap exception is encoded here.

## Partial publication and recovery

Tag creation, GitHub release creation and two registry writes are not atomic. Preparation and release share a non-cancelling concurrency group. Publication approval can hold this group while dev remains frozen. Do not race manual runs with automatic runs.

One job builds/tests the exact promotion SHA, runs `check:package` and packs **one tarball** for both registries. `check:package` prepares runtime dependencies online in an isolated consumer, installs the extension tarball offline without host peers and smoke-tests installed source and compiled entries. It does not verify a completely offline dependency bootstrap or an interactive Pi session.

Registry lookup is fail-closed. A well-formed 200 must identify the same package/version and SHA-1 tarball bytes to skip an existing version. A 404 permits only an attempt to publish. Redirects, transport errors, malformed data, 401/403, rate limits and server errors fail. A concealed permission failure returning 404 still cannot turn a failed npm publish into success. Differing immutable bytes are an investigation, never an overwrite. npm OIDC auth and GitHub Packages token configuration remain isolated.

If publication fails or is cancelled after either registry succeeds, pending remains and dev stays frozen. Repair the actual problem, then dispatch **Release** from main with operation **retry** and the existing stable tag:

```bash
gh workflow run release.yml --ref main -f operation=retry -f tag=vX.Y.Z
```

Retry requires an existing public stable release and tag, finds the unique merged dev-to-main promotion by exact SHA and validates the same preparation association. It cannot invent a missing tag or release. If a run failed between tag creation and release creation, rerun the original merged-PR workflow, which verifies and reuses the tag. If no artifact was published, an identical deterministic rebuild is still required on retry. If immutable bytes differ, stop and investigate.

Readiness disabled, environment rejection, failure or cancellation before publication success does not consume pending. If publication succeeds but label or sync work fails, retry verifies identical existing registry bytes and resumes completion. Label transitions and PR creation are recoverable but not transactional. The tag-ancestor gate blocks preparation even if tagging the preparation succeeded before sync creation failed. An existing open main-to-dev PR is reused and its current exact head redispatched. If creating that PR succeeded but dispatch failed, redispatch manually or retry. If sync is lost, closed, conflicted or raced by dev/main advancement, keep dev frozen, inspect the exact release identity and repair through reviewed PRs. Never force/reset branches or move release tags as an automatic repair.

After completion independently verify both registry versions, npm provenance, GitHub package visibility, release notes and an actual `pi install npm:@ivannovr/pi-prompt-snippets@X.Y.Z` in a disposable profile. Package smoke tests do not replace that interactive check.

## References

- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [release-please manifest configuration](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [release-please action inputs and workflow trigger restrictions](https://github.com/googleapis/release-please-action)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [GitHub Packages npm authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
