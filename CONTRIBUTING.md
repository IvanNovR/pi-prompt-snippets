# Contributing

Create working branches from current `dev`. Open normal pull requests only against `dev`. Update your branch so the current dev base is an ancestor of its head before final CI. Git cannot prove where a branch was originally created. The enforceable checks are the target, repository, exact head and current ancestry.

Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) for every retained commit subject and PR title. Examples are `feat: add a snippet`, `fix: preserve selection` and `ci: validate promotion`. Normal PRs may use squash or rebase. With squash, use the checked PR title as the resulting subject. With rebase, every retained subject must pass. The verified parentless historical `Initial commit` is the sole commit-check exception.

Run `npm ci`, `npm test`, `npm run check:package` and `npm run check:commits`. CI keeps the check names `source`, `commits` and `package` and adds `branch-policy`. Fork code runs only with read permissions and no publication credentials.

`main` accepts only a literal same-repository `dev` promotion. Never target main from work branches, release-please branches or hotfix branches. There is no direct-main hotfix exception.

Release preparation is a bot PR into dev. After it merges, freeze dev merges until the version has been published to both registries and the main-to-dev synchronization has merged. Work may continue on independent branches during the freeze. Promotion and synchronization must both use **merge commits**, with conventional subjects. Never squash or rebase synchronization because the tag's ancestry must survive.

See [the maintainer release guide](docs/RELEASING.md) for release gates, recovery and the required repository rulesets. CI is a guard, not an absolute locking service. Administrators can bypass settings, and previously successful checks can become stale. Maintainers must honor the freeze and rerun current-head checks before merging.
