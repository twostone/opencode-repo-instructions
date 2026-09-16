import { test } from "node:test"
import assert from "node:assert/strict"
import { asPatternList, parseFrontmatter } from "../src/frontmatter.ts"

test("no frontmatter returns full body", () => {
  const res = parseFrontmatter("# Hello\nworld")
  assert.equal(res.hadFrontmatter, false)
  assert.deepEqual(res.frontmatter, {})
  assert.equal(res.body, "# Hello\nworld")
})

test("parses scalar frontmatter", () => {
  const res = parseFrontmatter("---\nname: my-skill\ndescription: 'A: B'\n---\nBody text")
  assert.equal(res.hadFrontmatter, true)
  assert.equal(res.frontmatter.name, "my-skill")
  assert.equal(res.frontmatter.description, "A: B")
  assert.equal(res.body, "Body text")
})

test("parses inline list", () => {
  const res = parseFrontmatter('---\napplyTo: "**/*.ts,**/*.tsx"\n---\nBody')
  assert.deepEqual(asPatternList(res.frontmatter.applyTo), ["**/*.ts", "**/*.tsx"])
})

test("parses inline list with quotes", () => {
  const res = parseFrontmatter('---\nglobs: [a.py, "b/c.ts", **/*.go]\n---\nBody')
  assert.deepEqual(asPatternList(res.frontmatter.globs), ["a.py", "b/c.ts", "**/*.go"])
})

test("parses block list", () => {
  const raw = "---\napplyTo:\n  - **/*.ts\n  - **/*.tsx\n---\nBody"
  const res = parseFrontmatter(raw)
  assert.deepEqual(asPatternList(res.frontmatter.applyTo), ["**/*.ts", "**/*.tsx"])
})

test("asPatternList handles undefined and commas in string", () => {
  assert.deepEqual(asPatternList(undefined), [])
  assert.deepEqual(asPatternList("**/*.ts, **/*.go"), ["**/*.ts", "**/*.go"])
  assert.deepEqual(asPatternList(["a", "b"]), ["a", "b"])
})

test("body with frontmatter and CRLF", () => {
  const res = parseFrontmatter("---\napplyTo: '**'\r\n---\r\nCRLF body")
  assert.equal(res.hadFrontmatter, true)
  assert.equal(res.body, "CRLF body")
})

test("unclosed frontmatter returns full body", () => {
  const res = parseFrontmatter("---\napplyTo: '**'\nno closing fence")
  assert.equal(res.hadFrontmatter, false)
  assert.equal(res.body, "---\napplyTo: '**'\nno closing fence")
})
