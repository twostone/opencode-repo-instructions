import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { RepoInstructionsPlugin } from "../src/index.ts"

interface Fixture {
  repo: string
  home: string
  base: string
}

async function makeFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), "ri-plugin-"))
  const repo = path.join(base, "repo")
  const home = path.join(base, "home")
  await mkdir(path.join(repo, ".github", "instructions"), { recursive: true })
  await mkdir(path.join(repo, ".github", "prompts"), { recursive: true })
  await mkdir(path.join(repo, ".github", "agents"), { recursive: true })
  await mkdir(path.join(repo, ".github", "skills", "repo-skill"), { recursive: true })
  await mkdir(path.join(repo, "src"), { recursive: true })
  await mkdir(path.join(home, ".copilot", "instructions"), { recursive: true })
  await mkdir(path.join(home, ".copilot", "skills", "home-skill"), { recursive: true })

  await writeFile(path.join(repo, ".github", "copilot-instructions.md"), "Always use tabs in this repo.")
  await writeFile(path.join(repo, ".github", "instructions", "ts.instructions.md"), "---\napplyTo: '**/*.ts'\n---\nUse strict TypeScript.")
  await writeFile(path.join(repo, ".github", "prompts", "deploy.prompt.md"), "---\ndescription: Deploys\n---\nDeploy $ARGUMENTS.")
  await writeFile(path.join(repo, ".github", "agents", "reviewer.agent.md"), "---\nname: code-reviewer\ndescription: Reviews code\n---\nYou are a reviewer.")
  await writeFile(path.join(repo, ".github", "skills", "repo-skill", "SKILL.md"), "---\nname: repo-skill\ndescription: s\n---\nbody")
  await writeFile(path.join(home, ".copilot", "instructions", "dev.instructions.md"), "---\napplyTo: '**'\n---\nGlobal dev rule.")
  await writeFile(path.join(home, ".copilot", "skills", "home-skill", "SKILL.md"), "---\nname: home-skill\ndescription: s\n---\nbody")
  return { repo, home, base }
}

function makeCtx(repo: string) {
  const ctx = {
    directory: repo,
    worktree: repo,
    project: { id: "p1", name: "test", worktree: repo, vcs: "" },
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as never,
    client: { app: { log: async () => {} } },
    experimental_workspace: { register: () => {} },
  } as unknown as PluginInput
  return ctx
}

test("system prompt contains global rules (repo + global)", async () => {
  const { repo, home, base } = await makeFixture()
  try {
    const hooks = await RepoInstructionsPlugin(makeCtx(repo), { homeDir: home, includeVsCodeSettings: false })
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({} as never, output as never)
    const joined = output.system.join("\n")
    assert.match(joined, /Always use tabs in this repo\./)
    assert.match(joined, /Global dev rule\./)
    assert.match(joined, /repo\/copilot-instructions\.md/)
    assert.match(joined, /global\/instructions\/dev\.instructions\.md/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("scoped rule injected on file access, once per session", async () => {
  const { repo, home, base } = await makeFixture()
  try {
    const hooks = await RepoInstructionsPlugin(makeCtx(repo), { homeDir: home, includeVsCodeSettings: false })
    const file = path.join(repo, "src", "a.ts")

    const before1 = { args: { filePath: file } }
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "s1", callID: "c1" }, before1 as never)
    const after1 = { title: "", output: "file contents", metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "s1", callID: "c1", args: {} }, after1 as never)
    assert.match(after1.output, /Path-Specific Instructions/)
    assert.match(after1.output, /Use strict TypeScript\./)
    assert.match(after1.output, /repo-instructions:repo\/.github\/instructions\/ts\.instructions\.md/)

    // Second access to a matching file: no re-injection
    const before2 = { args: { filePath: path.join(repo, "src", "b.ts") } }
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "s1", callID: "c2" }, before2 as never)
    const after2 = { title: "", output: "contents2", metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "s1", callID: "c2", args: {} }, after2 as never)
    assert.equal(after2.output, "contents2")

    // Non-matching file: no injection
    const before3 = { args: { filePath: path.join(repo, "src", "a.go") } }
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "s1", callID: "c3" }, before3 as never)
    const after3 = { title: "", output: "gostuff", metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "s1", callID: "c3", args: {} }, after3 as never)
    assert.equal(after3.output, "gostuff")

    // Non-file tool is ignored
    const before4 = { args: { command: "ls src/a.ts" } }
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s1", callID: "c4" }, before4 as never)
    const after4 = { title: "", output: "ls-out", metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s1", callID: "c4", args: {} }, after4 as never)
    assert.equal(after4.output, "ls-out")
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("compaction clears injection state so scoped rules can be re-injected", async () => {
  const { repo, home, base } = await makeFixture()
  try {
    const hooks = await RepoInstructionsPlugin(makeCtx(repo), { homeDir: home, includeVsCodeSettings: false })
    const file = path.join(repo, "src", "a.ts")
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "s1", callID: "c1" }, { args: { filePath: file } } as never)
    const after1 = { title: "", output: "x", metadata: {} }
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "s1", callID: "c1", args: {} }, after1 as never)
    assert.match(after1.output, /Use strict TypeScript\./)

    await hooks.event!({ event: { type: "session.compacted", properties: { sessionID: "s1" } } } as never)

    const after2 = { title: "", output: "x2", metadata: {} }
    await hooks["tool.execute.before"]!({ tool: "edit", sessionID: "s1", callID: "c2" }, { args: { filePath: file } } as never)
    await hooks["tool.execute.after"]!({ tool: "edit", sessionID: "s1", callID: "c2", args: {} }, after2 as never)
    assert.match(after2.output, /Use strict TypeScript\./)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("config hook registers skills dirs, commands and agents without overriding", async () => {
  const { repo, home, base } = await makeFixture()
  try {
    const hooks = await RepoInstructionsPlugin(makeCtx(repo), { homeDir: home, includeVsCodeSettings: false })
    const cfg: Record<string, any> = {
      command: { existing: { template: "keep me" } },
      agent: { existing: { mode: "subagent" } },
    }
    await hooks.config!(cfg as never)

    assert.deepEqual(cfg.skills.paths, [
      path.join(repo, ".github", "skills"),
      path.join(home, ".copilot", "skills"),
    ])
    assert.deepEqual(cfg.command.existing, { template: "keep me" })
    assert.ok(cfg.command.deploy)
    assert.match(cfg.command.deploy.template, /Deploy \$ARGUMENTS/)
    assert.deepEqual(cfg.agent.existing, { mode: "subagent" })
    assert.ok(cfg.agent["code-reviewer"])
    assert.equal(cfg.agent["code-reviewer"].mode, "subagent")
    assert.match(cfg.agent["code-reviewer"].prompt, /reviewer/)

    // Idempotent: running again does not duplicate
    await hooks.config!(cfg as never)
    assert.equal(cfg.skills.paths.length, 2)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("compacting hook re-injects global rules", async () => {
  const { repo, home, base } = await makeFixture()
  try {
    const hooks = await RepoInstructionsPlugin(makeCtx(repo), { homeDir: home, includeVsCodeSettings: false })
    const output = { context: [] as string[] }
    await hooks["experimental.session.compacting"]!({ sessionID: "s1" }, output as never)
    assert.match(output.context.join("\n"), /Always use tabs in this repo\./)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("no convention files: nothing is injected", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ri-none-"))
  const repo = path.join(base, "repo")
  const home = path.join(base, "home")
  await mkdir(repo, { recursive: true })
  await mkdir(home, { recursive: true })
  try {
    const hooks = await RepoInstructionsPlugin(makeCtx(repo), { homeDir: home, includeVsCodeSettings: false })
    const sys = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({} as never, sys as never)
    assert.equal(sys.system.length, 0)
    const cfg: Record<string, any> = {}
    await hooks.config!(cfg as never)
    assert.equal(cfg.skills, undefined)
    assert.equal(cfg.command, undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
