# opencode-repo-instructions

An [opencode](https://opencode.ai) plugin that loads GitHub Copilot convention files — repository- and user-level instructions, skills, prompts, and agents — and injects them into opencode's context. The same files Copilot reads in VS Code now drive opencode, with no manual `AGENTS.md` duplication.

## What it loads

| Source (relative to repo root unless noted) | Kind | How it's provided to opencode |
| --- | --- | --- |
| `.github/copilot-instructions.md` | always-on rule | system prompt, re-injected on compaction |
| `.github/instructions/*.md` | path-scoped rule (`applyTo` / `globs` frontmatter) | injected into tool output on first `read`/`edit`/`write` of a matching file |
| `~/.copilot/instructions/*.md` | global rule (same semantics as above) | same as above |
| `.github/skills/**/SKILL.md` | skill | registered with opencode's native skill system |
| `~/.copilot/skills/**/SKILL.md` | user-level skill | registered with opencode's native skill system |
| `.github/prompts/*.prompt.md` | custom prompt | registered as an opencode command |
| `~/.copilot/prompts/*.prompt.md` | user-level prompt | registered as an opencode command |
| `.github/agents/*.agent.md` | custom agent | registered as an opencode subagent |
| `~/.copilot/agents/*.agent.md` | user-level agent | registered as an opencode subagent |
| VS Code `github.copilot.chat.customInstructions` | user-level free text | system prompt |

Notes:

- `applyTo` accepts a quoted string, comma list, inline list, or block list: `applyTo: '**/*.ts,**/*.tsx'`. A match-all pattern (`**`) is treated as an always-on rule.
- Symlinked instruction files are supported (broken symlinks are ignored).
- `AGENTS.md` and `CLAUDE.md` are intentionally ignored — opencode loads those natively, so the plugin never double-injects them.
- Changed rule files are re-read live (debounced) via opencode's file watcher; no restart needed.
- Files above 256 KB are skipped with a warning in the opencode logs.

## Installation

The plugin is a single self-contained ES module with no runtime dependencies (picomatch and the frontmatter parser are bundled), so it can be loaded directly from the plugin directory:

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

Then restart opencode (plugins load at startup).

<details>
<summary>Installing without building</summary>

The TypeScript sources run as-is on recent Node/Bun runtimes with type stripping, but the bundled `dist/index.js` is the supported install artifact. If you want to reference the source directly instead, point opencode at `src/index.ts` via a `plugin` config entry — the build only exists to inline `picomatch` and normalize module imports.

</details>

## Options

Auto-discovered plugins from a `plugins/` directory take no options. To configure, reference the file explicitly in `opencode.json`:

```json
{
  "plugin": [
    ["~/.config/opencode/plugins/repo-instructions.js", { "maxFileBytes": 262144 }]
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `maxFileBytes` | `262144` | Per-file size cap; larger files are skipped with a log warning |
| `includeVsCodeSettings` | `true` | Also read `github.copilot.chat.customInstructions` from VS Code user settings |
| `disabledSources` | `[]` | Source tags to skip, e.g. `["vscode", "global-instructions", "repo-skills", "global-skills", "repo-prompts", "global-prompts", "repo-agents", "global-agents", "instructions", "skills", "prompts", "agents", "repo-instructions"]` |
| `homeDir` | `os.homedir()` | Directory treated as `$HOME` for the `~/.copilot` lookups |

## How injection works

- **Always-on rules** (repo `copilot-instructions.md`, rules with `applyTo: '**'` or no pattern, VS Code custom instructions) are merged into the existing system prompt entry on every LLM call and re-supplied via the compaction hook, so they survive session compaction. The section is merged — not appended as a second system message — because some providers (vLLM / OpenAI-compatible) reject payloads with multiple system messages.
- **Path-scoped rules** are matched (picomatch) against the repo-relative path of `read`, `edit`, and `write` calls and appended to that tool's output the first time they match in a session. Compaction clears the per-session state so rules can be re-injected afterwards.
- **Skills, commands, and agents** are registered through opencode's `config` hook (`skills.paths`, `command`, `agent`), so they behave exactly like natively defined ones: skills get progressive disclosure, commands are invokable as slash commands, agents appear in `opencode agent list`.
- Existing user definitions are never overridden — the plugin only fills names/paths that are not already present.
- All logging goes through opencode's log service under `service: "repo-instructions"`.

## Development

```sh
npm install
node --test test/      # unit tests (node's built-in runner)
npx tsc --noEmit       # typecheck
npm run build          # esbuild → dist/index.js (single file, node builtins external)
```

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
- `lint-fix` shows up as an available skill, `/deploy` works as a slash command, and `reviewer` is selectable via `--agent` or the task tool.
