import picomatch from "picomatch"

export type FileMatcher = (relativePath: string) => boolean

const MATCH_ALL = new Set(["**", "**/*", "**/*.*", "*.*"])

export function isMatchAll(patterns: string[]): boolean {
  return patterns.some((p) => MATCH_ALL.has(p.trim()))
}

/**
 * Builds a matcher over repo-relative POSIX paths. Patterns are matched as
 * written; a leading `./` is normalized away. `dot: true` so hidden dirs
 * are not excluded.
 */
export function createMatcher(patterns: string[]): FileMatcher {
  const matchers = patterns.map((raw) => {
    let p = raw.trim()
    if (p.startsWith("./")) p = p.slice(2)
    return picomatch(p, { dot: true, nocase: false })
  })
  return (rel) => {
    const normalized = rel.replace(/^\/+/, "")
    return matchers.some((m) => m(normalized) || m("/" + normalized))
  }
}
