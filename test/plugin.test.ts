import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { repoInstructions } from "../src/index.ts"

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
  await mkdir(path.join(home, ".copilot", "agents"), { recursive: true })
  await mkdir(path.join(home, ".copilot", "skills", "home-skill"), { recursive: true })

  await writeFile(path.join(repo, ".github", "copilot-instructions.md"), "Always use tabs in this repo.")
  await writeFile(path.join(repo, ".github", "instructions", "ts.instructions.md"), "---\napplyTo: '**/*.ts'\n---\nUse strict TypeScript.")
  await writeFile(path.join(repo, ".github", "prompts", "deploy.prompt.md"), "---\ndescription: Deploys\n---\nDeploy $ARGUMENTS.")
  await writeFile(path.join(repo, ".github", "prompts", "greet.prompt.md"), "Hi $1 and $2.")
  await writeFile(
    path.join(repo, ".github", "agents", "reviewer.agent.md"),
    "---\nname: code-reviewer\ndescription: Reviews code\n---\nYou are a reviewer.",
  )
  await writeFile(
    path.join(repo, ".github", "agents", "linter.agent.md"),
    "---\nname: linter\ndescription: Lints\n---\nYou are a linter.",
  )
  await writeFile(
    path.join(repo, ".github", "skills", "repo-skill", "SKILL.md"),
    "---\nname: repo-skill\ndescription: s\n---\nbody",
  )
  await writeFile(path.join(home, ".copilot", "instructions", "dev.instructions.md"), "---\napplyTo: '**'\n---\nGlobal dev rule.")
  await writeFile(
    path.join(home, ".copilot", "agents", "owner.agent.md"),
    "---\nname: global-owner\ndescription: Owns\n---\nYou are a global owner.",
  )
  await writeFile(path.join(home, ".copilot", "skills", "home-skill", "SKILL.md"), "---\nname: home-skill\ndescription: s\n---\nbody")
  return { repo, home, base }
}

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// --- Minimal V2 plugin context double ------------------------------------------------

class EventQueue {
  private items: unknown[] = []
  private waiters: Array<(item: unknown) => void> = []

  push(item: unknown): void {
    const w = this.waiters.shift()
    if (w) w(item)
    else this.items.push(item)
  }

  next(signal?: AbortSignal): Promise<unknown> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift()!)
    if (signal?.aborted) return Promise.resolve(null)
    return new Promise((resolve) => {
      const waiter = (item: unknown) => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        resolve(item)
      }
      this.waiters.push(waiter)
      signal?.addEventListener("abort", () => waiter(null), { once: true })
    })
  }
}

interface FakeCtx {
  location: { directory: string }
  options: Record<string, unknown>
  command: {
    registry: Map<string, { name: string; description?: string; execute: (i: unknown) => Promise<void> }>
    transform(cb: (editor: { add: (d: never) => void }) => void): Promise<{ dispose: () => Promise<void> }>
    reload(): Promise<void>
  }
  skill: {
    registry: Map<string, { id: string; name: string; description?: string; path: string; content: string }>
    transform(cb: (editor: { add: (d: never) => void }) => void): Promise<{ dispose: () => Promise<void> }>
    reload(): Promise<void>
  }
  session: {
    prompts: unknown[]
    hook(name: string, cb: (e: unknown) => unknown): Promise<{ dispose: () => Promise<void> }>
    prompt(input: unknown): Promise<unknown>
  }
  tool: { hook(name: string, cb: (e: unknown) => unknown): Promise<{ dispose: () => Promise<void> }> }
  event: { subscribe(opts?: { signal?: AbortSignal }): AsyncIterable<unknown> }
  sessionHooks: Map<string, (e: unknown) => unknown>
  toolHooks: Map<string, (e: unknown) => unknown>
  queue: EventQueue
}

function makeCtx(repo: string, home: string, opts: Record<string, unknown> = {}): FakeCtx {
  const sessionHooks = new Map<string, (e: unknown) => unknown>()
  const toolHooks = new Map<string, (e: unknown) => unknown>()
  const queue = new EventQueue()

  const makeTransform = <T>(registry: Map<string, T>, keyOf: (d: T) => string) => {
    let cb: ((editor: { add: (d: T) => void }) => void) | null = null
    // Real transforms replay all registrations onto fresh state; mirror that so
    // a reload reflects the current (possibly emptied) captured data.
    const replay = () => {
      if (!cb) return
      registry.clear()
      cb({ add: (d) => registry.set(keyOf(d), d) })
    }
    return {
      registry,
      transform: async (fn: (editor: { add: (d: T) => void }) => void) => {
        cb = fn
        replay()
        return { dispose: async () => undefined }
      },
      reload: async () => replay(),
    }
  }

  const ctx: FakeCtx = {
    location: { directory: repo },
    options: { homeDir: home, includeVsCodeSettings: false, ...opts },
    command: makeTransform(
      new Map(),
      (d) => d.name,
    ) as FakeCtx["command"],
    skill: makeTransform(new Map(), (d) => d.id) as FakeCtx["skill"],
    session: {
      prompts: [],
      hook: async (name: string, cb: (e: unknown) => unknown) => {
        sessionHooks.set(name, cb)
        return { dispose: async () => undefined }
      },
      prompt: async (input: unknown) => {
        ctx.session.prompts.push(input)
        return input
      },
    },
    tool: {
      hook: async (name: string, cb: (e: unknown) => unknown) => {
        toolHooks.set(name, cb)
        return { dispose: async () => undefined }
      },
    },
    event: {
      subscribe: (opts?: { signal?: AbortSignal }): AsyncIterable<unknown> =>
        (async function* (signal?: AbortSignal) {
          for (;;) {
            const item = await queue.next(signal)
            if (item === null) return
            yield item
          }
        })(opts?.signal),
    },
    sessionHooks,
    toolHooks,
    queue,
  }
  return ctx
}

function setupWithCtx(ctx: FakeCtx): Promise<() => void | Promise<void>> {
  return repoInstructions.setup(ctx as unknown as Parameters<typeof repoInstructions.setup>[0]) as Promise<
    () => void | Promise<void>
  >
}

// --- Tests -------------------------------------------------------------------------

test("global rules are merged into the last system entry via the context hook", async () => {
  const { repo, home, base } = await makeFixture()
  const ctx = makeCtx(repo, home)
  const cleanup = await setupWithCtx(ctx)
  try {
    const fire = (name: string, event: { system: unknown[] }) => {
      const hook = ctx.sessionHooks.get(name)
      assert.ok(hook, `hook ${name} registered`)
      void hook!(event)
    }

    // Merged into an existing system entry, not appended as a second one.
    const evt = {
      system: [
        { type: "text" as const, text: "base system" },
        { type: "text" as const, text: "second entry" },
      ],
    }
    fire("context", evt)
    assert.equal(evt.system.length, 2)
    const last = evt.system[1] as { text: string }
    assert.match(last.text, /second entry/)
    assert.match(last.text, /Always use tabs in this repo\./)
    assert.match(last.text, /Global dev rule\./)
    assert.match(last.text, /repo\/copilot-instructions\.md/)
    assert.match(last.text, /global\/instructions\/dev\.instructions\.md/)
    assert.equal((evt.system[0] as { text: string }).text, "base system")

    // Empty system: a single entry is pushed.
    const evt2 = { system: [] as { type: string; text: string }[] }
    fire("context", evt2)
    assert.equal(evt2.system.length, 1)
    assert.match(evt2.system[0].text, /Always use tabs in this repo\./)
  } finally {
    await cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test("scoped rule injected on file access, once per session", async () => {
  const { repo, home, base } = await makeFixture()
  const ctx = makeCtx(repo, home)
  const cleanup = await setupWithCtx(ctx)
  try {
    const before = (e: unknown) => {
      const h = ctx.toolHooks.get("execute.before")
      assert.ok(h, "tool before hook registered")
      return h!(e)
    }
    const after = (e: Record<string, unknown>) => {
      const h = ctx.toolHooks.get("execute.after")
      assert.ok(h, "tool after hook registered")
      return h!(e)
    }
    const file = path.join(repo, "src", "a.ts")

    const e1 = { tool: "read", sessionID: "s1", id: "c1", input: { filePath: file } }
    await before(e1)
    const a1 = { tool: "read", sessionID: "s1", id: "c1", input: {}, status: "completed", result: { content: "file contents" } }
    await after(a1)
    assert.match(a1.result.content, /Path-Specific Instructions/)
    assert.match(a1.result.content, /Use strict TypeScript\./)
    assert.match(String(a1.result.content), /repo-instructions:repo\/.github\/instructions\/ts\.instructions\.md/)

    // Second access to a matching file: no re-injection.
    const a2 = { tool: "read", sessionID: "s1", id: "c2", input: {}, status: "completed", result: { content: "contents2" } }
    await before({ tool: "read", sessionID: "s1", id: "c2", input: { filePath: path.join(repo, "src", "b.ts") } })
    await after(a2)
    assert.equal(a2.result.content, "contents2")

    // Non-matching file: no injection.
    const a3 = { tool: "read", sessionID: "s1", id: "c3", input: {}, status: "completed", result: { content: "gostuff" } }
    await before({ tool: "read", sessionID: "s1", id: "c3", input: { filePath: path.join(repo, "src", "a.go") } })
    await after(a3)
    assert.equal(a3.result.content, "gostuff")

    // Non-file tool is ignored.
    const a4 = { tool: "bash", sessionID: "s1", id: "c4", input: { command: "ls src/a.ts" }, status: "completed", result: { content: "ls-out" } }
    await before(a4)
    await after(a4)
    assert.equal(a4.result.content, "ls-out")

    // Failed tool: queued text is not appended to errors.
    await before({ tool: "write", sessionID: "s1", id: "c5", input: { filePath: path.join(repo, "src", "c.ts") } })
    const a5: { result: { content?: unknown } } = { result: {} }
    await after({ ...a5, status: "error", error: { message: "boom" } })
    assert.equal(a5.result.content, undefined)
  } finally {
    await cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test("compaction.ended clears injection state so scoped rules can be re-injected", async () => {
  const { repo, home, base } = await makeFixture()
  const ctx = makeCtx(repo, home)
  const cleanup = await setupWithCtx(ctx)
  try {
    const before = (e: unknown) => ctx.toolHooks.get("execute.before")!(e)
    const after = (e: unknown) => ctx.toolHooks.get("execute.after")!(e)
    const file = path.join(repo, "src", "a.ts")

    const a1 = { tool: "read", sessionID: "s1", id: "c1", input: {}, status: "completed", result: { content: "x" } }
    await before({ tool: "read", sessionID: "s1", id: "c1", input: { filePath: file } })
    await after(a1)
    assert.match(a1.result.content, /Use strict TypeScript\./)

    ctx.queue.push({ type: "session.compaction.ended", data: { sessionID: "s1" } })
    await tick(25)

    const a2 = { tool: "edit", sessionID: "s1", id: "c2", input: {}, status: "completed", result: { content: "x2" } }
    await before({ tool: "edit", sessionID: "s1", id: "c2", input: { filePath: file } })
    await after(a2)
    assert.match(a2.result.content, /Use strict TypeScript\./)
  } finally {
    await cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test("global rules are re-supplied to the transcript via the compaction hook", async () => {
  const { repo, home, base } = await makeFixture()
  const ctx = makeCtx(repo, home)
  const cleanup = await setupWithCtx(ctx)
  try {
    const hook = ctx.sessionHooks.get("compaction")
    assert.ok(hook, "compaction hook registered")
    const evt: { messages: unknown[] } = { messages: [] }
    await hook!(evt as never)
    assert.equal(evt.messages.length, 1)
    const msg = evt.messages[0] as { role: string; content: { type: string; text: string }[] }
    assert.equal(msg.role, "user")
    assert.match(msg.content[0].text, /Always use tabs in this repo\./)
  } finally {
    await cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test("commands are registered through the command transform and resubmit the template", async () => {
  const { repo, home, base } = await makeFixture()
  const ctx = makeCtx(repo, home)
  const cleanup = await setupWithCtx(ctx)
  try {
    const deploy = ctx.command.registry.get("deploy")
    assert.ok(deploy, "deploy command registered")
    assert.equal(deploy!.description, "Deploys")

    await deploy!.execute({ sessionID: "s1", prompt: { text: "prod --now" }, delivery: "steer" })
    assert.equal(ctx.session.prompts.length, 1)
    const sent = ctx.session.prompts[0] as { sessionID: string; text: string; delivery: string }
    assert.equal(sent.sessionID, "s1")
    assert.equal(sent.text, "Deploy prod --now.")
    assert.equal(sent.delivery, "steer")

    // Positional placeholders.
    const greet = ctx.command.registry.get("greet")
    assert.ok(greet, "greet command registered")
    await greet!.execute({ sessionID: "s2", prompt: { text: "Alice Bob" }, delivery: "queue" })
    const sent2 = ctx.session.prompts[1] as { text: string }
    assert.equal(sent2.text, "Hi Alice and Bob.")
  } finally {
    await cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test("skills are embedded through the skill transform with their original paths", async () => {
  const { repo, home, base } = await makeFixture()
  const ctx = makeCtx(repo, home)
  const cleanup = await setupWithCtx(ctx)
  try {
    const rs = ctx.skill.registry.get("repo-skill")
    assert.ok(rs, "repo-skill embedded")
    assert.equal(rs!.name, "repo-skill")
    assert.equal(rs!.description, "s")
    assert.equal(rs!.content, "body")
    assert.equal(rs!.path, path.join(repo, ".github", "skills", "repo-skill", "SKILL.md"))
    assert.ok(ctx.skill.registry.has("home-skill"), "home-skill embedded")
  } finally {
    await cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test("agents become managed markdown files; user files are never clobbered", async () => {
  const { repo, home, base } = await makeFixture()
  try {
    // A user-owned agent file at the name the plugin wants to write.
    const userFile = path.join(repo, ".opencode", "agents", "code-reviewer.md")
    await mkdir(path.dirname(userFile), { recursive: true })
    await writeFile(userFile, "USER-OWNED, DO NOT TOUCH\n", "utf8")

    const ctx = makeCtx(repo, home)
    const cleanup = await setupWithCtx(ctx)
    try {
      assert.equal(await readFile(userFile, "utf8"), "USER-OWNED, DO NOT TOUCH\n")

      // Repo agent without a conflicting user file gets a managed file.
      const linterFile = path.join(repo, ".opencode", "agents", "linter.md")
      const linterContent = await readFile(linterFile, "utf8")
      assert.match(linterContent, /managed by opencode-repo-instructions/)
      assert.match(linterContent, /You are a linter\./)
      assert.match(linterContent, /^mode: subagent/m)
      assert.match(linterContent, /description: "Lints"/)

      // Global agent goes to the global agents directory.
      const globalFile = path.join(home, ".config", "opencode", "agents", "global-owner.md")
      const globalContent = await readFile(globalFile, "utf8")
      assert.match(globalContent, /You are a global owner\./)
      assert.match(globalContent, /managed by opencode-repo-instructions/)
    } finally {
      await cleanup()
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("managed agent files are removed when their source disappears (live reload)", async () => {
  const { repo, home, base } = await makeFixture()
  const ctx = makeCtx(repo, home)
  const cleanup = await setupWithCtx(ctx)
  try {
    const linterFile = path.join(repo, ".opencode", "agents", "linter.md")
    assert.ok(await readFile(linterFile, "utf8"))

    const sourceFile = path.join(repo, ".github", "agents", "linter.agent.md")
    await rm(sourceFile)
    ctx.queue.push({ type: "filesystem.changed", data: { file: sourceFile, event: "unlink" } })
    // debounce (300ms) + margin
    await tick(450)

    let missing = false
    try {
      await readFile(linterFile, "utf8")
    } catch {
      missing = true
    }
    assert.ok(missing, "stale managed agent file removed after source deletion")

    // Unrelated file changes do not trigger a reload.
    const tsSource = path.join(repo, ".github", "instructions", "ts.instructions.md")
    ctx.queue.push({ type: "filesystem.changed", data: { file: path.join(repo, "src", "a.ts"), event: "change" } })
    await tick(450)
    assert.ok((await readFile(tsSource, "utf8")).length > 0)
  } finally {
    await cleanup()
    await rm(base, { recursive: true, force: true })
  }
})

test("no convention files: nothing is injected and nothing is registered", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ri-none-"))
  const repo = path.join(base, "repo")
  const home = path.join(base, "home")
  await mkdir(repo, { recursive: true })
  await mkdir(home, { recursive: true })
  try {
    const ctx = makeCtx(repo, home)
    const cleanup = await setupWithCtx(ctx)
    try {
      const evt = { system: [] as { type: string; text: string }[] }
      ctx.sessionHooks.get("context")!(evt)
      assert.equal(evt.system.length, 0)

      assert.equal(ctx.command.registry.size, 0)
      assert.equal(ctx.skill.registry.size, 0)

      // Tool hooks tolerate a file touch with no rules.
      const a = { tool: "read", sessionID: "s1", id: "c1", input: {}, status: "completed", result: { content: "x" } }
      await ctx.toolHooks.get("execute.before")!({ tool: "read", sessionID: "s1", id: "c1", input: { filePath: "a.ts" } })
      await ctx.toolHooks.get("execute.after")!(a)
      assert.equal(a.result.content, "x")
    } finally {
      await cleanup()
    }
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
