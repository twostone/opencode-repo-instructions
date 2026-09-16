export interface ParsedFrontmatter {
  frontmatter: Record<string, string | string[]>
  body: string
  hadFrontmatter: boolean
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return v.slice(1, -1)
    }
  }
  return v
}

function parseInlineList(value: string): string[] {
  const inner = value.trim().slice(1, -1).trim()
  if (inner === "") return []
  const parts: string[] = []
  let current = ""
  let quote: string | null = null
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === ",") {
      parts.push(current.trim())
      current = ""
    } else {
      current += ch
    }
  }
  parts.push(current.trim())
  return parts.filter((p) => p !== "")
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: string | null = null
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
    } else if (ch === ",") {
      parts.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  parts.push(current)
  return parts
}

/**
 * Parses a minimal YAML frontmatter subset: flat `key: value` pairs with
 * scalar values (bare, single or double quoted) and lists in inline
 * (`[a, b]`) or block (`- a`) form. Sufficient for Copilot/Cursor-style
 * rule frontmatter (applyTo, description, name, globs, alwaysApply, ...).
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = raw.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    return { frontmatter: {}, body: raw, hadFrontmatter: false }
  }

  const lines = normalized.split("\n")
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i
      break
    }
  }
  if (end === -1) {
    return { frontmatter: {}, body: raw, hadFrontmatter: false }
  }

  const fmLines = lines.slice(1, end)
  const body = lines.slice(end + 1).join("\n").replace(/^\n/, "")
  const frontmatter: Record<string, string | string[]> = {}
  let lastKey: string | null = null

  for (const line of fmLines) {
    if (!line.trim() || line.trim().startsWith("#")) continue
    if (/^\s+-\s/.test(line)) {
      if (lastKey) {
        const current = frontmatter[lastKey]
        if (Array.isArray(current)) {
          current.push(unquote(line.trim().replace(/^-\s+/, "")))
        }
      }
      continue
    }
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    if (!key || /\s/.test(key)) continue
    const value = line.slice(idx + 1).trim()
    if (value === "") {
      frontmatter[key] = []
      lastKey = key
      continue
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = parseInlineList(value)
      lastKey = null
      continue
    }
    frontmatter[key] = unquote(value)
    lastKey = null
  }

  return { frontmatter, body, hadFrontmatter: true }
}

/** Returns applyTo/globs as a clean array of glob patterns. */
export function asPatternList(value: string | string[] | undefined): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean)
  return splitTopLevel(value)
    .map((v) => unquote(v))
    .filter(Boolean)
}
