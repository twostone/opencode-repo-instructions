import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { asPatternList, parseFrontmatter } from "./frontmatter.ts"
import { createMatcher, isMatchAll, type FileMatcher } from "./matcher.ts"

export interface GlobalRule {
  id: string
  source: "repo" | "global"
  file: string
  content: string
}

export interface ScopedRule {
  id: string
  source: "repo" | "global"
  file: string
  content: string
  patterns: string[]
  matcher: FileMatcher
}

export interface CommandDef {
  name: string
  description?: string
  template: string
}

export interface AgentDef {
  name: string
  description?: string
  prompt: string
}

export interface Discovered {
  globals: GlobalRule[]
  scoped: ScopedRule[]
  skillsDirs: string[]
  commands: CommandDef[]
  agents: AgentDef[]
  warnings: string[]
}

export interface DiscoveryOptions {
  repoDir: string
  homeDir?: string
  maxFileBytes?: number
  includeVsCodeSettings?: boolean
  disabledSources?: string[]
}

export const DEFAULT_MAX_FILE_BYTES = 256 * 1024

const NATIVE_FILES = new Set(["AGENTS.md", "CLAUDE.md", "agents.md", "claude.md"])

interface Loader {
  out: Discovered
  maxBytes: number
  disabled: Set<string>
  /** directory used to compute stable relative rule ids */
  idBase: string
}

function isDisabled(loader: Loader, tag: string): boolean {
  return loader.disabled.has(tag)
}

async function readFileSafe(file: string, loader: Loader): Promise<string | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return null
    if (stat.size > loader.maxBytes) {
      loader.out.warnings.push(`Skipped ${file}: ${stat.size} bytes exceeds maxFileBytes (${loader.maxBytes})`)
      return null
    }
    return await fs.readFile(file, "utf8")
  } catch {
    return null
  }
}

async function listMdFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    // isFile() is false for symlinks; readFileSafe() resolves the target
    // and rejects anything that is not a regular file, so accept both.
    return entries
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && e.name.toLowerCase().endsWith(".md"))
      .map((e) => path.join(dir, e.name))
      .sort()
  } catch {
    return []
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Loads `.md` instruction files from a directory. Files with `applyTo`
 * (or `globs`) frontmatter become scoped rules; match-all or missing
 * patterns become global rules.
 */
async function loadInstructionDir(
  dir: string,
  source: "repo" | "global",
  tag: string,
  loader: Loader,
): Promise<void> {
  if (isDisabled(loader, tag) || isDisabled(loader, "instructions")) return
  const files = await listMdFiles(dir)
  for (const file of files) {
    const base = path.basename(file)
    if (NATIVE_FILES.has(base)) continue
    const raw = await readFileSafe(file, loader)
    if (raw === null) continue
    const { frontmatter, body } = parseFrontmatter(raw)
    const patterns = asPatternList(frontmatter.applyTo ?? frontmatter.globs)
    const content = body.trim()
    if (content === "") continue
    const id = `${source}/${path.relative(loader.idBase, file)}`
    if (patterns.length === 0 || isMatchAll(patterns)) {
      loader.out.globals.push({ id, source, file, content })
    } else {
      loader.out.scoped.push({
        id,
        source,
        file,
        content,
        patterns,
        matcher: createMatcher(patterns),
      })
    }
  }
}

async function loadPromptDir(dir: string, tag: string, loader: Loader): Promise<void> {
  if (isDisabled(loader, tag) || isDisabled(loader, "prompts")) return
  const files = await listMdFiles(dir)
  for (const file of files) {
    const raw = await readFileSafe(file, loader)
    if (raw === null) continue
    const { frontmatter, body } = parseFrontmatter(raw)
    const template = body.trim()
    if (template === "") continue
    const base = path.basename(file)
    const fallback = base.replace(/\.prompt\.md$/i, "").replace(/\.md$/i, "")
    const name = typeof frontmatter.name === "string" && frontmatter.name !== "" ? frontmatter.name : fallback
    const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined
    loader.out.commands.push({ name: sanitizeName(name), description, template })
  }
}

async function loadAgentDir(dir: string, tag: string, loader: Loader): Promise<void> {
  if (isDisabled(loader, tag) || isDisabled(loader, "agents")) return
  const files = await listMdFiles(dir)
  for (const file of files) {
    const raw = await readFileSafe(file, loader)
    if (raw === null) continue
    const { frontmatter, body } = parseFrontmatter(raw)
    const prompt = body.trim()
    if (prompt === "") continue
    const base = path.basename(file)
    const fallback = base.replace(/\.agent\.md$/i, "").replace(/\.md$/i, "")
    const name = typeof frontmatter.name === "string" && frontmatter.name !== "" ? frontmatter.name : fallback
    const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined
    loader.out.agents.push({ name: sanitizeName(name), description, prompt })
  }
}

function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

async function loadSkillsDir(dir: string, tag: string, loader: Loader): Promise<void> {
  if (isDisabled(loader, tag) || isDisabled(loader, "skills")) return
  if (await dirExists(dir)) loader.out.skillsDirs.push(dir)
}

function vscodeSettingsPaths(homeDir: string): string[] {
  const platform = os.platform()
  if (platform === "darwin") {
    return ["Code", "Code - Insiders", "Code - OSS"].map((v) =>
      path.join(homeDir, "Library", "Application Support", v, "User", "settings.json"),
    )
  }
  if (platform === "win32") {
    const appdata = process.env.APPDATA
    if (!appdata) return []
    return [
      path.join(appdata, "Code", "User", "settings.json"),
      path.join(appdata, "Code - Insiders", "User", "settings.json"),
    ]
  }
  return ["Code", "Code - Insiders"].map((v) => path.join(homeDir, ".config", v, "User", "settings.json"))
}

async function loadVsCodeSettings(homeDir: string, loader: Loader): Promise<void> {
  if (isDisabled(loader, "vscode") || isDisabled(loader, "instructions")) return
  for (const file of vscodeSettingsPaths(homeDir)) {
    let raw: string | null = null
    try {
      raw = await fs.readFile(file, "utf8")
    } catch {
      continue
    }
    try {
      const settings = JSON.parse(raw)
      const value = settings?.["github.copilot.chat.customInstructions"]
      if (typeof value === "string" && value.trim() !== "") {
        loader.out.globals.push({
          id: "global/vscode-custom-instructions",
          source: "global",
          file,
          content: value.trim(),
        })
        break
      }
    } catch {
      loader.out.warnings.push(`Failed to parse ${file}`)
    }
  }
}

export async function discover(opts: DiscoveryOptions): Promise<Discovered> {
  const homeDir = opts.homeDir ?? os.homedir()
  const repo = path.resolve(opts.repoDir)
  const repoGithub = path.join(repo, ".github")
  const globalCopilot = path.join(homeDir, ".copilot")

  const loader: Loader = {
    out: { globals: [], scoped: [], skillsDirs: [], commands: [], agents: [], warnings: [] },
    maxBytes: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    disabled: new Set(opts.disabledSources ?? []),
    idBase: repo,
  }

  // Repo-wide Copilot instructions file
  if (!isDisabled(loader, "repo-instructions") && !isDisabled(loader, "instructions")) {
    const file = path.join(repoGithub, "copilot-instructions.md")
    const raw = await readFileSafe(file, loader)
    if (raw !== null) {
      const { body } = parseFrontmatter(raw)
      const content = body.trim()
      if (content !== "") {
        loader.out.globals.push({ id: "repo/copilot-instructions.md", source: "repo", file, content })
      }
    }
  }

  await loadInstructionDir(path.join(repoGithub, "instructions"), "repo", "repo-instructions", { ...loader })
  await loadPromptDir(path.join(repoGithub, "prompts"), "repo-prompts", loader)
  await loadAgentDir(path.join(repoGithub, "agents"), "repo-agents", loader)
  await loadSkillsDir(path.join(repoGithub, "skills"), "repo-skills", loader)

  await loadInstructionDir(path.join(globalCopilot, "instructions"), "global", "global-instructions", {
    ...loader,
    idBase: globalCopilot,
  })
  await loadPromptDir(path.join(globalCopilot, "prompts"), "global-prompts", loader)
  await loadAgentDir(path.join(globalCopilot, "agents"), "global-agents", loader)
  await loadSkillsDir(path.join(globalCopilot, "skills"), "global-skills", loader)

  if (opts.includeVsCodeSettings !== false) {
    await loadVsCodeSettings(homeDir, loader)
  }

  dedupeCommandsAndAgents(loader.out)
  return loader.out
}

function dedupeCommandsAndAgents(out: Discovered): void {
  const seenCommands = new Set<string>()
  out.commands = out.commands.filter((c) => {
    if (seenCommands.has(c.name)) return false
    seenCommands.add(c.name)
    return true
  })
  const seenAgents = new Set<string>()
  out.agents = out.agents.filter((a) => {
    if (seenAgents.has(a.name)) return false
    seenAgents.add(a.name)
    return true
  })
}
