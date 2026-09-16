import * as os from "node:os"
import * as path from "node:path"
import type { Hooks, Plugin, PluginOptions } from "@opencode-ai/plugin"
import { discover, type Discovered } from "./discovery.ts"
import { SessionState } from "./state.ts"

const SERVICE = "repo-instructions"
const FILE_TOOLS = new Set(["read", "edit", "write"])
const RELOAD_DEBOUNCE_MS = 300

interface PluginSettings {
  maxFileBytes?: number
  includeVsCodeSettings?: boolean
  disabledSources?: string[]
  /** Override the directory treated as $HOME for global convention lookup (defaults to os.homedir()). */
  homeDir?: string
}

function readSettings(options?: PluginOptions): PluginSettings {
  return (options ?? {}) as PluginSettings
}

function buildGlobalSection(d: Discovered): string | null {
  if (d.globals.length === 0) return null
  const parts = d.globals.map((g) => `### ${g.id}\n${g.content}`)
  return [
    "<repo-instructions:global>",
    "Repository and global custom instructions loaded from GitHub Copilot convention files.",
    "Treat the rules below as mandatory project requirements.",
    "",
    ...parts,
    "</repo-instructions:global>",
  ].join("\n\n")
}

function buildScopedInjection(d: Discovered, ruleIds: string[]): string | null {
  const rules = d.scoped.filter((r) => ruleIds.includes(r.id))
  if (rules.length === 0) return null
  const parts = rules.map(
    (r) =>
      `<repo-instructions:${r.id}>\n## Path-Specific Instructions (applies to: ${r.patterns.join(", ")})\n\n${r.content}\n</repo-instructions:${r.id}>`,
  )
  return parts.join("\n\n")
}

function eventFilePath(event: { type: string; properties?: unknown }): string | undefined {
  const p = event.properties
  if (!p || typeof p !== "object") return undefined
  const obj = p as Record<string, unknown>
  if (typeof obj.file === "string") return obj.file
  if (typeof obj.path === "string") return obj.path
  const file = obj.file
  if (file && typeof file === "object" && typeof (file as Record<string, unknown>).path === "string") {
    return (file as Record<string, unknown>).path as string
  }
  return undefined
}

export const RepoInstructionsPlugin: Plugin = async (input, options) => {
  const { directory, client } = input
  const settings = readSettings(options)
  const repoDir = directory
  const state = new SessionState()

  let rules: Discovered | null = null
  let globalSection: string | null = null
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const log = (message: string, level: "info" | "debug" | "warn" | "error" = "info") => {
    if (disposed) return
    try {
      void Promise.resolve(client.app.log({ body: { service: SERVICE, level, message } })).catch(() => {})
    } catch {
      // logging must never break the plugin
    }
  }

  const load = async () => {
    const d = await discover({
      repoDir,
      homeDir: settings.homeDir,
      maxFileBytes: settings.maxFileBytes,
      includeVsCodeSettings: settings.includeVsCodeSettings,
      disabledSources: settings.disabledSources,
    })
    rules = d
    globalSection = buildGlobalSection(d)
    if (d.warnings.length > 0) {
      for (const w of d.warnings) log(w, "warn")
    }
    const summary = [
      d.globals.length > 0 ? `${d.globals.length} global rule(s)` : null,
      d.scoped.length > 0 ? `${d.scoped.length} scoped rule(s)` : null,
      d.skillsDirs.length > 0 ? `${d.skillsDirs.length} skill dir(s)` : null,
      d.commands.length > 0 ? `${d.commands.length} command(s)` : null,
      d.agents.length > 0 ? `${d.agents.length} agent(s)` : null,
    ]
      .filter(Boolean)
      .join(", ")
    log(summary === "" ? "No Copilot convention files found" : `Loaded: ${summary}`)
    return d
  }

  const d = await load()

  const applyToConfig = async (cfg: Record<string, any>): Promise<void> => {
    try {
      const skills = (cfg.skills ?? null) as { paths?: string[] } | null
      if (d.skillsDirs.length > 0) {
        const existing: string[] = Array.isArray(skills?.paths) ? [...skills.paths] : []
        const missing = d.skillsDirs.filter(
          (dir) => !existing.some((p) => p === dir || path.resolve(p) === path.resolve(dir)),
        )
        if (missing.length > 0) {
          cfg.skills = { ...(skills ?? {}), paths: [...existing, ...missing] }
        }
      }
      if (d.commands.length > 0) {
        const existingCommands = (cfg.command ?? null) as Record<string, unknown> | null
        const merged = { ...(existingCommands ?? {}) }
        for (const c of d.commands) {
          if (!merged[c.name]) {
            merged[c.name] = { description: c.description, template: c.template }
          }
        }
        cfg.command = merged
      }
      if (d.agents.length > 0) {
        const existingAgents = (cfg.agent ?? null) as Record<string, unknown> | null
        const merged = { ...(existingAgents ?? {}) }
        for (const a of d.agents) {
          if (!merged[a.name]) {
            merged[a.name] = { description: a.description, mode: "subagent", prompt: a.prompt }
          }
        }
        cfg.agent = merged
      }
    } catch (err) {
      log(`Failed to apply config changes: ${String(err)}`, "warn")
    }
  }

  const copilotDir = path.join(settings.homeDir ?? os.homedir(), ".copilot")
  const repoGithubDir = path.join(repoDir, ".github")
  const maybeReload = (file: string) => {
    const relevant =
      file.startsWith(repoGithubDir + path.sep) || file.startsWith(copilotDir + path.sep)
    if (!relevant) return
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(async () => {
      reloadTimer = null
      try {
        await load()
        log(`Reloaded instruction files after change to ${file}`, "debug")
      } catch (err) {
        log(`Reload failed: ${String(err)}`, "warn")
      }
    }, RELOAD_DEBOUNCE_MS)
  }

  const hooks: Hooks = {
    config: async (cfg) => {
      await applyToConfig(cfg as unknown as Record<string, any>)
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (!globalSection) return
      // Merge into the existing system entry: some providers (vLLM/OpenAI-
      // compatible) reject payloads with more than one system message.
      if (output.system.length === 0) {
        output.system.push(globalSection)
      } else {
        output.system[output.system.length - 1] += "\n\n" + globalSection
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      if (globalSection) {
        output.context.push(globalSection)
      }
    },

    "tool.execute.before": async (toolInput, toolOutput) => {
      if (!FILE_TOOLS.has(toolInput.tool)) return
      const filePath = toolOutput.args?.filePath
      if (typeof filePath !== "string" || filePath === "") return
      let rel: string
      if (path.isAbsolute(filePath)) {
        rel = path.relative(repoDir, filePath)
        if (rel === "" || rel.startsWith("..")) return
      } else {
        rel = filePath
      }
      const current = rules
      if (!current) return
      const matched: string[] = []
      for (const rule of current.scoped) {
        if (state.isInjected(toolInput.sessionID, rule.id)) continue
        if (rule.matcher(rel)) {
          matched.push(rule.id)
          state.markInjected(toolInput.sessionID, rule.id)
        }
      }
      if (matched.length === 0) return
      const text = buildScopedInjection(current, matched)
      if (text) {
        state.setPending(toolInput.callID, text)
        log(`Queued ${matched.length} scoped rule(s) for ${rel}`, "debug")
      }
    },

    "tool.execute.after": async (toolInput, toolOutput) => {
      const text = state.consumePending(toolInput.callID)
      if (text) {
        toolOutput.output = `${toolOutput.output}\n\n${text}`
        log(`Injected scoped rules for call ${toolInput.callID}`, "debug")
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.compacted") {
        const props = event.properties as { sessionID?: string } | undefined
        if (props?.sessionID) state.clearSession(props.sessionID)
        return
      }
      if (event.type === "file.watcher.updated" || event.type === "file.edited") {
        const file = eventFilePath(event)
        if (file) maybeReload(file)
      }
    },
  }

  return hooks
}

export default RepoInstructionsPlugin
