# Changelog

## [2.0.0](https://github.com/twostone/opencode-repo-instructions/compare/v1.0.0...v2.0.0) (2026-10-05)


### ⚠ BREAKING CHANGES

* the plugin no longer runs on OpenCode 1; it targets OpenCode 2 only. Config entries must use the V2 `plugins` shape (`"plugins": ["opencode-repo-instructions"]` or `{ "package", "options" }`).

### Features

* port plugin to the OpenCode V2 plugin API ([a3b0c2d](https://github.com/twostone/opencode-repo-instructions/commit/a3b0c2d4145c2b44a8efa13845ad873a7875a038))

## 1.0.0 (2026-09-17)


### Bug Fixes

* restore npm staged publishing with Node 26 in CI ([bc714a5](https://github.com/twostone/opencode-repo-instructions/commit/bc714a5012d444d7fd311423accf4098c7accd6e))
* use explicit test file glob for cross-version node --test ([50e6e59](https://github.com/twostone/opencode-repo-instructions/commit/50e6e599109c4984a2175d74413043f027d1f267))
