# opencode-repo-instructions

An [opencode](https://opencode.ai) plugin (V2) that loads GitHub Copilot convention files — repository- and user-level instructions, skills, prompts, and agents — and injects them into opencode's context. The same files Copilot reads in VS Code now drive opencode, with no manual `AGENTS.md` duplication.

Built for the **OpenCode 2** plugin API (`@opencode/plugin` v2, `Plugin.define`). The V1 implementation no longer runs in V2, so this major version targets V2 only.

## What it loads

| Source (relative to repo root unless noted) | Kind | How it's provided to opencode |
| --- | --- | --- |
| `.github/copilot-instructions.md` | always-on rule | system prompt, re-injected on compaction |
| `.github/instructions/*.md` | path-scoped rule (`applyTo` / `globs` frontmatter) | injected into tool output on first `read`/`edit`/`write` of a matching file |
| `~/.copilot/instructions/*.md` | global rule (same semantics as above) | same as above |
| `.github/skills/**/SKILL.md` | skill | embedded into opencode's native skill system |
| `~/.copilot/skills/**/SKILL.md` | user-level skill | embedded into opencode's native skill system |
| `.github/prompts/*.prompt.md` | custom prompt | registered as an opencode command |
| `~/.copilot/prompts/*.prompt.md` | user-level prompt | registered as an opencode command |
| `.github/agents/*.agent.md` | custom agent | written as a managed `.opencode/agents/<name>.md` subagent |
| `~/.copilot/agents/*.agent.md` | user-level agent | written as a managed `~/.config/opencode/agents/<name>.md` subagent |
| VS Code `github.copilot.chat.customInstructions` | user-level free text | system prompt |

Notes:

- `applyTo` accepts a quoted string, comma list, inline list, or block list: `applyTo: '**/*.ts,**/*.tsx'`. A match-all pattern (`**`) is treated as an always-on rule.
- Symlinked instruction files are supported (broken symlinks are ignored).
- `AGENTS.md` and `CLAUDE.md` are intentionally ignored — opencode loads those natively, so the plugin never double-injects them.
- Changed rule files are re-read live (debounced) via opencode's `filesystem.changed` event; no restart needed.
- Files above 256 KB are skipped with a warning.
- Agent files created by the plugin are marked with a `managed by opencode-repo-instructions` comment. The plugin never touches unmarked agent files (a user-defined agent with the same name wins), rewrites its own on changes, and removes them when the Copilot source disappears.
- Skills are embedded through the skill transform with their original `SKILL.md` path, so relative references resolve like a directory skill. Multi-file skills keep working as long as their assets live in the same Copilot skills directory.

## Installation

### From npm

Add the package to the `plugins` array of your `opencode.json` — opencode installs it automatically at startup (cached in `~/.cache/opencode/node_modules/`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-repo-instructions"]
}
```

Or from the CLI:

```sh
# project-scoped — updates ./opencode.json
opencode plugin add opencode-repo-instructions

# global — updates ~/.config/opencode/opencode.json
opencode plugin add -g opencode-repo-instructions
```

Project `opencode.json` → active for that repository only; global config (`~/.config/opencode/opencode.json`) → active for every repository.

### Build from source

The plugin is a single self-contained ES module with no runtime dependencies of its own (picomatch and the frontmatter parser are bundled; the V2 plugin API is provided by opencode at runtime and stays external to the bundle), so it can be loaded directly from a plugin directory:

```sh
# from a clone of this repository
git clone https://github.com/twostone/opencode-repo-instructions
cd opencode-repo-instructions
npm install
npm run build

# global (auto-discovered, applies to every repo)
cp dist/index.js ~/.config/opencode/plugins/repo-instructions.js

# or per-project
mkdir -p .opencode/plugins
cp dist/index.js .opencode/plugins/repo-instructions.js
```

Then restart opencode (plugins load at startup; changes under watched `plugins/` directories also reload automatically).

<details>
<summary>Installing without building</summary>

The TypeScript sources run as-is on recent Node/Bun runtimes with type stripping, but the bundled `dist/index.js` is the supported install artifact. If you want to reference the source directly instead, point opencode at `src/index.ts` via a `plugins` config entry — the build only exists to inline `picomatch` and normalize module imports.

</details>

## Options

Auto-discovered plugins from a `plugins/` directory take no options. To configure, reference the plugin explicitly in `opencode.json` as an object with `package` and `options`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-repo-instructions",
      "options": { "maxFileBytes": 262144 }
    }
  ]
}
```

The same works for a local file-based install: `{ "package": "~/.config/opencode/plugins/repo-instructions.js", "options": { ... } }`.

| Option | Default | Description |
| --- | --- | --- |
| `maxFileBytes` | `262144` | Per-file size cap; larger files are skipped with a warning |
| `includeVsCodeSettings` | `true` | Also read `github.copilot.chat.customInstructions` from VS Code user settings |
| `disabledSources` | `[]` | Source tags to skip, e.g. `["vscode", "global-instructions", "repo-skills", "global-skills", "repo-prompts", "global-prompts", "repo-agents", "global-agents", "instructions", "skills", "prompts", "agents", "repo-instructions"]` |
| `homeDir` | `os.homedir()` | Directory treated as `$HOME` for the `~/.copilot` lookups |
| `globalAgentsDir` | `$HOME/.config/opencode/agents` | Where global Copilot agents are materialized as managed agent files |

## How injection works

- **Always-on rules** (repo `copilot-instructions.md`, rules with `applyTo: '**'` or no pattern, VS Code custom instructions) are merged into the existing *last* system entry on every agent-loop model request via the session `context` hook, and re-supplied via the `compaction` hook, so they survive session compaction. The section is merged — not appended as a second system message — because some providers (vLLM / OpenAI-compatible) reject payloads with multiple system messages.
- **Path-scoped rules** are matched (picomatch) against the repo-relative path of `read`, `edit`, and `write` calls via the `tool.execute.before` hook and appended to that tool's output via `tool.execute.after` the first time they match in a session. A `session.compaction.ended` event clears the per-session state so rules can be re-injected afterwards.
- **Skills** are embedded through the V2 skill transform (`ctx.skill.transform`), which keeps them in memory (no extra files) while preserving the original `SKILL.md` path so relative references resolve.
- **Commands** are registered through the V2 command transform; invoking one resubmits the Copilot template as a user prompt with `$ARGUMENTS` / `$1…$n` placeholders expanded (falling back to appending the arguments when a template has no placeholder, as opencode does).
- **Agents** are written as managed Markdown agent files because the V2 plugin API cannot create agents programmatically — repo agents go to `.opencode/agents/`, global agents to the global agents directory. Files the plugin did not create are never overwritten.
- Existing user definitions are never overridden — the plugin only fills names/paths that are not already present.
- Logging goes to the opencode process stdout/stderr under a `repo-instructions` prefix (the V2 plugin context exposes no V1-style log service).

## Development

```sh
npm install
node --test test/      # unit tests (node's built-in runner)
npx tsc --noEmit       # typecheck
npm run build          # esbuild → dist/index.js (single file; node builtins + @opencode/plugin external)
```

## Releasing

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Push to `develop` with Conventional Commits (`feat:`, `fix:`, ...) — a release PR with the version bump and `CHANGELOG.md` is opened automatically.
2. Merge the release PR — release-please creates the GitHub Release and the `vX.Y.Z` tag, and the same run then builds the package and runs `npm stage publish` — the package is submitted to npm's [staged publishing](https://docs.npmjs.org/staged-publishing) area, not the live registry.
3. A maintainer reviews and approves the staged package (2FA) via the **Staged Packages** tab on npmjs.com or `npm stage approve <stage-id>`.

If the publish step fails after the release has already been created, re-run it via the **Publish to npm (manual)** workflow (Actions → workflow dispatch on the release tag), or locally with `npm ci && npm run typecheck && npm test && npm run build && npm stage publish`.

No manual version bumps or tags. CI needs the `NPM_TOKEN` repository secret. Note: the very first version had to go out with a plain `npm publish`, because staged publishing only works for packages that already exist on the registry.

## Example

Given a repository with:

```
.github/
  copilot-instructions.md          # "Always use tabs."
  instructions/ts.instructions.md  # ---\napplyTo: '**/*.ts'\n--- "Use strict mode."
  skills/lint-fix/SKILL.md
  prompts/deploy.prompt.md
  agents/reviewer.agent.md
```

- Every session starts with the "Always use tabs" rule in the system prompt.
- The "Use strict mode" rule appears in context the first time the agent reads or edits a `.ts` file.
- `lint-fix` shows up as an available skill, `/deploy` works as a slash command, and `reviewer` appears as a subagent (materialized in `.opencode/agents/`).
