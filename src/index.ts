import * as os from "node:os"
import * as path from "node:path"
import { promises as fsp } from "node:fs"
import type { Dirent } from "node:fs"
import { Plugin } from "@opencode/plugin"
import type { Skill } from "@opencode/plugin"
import { discover, type Discovered } from "./discovery.ts"
import { parseFrontmatter } from "./frontmatter.ts"
import { SessionState } from "./state.ts"

const PLUGIN_ID = "repo-instructions"
const FILE_TOOLS = new Set(["read", "edit", "write"])
const RELOAD_DEBOUNCE_MS = 300
/** Marker in agent files written by this plugin; managed files are only ever
 *  created/rewritten/removed when this marker is present. */
const MANAGED_MARKER = "<!-- managed by opencode-repo-instructions -->"

interface PluginSettings {
  maxFileBytes?: number
  includeVsCodeSettings?: boolean
  disabledSources?: string[]
  /** Override the directory treated as $HOME for global convention lookup (defaults to os.homedir()). */
  homeDir?: string
  /** Override the global agents directory (defaults to $HOME/.config/opencode/agents). */
  globalAgentsDir?: string
}

function readSettings(options: Readonly<Record<string, unknown>> | undefined): PluginSettings {
  return (options ?? {}) as PluginSettings
}

type LogLevel = "info" | "debug" | "warn" | "error"

function makeLogger() {
  return (level: LogLevel, message: string) => {
    const msg = `[${PLUGIN_ID}] ${message}`
    try {
      if (level === "debug") console.debug(msg)
      else if (level === "warn") console.warn(msg)
      else if (level === "error") console.error(msg)
      else console.log(msg)
    } catch {
      // logging must never break the plugin
    }
  }
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

interface SkillFile {
  id: string
  name: string
  description?: string
  path: string
  content: string
}

/**
 * Recursively reads SKILL.md files under a skills directory. The first skill
 * seen for a given id wins (discovery order: repo before global), mirroring
 * OpenCode's project-over-global skill precedence.
 */
async function collectSkillFiles(dir: string, out: Map<string, SkillFile>): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectSkillFiles(full, out)
    } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.toLowerCase() === "skill.md") {
      let raw: string
      try {
        raw = await fsp.readFile(full, "utf8")
      } catch {
        continue
      }
      const { frontmatter, body } = parseFrontmatter(raw)
      const fallback = path.basename(path.dirname(full))
      const id = (typeof frontmatter.name === "string" && frontmatter.name !== "" ? frontmatter.name : fallback).slice(
        0,
        64,
      )
      if (out.has(id)) continue
      out.set(id, {
        id,
        name: id,
        description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
        path: full,
        content: body.trim(),
      })
    }
  }
}

async function collectAllSkills(skillDirs: string[]): Promise<SkillFile[]> {
  const map = new Map<string, SkillFile>()
  for (const dir of skillDirs) {
    await collectSkillFiles(dir, map)
  }
  return [...map.values()]
}

/** True when the file was written by this plugin. */
async function isManagedFile(file: string): Promise<boolean> {
  try {
    return (await fsp.readFile(file, "utf8")).slice(0, 500).includes(MANAGED_MARKER)
  } catch {
    return false
  }
}

/**
 * Writes a managed agent file. A file at that path that is not marked as
 * managed is left untouched so the plugin never clobbers a user-defined agent.
 */
async function ensureAgentFile(file: string, description: string | undefined, prompt: string): Promise<void> {
  let exists = false
  try {
    await fsp.access(file)
    exists = true
  } catch {
    /* missing */
  }
  if (exists && !(await isManagedFile(file))) return
  const lines = ["---", MANAGED_MARKER]
  if (description) lines.push(`description: ${JSON.stringify(description)}`)
  lines.push("mode: subagent", "---", "", prompt.trim(), "")
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, lines.join("\n"), "utf8")
}

/**
 * Substitutes $ARGUMENTS (whole argument string) and $1..$n (positional args)
 * in a Copilot command template. Templates without any placeholder get the
 * arguments appended on a new line, matching OpenCode's fallback behavior.
 */
function expandTemplate(template: string, argsRaw: string): string {
  const trimmed = argsRaw.trim()
  if (trimmed === "") return template
  const parts = trimmed.split(/\s+/)
  let out = template
  if (out.includes("$ARGUMENTS")) out = out.replace(/\$ARGUMENTS/g, trimmed)
  // Descending so e.g. $11 is replaced before $1.
  for (let i = parts.length; i >= 1; i--) {
    out = out.split(`$${i}`).join(parts[i - 1])
  }
  if (/\$ARGUMENTS|\$\d/.test(out)) {
    // Unmatched placeholders (more positions than arguments): drop them.
    return out.replace(/\$(ARGUMENTS|\d+)/g, "").replace(/\s{2,}/g, " ").trim()
  }
  if (!/\$ARGUMENTS|\$\d/.test(template)) {
    return `${template.trim()}\n\n${trimmed}`
  }
  return out
}

const repoInstructions = Plugin.define({
  id: PLUGIN_ID,

  async setup(ctx) {
    const settings = readSettings(ctx.options as unknown as Record<string, unknown>)
    const log = makeLogger()
    const repoDir = ctx.location.directory
    const homeDir = settings.homeDir ?? os.homedir()
    const state = new SessionState()
    const disabled = (tag: string): boolean => (settings.disabledSources ?? []).includes(tag)

    const copilotDir = path.join(homeDir, ".copilot")
    const repoGithubDir = path.join(repoDir, ".github")
    const repoAgentsDir = path.join(repoDir, ".opencode", "agents")
    const globalAgentsDir = settings.globalAgentsDir ?? path.join(homeDir, ".config", "opencode", "agents")

    let rules: Discovered
    let skills: SkillFile[] = []
    let globalSection: string | null = null
    let reloadTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    /** Managed agent files created or refreshed by this plugin. */
    const managedAgentFiles = new Set<string>()

    /** Re-reads convention files and refreshes the data captured by the transforms. */
    const refresh = async (): Promise<void> => {
      rules = await discover({
        repoDir,
        homeDir,
        maxFileBytes: settings.maxFileBytes,
        includeVsCodeSettings: settings.includeVsCodeSettings,
        disabledSources: settings.disabledSources,
      })
      globalSection = buildGlobalSection(rules)
      skills = !disabled("skills") && rules.skillsDirs.length > 0 ? await collectAllSkills(rules.skillsDirs) : []
      for (const w of rules.warnings) log("warn", w)
      const summary = [
        rules.globals.length > 0 ? `${rules.globals.length} global rule(s)` : null,
        rules.scoped.length > 0 ? `${rules.scoped.length} scoped rule(s)` : null,
        skills.length > 0 ? `${skills.length} skill(s)` : null,
        rules.commands.length > 0 ? `${rules.commands.length} command(s)` : null,
        rules.agents.length > 0 ? `${rules.agents.length} agent(s)` : null,
      ]
        .filter(Boolean)
        .join(", ")
      log("info", summary === "" ? "No Copilot convention files found" : `Loaded: ${summary}`)
    }

    await refresh()

    // Register transforms once; they replay over the live data held in the
    // closure and are rebuilt via reload() when the files change.
    if (!disabled("prompts")) {
      await ctx.command.transform((editor) => {
        for (const c of rules.commands) {
          const template = c.template
          editor.add({
            name: c.name,
            description: c.description,
            execute: async ({ sessionID, prompt, delivery }) => {
              const text = expandTemplate(template, prompt.text)
              await ctx.session.prompt({
                sessionID,
                text,
                delivery,
              } as Parameters<typeof ctx.session.prompt>[0])
            },
          })
        }
      })
    }

    if (!disabled("skills")) {
      await ctx.skill.transform((editor) => {
        for (const s of skills) {
          // Skill.Info brands its id/name/path strings; the collected data is plain strings.
          editor.add({
            id: s.id,
            name: s.name,
            ...(s.description !== undefined ? { description: s.description } : {}),
            path: s.path,
            content: s.content,
          } as unknown as Skill.Info)
        }
      })
    }

    const syncAgents = async (): Promise<void> => {
      if (disabled("agents")) return
      const current = new Set<string>()
      for (const a of rules.agents) {
        const tag = a.source === "global" ? "global-agents" : "repo-agents"
        if (disabled(tag)) continue
        const dir = a.source === "global" ? globalAgentsDir : repoAgentsDir
        const file = path.join(dir, `${a.name}.md`)
        current.add(file)
        try {
          await ensureAgentFile(file, a.description, a.prompt)
          managedAgentFiles.add(file)
        } catch (err) {
          log("warn", `Could not write agent file ${file}: ${String(err)}`)
        }
      }
      // Remove managed agent files that are no longer discovered.
      for (const file of managedAgentFiles) {
        if (current.has(file)) continue
        managedAgentFiles.delete(file)
        try {
          await fsp.rm(file)
        } catch {
          /* best effort */
        }
      }
    }

    await syncAgents()

    const maybeReload = (file: string) => {
      const relevant = file.startsWith(repoGithubDir + path.sep) || file.startsWith(copilotDir + path.sep)
      if (!relevant) return
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(async () => {
        reloadTimer = null
        if (disposed) return
        try {
          await refresh()
          await syncAgents()
          if (!disabled("prompts")) await ctx.command.reload()
          if (!disabled("skills")) await ctx.skill.reload()
          log("debug", `Reloaded instruction files after change to ${file}`)
        } catch (err) {
          log("warn", `Reload failed: ${String(err)}`)
        }
      }, RELOAD_DEBOUNCE_MS)
    }

    // ---- Session hooks -----------------------------------------------------------

    // Always-on rules are merged into the LAST system entry, not appended as a
    // second message: some providers (vLLM / OpenAI-compatible) reject payloads
    // with more than one system message.
    await ctx.session.hook("context", (event) => {
      const section = globalSection
      if (!section) return
      const system = event.system
      if (system.length === 0) {
        system.push({ type: "text", text: section })
        return
      }
      const last = system[system.length - 1]
      if (typeof last === "string") {
        system[system.length - 1] = { type: "text", text: last + "\n\n" + section }
      } else {
        Object.assign(last as { text: string }, { text: (last as { text: string }).text + "\n\n" + section })
      }
    })

    // Re-supply the global rules when a session compacts, so they survive
    // compaction the same way they survive model requests.
    await ctx.session.hook("compaction", (event) => {
      const section = globalSection
      if (!section) return
      event.messages.push({
        role: "user",
        content: [{ type: "text", text: section }],
      } as unknown as (typeof event.messages)[number])
    })

    // ---- Tool hooks ---------------------------------------------------------------

    // Path-scoped rules are queued when a matching file is about to be touched,
    // then appended to the tool output — once per session per rule.
    await ctx.tool.hook("execute.before", (event) => {
      if (!FILE_TOOLS.has(event.tool)) return
      const filePath = (event.input as { filePath?: unknown } | undefined)?.filePath
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
        if (state.isInjected(event.sessionID, rule.id)) continue
        if (rule.matcher(rel)) {
          matched.push(rule.id)
          state.markInjected(event.sessionID, rule.id)
        }
      }
      if (matched.length === 0) return
      const text = buildScopedInjection(current, matched)
      if (text) {
        state.setPending(event.id, text)
        log("debug", `Queued ${matched.length} scoped rule(s) for ${rel}`)
      }
    })

    await ctx.tool.hook("execute.after", (event) => {
      const text = state.consumePending(event.id)
      if (!text) return
      if (event.status !== "completed") return // failed tool: nothing to append to
      const result = event.result as { content?: string | readonly unknown[] }
      if (typeof result.content === "string") {
        ;(result as { content: string }).content += `\n\n${text}`
      } else {
        const existing = Array.isArray(result.content) ? [...result.content] : []
        ;(result as { content: unknown[] }).content = [...existing, { type: "text", text }]
      }
    })

    // ---- Event subscription --------------------------------------------------------

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (disposed) return
          if (event.type === "session.compaction.ended") {
            const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID
            if (sessionID) state.clearSession(sessionID)
            continue
          }
          if (event.type === "filesystem.changed") {
            const file = (event as { data?: { file?: string } }).data?.file
            if (typeof file === "string") maybeReload(file)
          }
        }
      } catch {
        /* subscription ended (cleanup aborted the signal) */
      }
    })()

    return () => {
      disposed = true
      controller.abort()
      if (reloadTimer) clearTimeout(reloadTimer)
    }
  },
})

export { repoInstructions }
export default repoInstructions
