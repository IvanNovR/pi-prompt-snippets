# Maintainer release guide

## Activation and safety gates

Public publication and main-branch release automation have been authorized. The release workflow runs on main pushes and manual dispatch, but remains inert while readiness variables are unset. CI is read-only and cannot publish. Publication additionally requires approval through the `publication` environment.

Package: `@ivannovr/pi-prompt-snippets`. First release/tag: **1.0.0 / v1.0.0**. Both npm and GitHub Packages receive the same scoped package and tarball. There is deliberately no `publishConfig.registry`.

## Before connecting or enabling anything

1. Obtain explicit approval for the separate git/publication phase. Reconcile the existing remote history (currently its historical `Initial commit` and LICENSE) without overwriting it. Do not create a second unrelated root history. Preserve the verified MIT notice and README upstream credit.
2. Use **Node 24.21.0 / npm 11.19.0**, matching CI. Run `npm ci`, `npm test`, and `npm run check:package`. The last command builds, checks the tarball allowlist/metadata, installs it offline without peers, then smoke-tests both installed source and compiled entries with the host-provided TUI peer. It does not launch an interactive Pi session or regenerate captures.
3. All new commits and PR titles, including bots, must be Conventional Commits. Examples: `feat: prepare initial public release`, `ci: harden package checks`, `chore(main): release 1.0.0`. Only the verified parentless historical `Initial commit` at `a90c48ecebeee15614da720f2bf5c70ae434cbed` is exempt. Configure dependency bots to use conventional prefixes before enabling them. Prefer squash merges with the checked PR title; default `Merge pull request ...` commits fail the policy. `npm run check:commits` checks local history; CI narrows this to every new push/PR commit and also checks PR titles. A `feat:` or `fix:` commit is needed for release-please to propose the first release.
4. After separately approved upload, verify the gallery URL returns HTTP 200 and an image: `https://raw.githubusercontent.com/IvanNovR/pi-prompt-snippets/main/docs/assets/menu.png`. The image exists locally, is packed, and is committed on main. Keep the honest fixture-rendering description; do not present the images as a live CLI recording.

## Required external setup (not performed here)

- GitHub **Settings → Actions → General → Workflow permissions → Allow GitHub Actions to create and approve pull requests** must be enabled (configured during activation). Workflow permissions are job-scoped; do not globally grant unnecessary write access.
- The **`publication`** environment is configured with `IvanNovR` as required reviewer, self-review allowed for the solo maintainer, and only the `main` branch allowed. The workflow runs from main even when checking out a release tag: environment branch policy evaluates the workflow ref, not the checkout ref. Do not dispatch publication from a tag. Protect main and release tags from unreviewed changes.
- Ensure the repository's `GITHUB_TOKEN` may publish its GitHub package (`packages: write`). Associate any existing GitHub package with this repository and grant it Actions access. New GitHub packages can default to private; verify/set the desired public visibility separately. npm `--access public` does not itself configure GitHub package visibility.
- Establish ownership of `@ivannovr` on npm. **Do not assume an unpublished package already has a trusted-publisher settings page.** npm's documented setup starts with an existing package. If an initial authenticated bootstrap publication is necessary, it requires separate explicit authorization; this preparation does not provide an npm write token or perform that publication. See the bootstrap sequence below.
- In npm package settings configure GitHub Actions trusted publishing for owner **`IvanNovR`**, repository **`pi-prompt-snippets`**, workflow filename **`release.yml`** (not its path), environment **`publication`**. Explicitly allow **direct `npm publish`**, not only staged publishing. Current npm docs require the first successful use within **two days** of creating the trust configuration; create it just before activation and recheck current requirements.
- OIDC needs npm **>=11.5.1**, Node **>=22.14.0**, a supported **GitHub-hosted** runner, and `id-token: write`. The pinned runtime exceeds those minimums. The public repository URL in package metadata must match this repository. npm publishing uses **no npm token / `NODE_AUTH_TOKEN`**. Public trusted publication provides provenance automatically. `npm whoami` does not validate OIDC trust.
- Only after the corresponding setup is ready, set repository variables **`RELEASE_AUTOMATION_READY=true`** (allows release PRs and GitHub releases) and **`PUBLICATION_READY=true`** (allows registry publishing). Unset or any other value disables that phase. Do not set the publication variable until trust/bootstrap and package permissions are ready. No variable or setting is changed by these files.

## Explicit first-release bootstrap

The empty `.release-please-manifest.json` means **no previous release**. `initial-version: "1.0.0"` selects the first version explicitly. Do **not** seed the manifest with `1.0.0` (that claims a previous release), and do not add a persistent `release-as` override. `bootstrap-sha`, if ever needed to limit imported history, is a history boundary, not a version override. Confirm no conflicting published versions/tags before enabling automation.

1. After approved git setup, tests, settings, and conventional initial feature commit, enable `RELEASE_AUTOMATION_READY` only. Leave `PUBLICATION_READY` unset initially if npm bootstrap remains unresolved.
2. On **main**, manually dispatch **Release**, operation **`release`**. release-please opens/updates the version PR, updating `package.json`, `package-lock.json`, `CHANGELOG.md`, and its manifest. Review that it proposes exactly **1.0.0**, not 1.0.1/1.1.0.
3. Check that PR manually before merging. PRs created with `GITHUB_TOKEN` do not automatically start PR workflows. A separate, narrowly scoped `actions: write` job explicitly dispatches CI from the release PR branch with its PR number and exact head SHA. CI has read-only permissions, verifies that the current PR head and workflow SHA match, checks the PR title and every new commit, and tests that exact checkout. Merge only after successful CI on the reviewed head SHA. If dispatch failed, run `gh workflow run ci.yml --ref <release-branch> -f pr_number=<number> -f expected_sha=<head-sha>`; never substitute CI on main.
4. Squash merge with the conventional release title. The main push automatically runs operation **`release`**; manually dispatch only if recovery is needed. release-please creates **v1.0.0** and its GitHub release. When publication readiness is enabled, that same run continues on `release_created == 'true'` to publish both registries. It does not depend on a second `release` event, which `GITHUB_TOKEN` would not reliably trigger.
5. **If first npm creation needs a bootstrap publish:** deliberately leave `PUBLICATION_READY` disabled in step 4, so only the GitHub release is created. Stop for the separately approved initial publication/authentication procedure. Build/test and pack the exact **v1.0.0** tag with the pinned tools; preserve that artifact and use it for the authorized initial npm publication. Configure npm trust afterwards, then enable `PUBLICATION_READY` and dispatch **`retry`**, tag **`v1.0.0`**. The workflow verifies identical existing npm bytes and finishes GitHub Packages. Do not publish a different artifact under the same immutable version. No bootstrap write credential is stored in this workflow.

Normal later releases follow steps 2–4, with main pushes opening/updating release PRs and merged release PRs creating releases automatically. Do not race a manual dispatch with the automatic run. `RELEASE_AUTOMATION_READY` gates all release work; `PUBLICATION_READY` independently gates registry work.

## Partial publication and recovery

GitHub release creation and two registry writes are **not atomic**. All release runs share a non-cancelling concurrency group. One job packs once, publishes npm with OIDC, then publishes GitHub Packages using `GITHUB_TOKEN` and a separate scoped npm configuration. Dependencies always install from npm before GitHub authentication is configured; GitHub credentials cannot leak to npm's registry.

If any step fails, fix the actual permission/trust/network issue, then dispatch **`retry`** from main with the existing stable release tag. Recovery validates that a non-draft, non-prerelease GitHub release exists, requires the checked-out tag commit to be in reviewed main history, and checks the tag's package/lock versions before rebuilding/testing. It does not create a new tag or bump the version. If both versions already exist with identical SHA-1 tarball hashes, it skips both; a differing immutable artifact is a hard failure requiring investigation, not an overwrite attempt.

Registry lookups accept a well-formed **200** with matching package/version/hash, or **404** to attempt publishing. Redirects, transport errors, malformed responses, 401/403, rate limits, and 5xx fail closed. A private registry can conceal a permission error as 404; this permits only an attempt, never a success claim, and any `npm publish` failure is fatal. Do not use `npm view ... || npm publish` or swallow publish errors. Tokens are never printed.

After success, independently verify both registry versions, npm provenance, GitHub package visibility, release notes, gallery image, and an actual `pi install npm:@ivannovr/pi-prompt-snippets@1.0.0` in a disposable profile. Installed-package smoke is not a substitute for that post-publication interactive check.

## Sources

- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) (also checked against the installed Pi package documentation).
- [release-please manifest bootstrap](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md#bootstrapping), [configuration schema](https://github.com/googleapis/release-please/blob/main/schemas/config.json), [PR title customization](https://github.com/googleapis/release-please/blob/main/docs/customizing.md#pull-request-title).
- [release-please action outputs and workflow-trigger restrictions](https://github.com/googleapis/release-please-action).
- [npm trusted publishing: requirements, setup, direct publishing and expiry](https://docs.npmjs.com/trusted-publishers/).
- [GitHub Packages npm registry and workflow authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).
