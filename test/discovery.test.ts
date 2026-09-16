import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { discover } from "../src/discovery.ts"

async function makeFixture(): Promise<{ repo: string; home: string; base: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "ri-discovery-"))
  const repo = path.join(base, "repo")
  const home = path.join(base, "home")

  await mkdir(path.join(repo, ".github", "instructions"), { recursive: true })
  await mkdir(path.join(repo, ".github", "prompts"), { recursive: true })
  await mkdir(path.join(repo, ".github", "agents"), { recursive: true })
  await mkdir(path.join(repo, ".github", "skills", "repo-skill"), { recursive: true })
  await mkdir(path.join(home, ".copilot", "instructions"), { recursive: true })
  await mkdir(path.join(home, ".copilot", "skills", "home-skill"), { recursive: true })
  await mkdir(path.join(home, ".copilot", "prompts"), { recursive: true })

  await writeFile(
    path.join(repo, ".github", "copilot-instructions.md"),
    "---\ndescription: repo rules\n---\nAlways use tabs in this repo.",
  )
  await writeFile(
    path.join(repo, ".github", "instructions", "ts.instructions.md"),
    "---\napplyTo: '**/*.ts,**/*.tsx'\n---\nUse strict TypeScript.",
  )
  await writeFile(
    path.join(repo, ".github", "instructions", "all.instructions.md"),
    "---\napplyTo: '**'\n---\nMatch-all rule goes global.",
  )
  await writeFile(path.join(repo, ".github", "prompts", "deploy.prompt.md"), "---\ndescription: Deploys\n---\nDeploy $ARGUMENTS now.")
  await writeFile(
    path.join(repo, ".github", "agents", "reviewer.agent.md"),
    "---\nname: code-reviewer\ndescription: Reviews code\ntools: read, grep\n---\nYou are a strict reviewer.",
  )
  await writeFile(
    path.join(repo, ".github", "skills", "repo-skill", "SKILL.md"),
    "---\nname: repo-skill\ndescription: A repo skill\n---\nRepo skill body.",
  )

  await writeFile(
    path.join(home, ".copilot", "instructions", "go.instructions.md"),
    "---\napplyTo: '**/*.go,**/go.mod'\n---\nIdiomatic Go only.",
  )
  await writeFile(
    path.join(home, ".copilot", "instructions", "development.instructions.md"),
    "# Development\nUse conventional commits.",
  )
  await writeFile(
    path.join(home, ".copilot", "skills", "home-skill", "SKILL.md"),
    "---\nname: home-skill\ndescription: A home skill\n---\nHome skill body.",
  )
  await writeFile(path.join(home, ".copilot", "prompts", "commit.prompt.md"), "---\nname: commit-msg\n---\nWrite a commit message.")

  return { repo, home, base }
}

test("discovers repo and global rules, skills, prompts and agents", async () => {
  const { repo, home, base } = await makeFixture()
  try {
    const d = await discover({ repoDir: repo, homeDir: home, includeVsCodeSettings: false })

    const globalIds = d.globals.map((g) => g.id).sort()
    assert.deepEqual(globalIds, [
      "global/instructions/development.instructions.md",
      "repo/.github/instructions/all.instructions.md",
      "repo/copilot-instructions.md",
    ])

    assert.equal(d.scoped.length, 2)
    const tsRule = d.scoped.find((r) => r.id === "repo/.github/instructions/ts.instructions.md")
    assert.ok(tsRule)
    assert.deepEqual(tsRule?.patterns, ["**/*.ts", "**/*.tsx"])
    assert.equal(tsRule?.matcher("src/a.ts"), true)
    assert.equal(tsRule?.matcher("src/a.go"), false)

    const goRule = d.scoped.find((r) => r.id === "global/instructions/go.instructions.md")
    assert.ok(goRule)
    assert.equal(goRule?.matcher("main.go"), true)
    assert.equal(goRule?.matcher("main.ts"), false)

    assert.deepEqual(d.skillsDirs, [
      path.join(repo, ".github", "skills"),
      path.join(home, ".copilot", "skills"),
    ])

    assert.deepEqual(
      d.commands.map((c) => c.name).sort(),
      ["commit-msg", "deploy"],
    )
    const deploy = d.commands.find((c) => c.name === "deploy")
    assert.equal(deploy?.description, "Deploys")
    assert.match(deploy?.template ?? "", /\$ARGUMENTS/)

    assert.equal(d.agents.length, 1)
    assert.equal(d.agents[0].name, "code-reviewer")
    assert.equal(d.agents[0].description, "Reviews code")
    assert.match(d.agents[0].prompt, /strict reviewer/)

    assert.equal(d.warnings.length, 0)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("ignores AGENTS.md and CLAUDE.md in instruction dirs", async () => {
  const { repo, home, base } = await makeFixture()
  try {
    await mkdir(path.join(repo, ".github", "instructions"), { recursive: true })
    await writeFile(path.join(repo, ".github", "instructions", "AGENTS.md"), "native file")
    const d = await discover({ repoDir: repo, homeDir: home, includeVsCodeSettings: false })
    assert.ok(!d.globals.some((g) => g.id.includes("AGENTS.md")))
    assert.ok(!d.scoped.some((g) => g.id.includes("AGENTS.md")))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("disabled sources are skipped", async () => {
  const { repo, home, base } = await makeFixture()
  try {
    const d = await discover({
      repoDir: repo,
      homeDir: home,
      includeVsCodeSettings: false,
      disabledSources: ["global-instructions", "repo-skills"],
    })
    assert.ok(!d.globals.some((g) => g.source === "global"))
    assert.deepEqual(d.skillsDirs, [path.join(home, ".copilot", "skills")])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("symlinked instruction files are picked up", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ri-symlink-"))
  const repo = path.join(base, "repo")
  const home = path.join(base, "home")
  const external = path.join(base, "shared-rules")
  await mkdir(path.join(repo, ".github"), { recursive: true })
  await mkdir(path.join(home, ".copilot", "instructions"), { recursive: true })
  await mkdir(external, { recursive: true })

  await writeFile(path.join(external, "go.instructions.md"), "---\napplyTo: '**/*.go'\n---\nGo rules via symlink.")
  await symlink(
    path.join(external, "go.instructions.md"),
    path.join(home, ".copilot", "instructions", "go.instructions.md"),
  )
  try {
    const d = await discover({ repoDir: repo, homeDir: home, includeVsCodeSettings: false })
    const go = d.scoped.find((r) => r.id === "global/instructions/go.instructions.md")
    assert.ok(go, "symlinked rule should be discovered")
    assert.equal(go?.matcher("main.go"), true)
    // Broken symlink is ignored without crashing
    await symlink(path.join(external, "missing.md"), path.join(home, ".copilot", "instructions", "broken.instructions.md"))
    const d2 = await discover({ repoDir: repo, homeDir: home, includeVsCodeSettings: false })
    assert.ok(!d2.scoped.some((r) => r.id.includes("broken")))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test("empty repo yields no rules", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "ri-empty-"))
  try {
    const d = await discover({ repoDir: base, homeDir: base, includeVsCodeSettings: false })
    assert.equal(d.globals.length, 0)
    assert.equal(d.scoped.length, 0)
    assert.equal(d.skillsDirs.length, 0)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
