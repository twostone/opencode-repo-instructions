# AGENTS.md

opencode plugin (TypeScript, ESM) that loads GitHub Copilot convention files
(`.github/*.md`, `~/.copilot/*`) into opencode sessions. Install/usage: README.md.

## Commands

- `npm install`
- `npm test` — `node --test test/` (Node's built-in test runner; no mocha/jest)
  - Single file: `node --test test/matcher.test.ts`
  - By name: `node --test --test-name-pattern "<pattern>" test/`
- `npm run typecheck` — `tsc --noEmit` (strict mode, already configured)
- `npm run build` — esbuild bundles `src/index.ts` → `dist/index.js` (single file;
  `picomatch` inlined, `@opencode-ai/plugin` + node builtins external, target node20)

No linter or formatter is configured — don't assume one exists.

## Architecture

- Entry: `src/index.ts` → `RepoInstructionsPlugin` (named + default export).
- `src/discovery.ts` scans `.github` + `~/.copilot` for instructions/skills/prompts/agents;
  `src/frontmatter.ts` is a dependency-free frontmatter parser; `src/matcher.ts` =
  picomatch `applyTo`/`globs` matching; `src/state.ts` = per-session injected-once state.
- `@opencode-ai/plugin` is a devDependency, external in the bundle — opencode provides
  it at runtime. The only runtime dep (picomatch) is bundled.
- Global rules are **merged into the last system message, not appended**: some providers
  (vLLM / OpenAI-compatible) reject payloads with multiple system messages. Don't change this.

## Gotchas

- Tests import `src/*.ts` directly (`.ts` import specifiers) — needs a Node with native
  type stripping (local: v26); there is no transpile step for tests.
- Tests are hermetic: fixtures built in `os.tmpdir()` per test; no services, no shared
  fixture dir, no env setup.
- `dist/` is gitignored but must stay in the npm tarball — that only works because
  `package.json` has an explicit `"files": ["dist"]`. Don't remove it.
- Releases are automated in one workflow (`.github/workflows/release.yml`): push to
  `develop` → merge the release PR → release-please creates the GitHub Release + tag
  `vX.Y.Z`, and the same run then builds and runs `npm stage publish` (gated on
  release-please's `release_created` output) — a maintainer approves via npmjs.com or
  `npm stage approve` (2FA). Requires the repo secret `NPM_TOKEN`; CI needs Node 26+
  (npm ≥ 11.15 for `npm stage`).

## Conventions

- Default (and only) branch: `develop`. Remote: `github.com/twostone/opencode-repo-instructions`.
- Conventional Commits, imperative subjects <72 chars (org-wide rule).
