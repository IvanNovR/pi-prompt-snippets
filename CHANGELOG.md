# Changelog

## [1.1.1](https://github.com/IvanNovR/pi-prompt-snippets/compare/v1.1.0...v1.1.1) (2026-11-19)


### Features

* **snippets:** improve snippet management ([#5](https://github.com/IvanNovR/pi-prompt-snippets/issues/5)) ([4614373](https://github.com/IvanNovR/pi-prompt-snippets/commit/46143730e031c9ad2b397d6536c377ec33b36651))


### Bug Fixes

* **ci:** prevent duplicate workflow runs ([#4](https://github.com/IvanNovR/pi-prompt-snippets/issues/4)) ([cbdf548](https://github.com/IvanNovR/pi-prompt-snippets/commit/cbdf5489ce97ef9750896e0cf46445ae4d8a9931))


### Miscellaneous Chores

* synchronize main into dev ([cc6c6d4](https://github.com/IvanNovR/pi-prompt-snippets/commit/cc6c6d455504b5713caf366821a4c7b119458fa0))

## [1.1.0](https://github.com/IvanNovR/pi-prompt-snippets/compare/v1.0.1...v1.1.0) (2026-11-17)

### Features

* Add a sectioned snippet menu built on `@aliou/pi-utils-settings`: Enter/Space cycles settings, Esc saves and applies, and Tab previews snippets. ([d493dc2](https://github.com/IvanNovR/pi-prompt-snippets/commit/d493dc232347859ad0f164772e21b494cdaad3d2))
* Unify automatic and manual snippet injection under a persisted global Visible (default) or Hidden setting. ([d493dc2](https://github.com/IvanNovR/pi-prompt-snippets/commit/d493dc232347859ad0f164772e21b494cdaad3d2))

### Bug Fixes

* Keep persistent configuration selected in the menu after application without rearming consumed snippets; preserve eligibility and runtime state when saving unchanged settings. ([80d9cfb](https://github.com/IvanNovR/pi-prompt-snippets/commit/80d9cfb9955702fe876288b274b46e3c6ca036da))
* Guard conservatively against duplicate injection when visibility changes while an input is in flight. ([d493dc2](https://github.com/IvanNovR/pi-prompt-snippets/commit/d493dc232347859ad0f164772e21b494cdaad3d2))
* Make package smoke tests independent of npm cache state by preparing runtime dependencies before checking offline tarball installation without host peers. ([a990032](https://github.com/IvanNovR/pi-prompt-snippets/commit/a99003261081d25831bf26ce6e02115ef809980f))

### Tests

* Expand the suite to 88 tests, including source and compiled real `AgentSession` regressions for queued inputs, rejected inputs, images, and persistence. ([d493dc2](https://github.com/IvanNovR/pi-prompt-snippets/commit/d493dc232347859ad0f164772e21b494cdaad3d2), [80d9cfb](https://github.com/IvanNovR/pi-prompt-snippets/commit/80d9cfb9955702fe876288b274b46e3c6ca036da))

## [1.0.1](https://github.com/IvanNovR/pi-prompt-snippets/compare/v1.0.0...v1.0.1) (2026-11-10)


### Bug Fixes

* publish to GitHub Packages via aggregate registry metadata ([23a0555](https://github.com/IvanNovR/pi-prompt-snippets/commit/23a05552b707ef660c5d794cd01b43d6e3d5240c))

## 1.0.0 (2026-11-08)


### Features

* add prompt snippets extension and release infrastructure ([2b771cb](https://github.com/IvanNovR/pi-prompt-snippets/commit/2b771cbdd7e8a5cafc4f2df0fe544375b7e5f102))

## Changelog

Release notes are maintained by release-please using Conventional Commits.
The first release is prepared as **1.0.0**; it has not been published by this preparation work.
