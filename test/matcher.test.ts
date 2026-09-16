import { test } from "node:test"
import assert from "node:assert/strict"
import { createMatcher, isMatchAll } from "../src/matcher.ts"

test("isMatchAll detects universal patterns", () => {
  assert.equal(isMatchAll(["**"]), true)
  assert.equal(isMatchAll(["**/*"]), true)
  assert.equal(isMatchAll(["**/*.ts"]), false)
  assert.equal(isMatchAll(["src/*"]), false)
})

test("matcher matches nested paths", () => {
  const m = createMatcher(["**/*.ts"])
  assert.equal(m("a.ts"), true)
  assert.equal(m("src/a.ts"), true)
  assert.equal(m("src/deep/a.ts"), true)
  assert.equal(m("src/a.go"), false)
})

test("matcher with multiple patterns", () => {
  const m = createMatcher(["**/*.go", "**/go.mod", "**/go.sum"])
  assert.equal(m("main.go"), true)
  assert.equal(m("pkg/go.mod"), true)
  assert.equal(m("go.sum"), true)
  assert.equal(m("README.md"), false)
})

test("matcher normalizes leading slash", () => {
  const m = createMatcher(["**/*.ts"])
  assert.equal(m("/src/a.ts"), true)
})

test("matcher handles brace patterns", () => {
  const m = createMatcher(["**/*.{ts,tsx}"])
  assert.equal(m("a.ts"), true)
  assert.equal(m("a.tsx"), true)
  assert.equal(m("a.js"), false)
})
