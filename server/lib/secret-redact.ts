import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { storePath } from "./secret-store"

// Scrubs secrets out of text before it is persisted (approval history). Two
// layers: every known secret VALUE from the agent vault files (secrets.env and
// its secrets.mirror sibling) is replaced with `•••`, then obvious token shapes
// (Bearer …, sk-…, ghp_…, pss_…) are masked even when they are not in the vault.
// Values are read into memory only; they are never logged or returned.

export const MASK = "•••"
const MIN_VALUE_LEN = 8
const REFRESH_MS = 5 * 60_000

const PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[^\s"'\\]+/gi, `Bearer ${MASK}`],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bpss_[^\s"'\\]+/g, MASK],
]

// `NAME=v`, `export NAME='v'`, `NAME="v"  # tags` → v. Comment lines skipped.
const LINE_RE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=('[^']*'|"[^"]*"|\S*)/

export function parseSecretValues(content: string): string[] {
  const out: string[] = []
  for (const line of content.split("\n")) {
    if (line.trimStart().startsWith("#")) continue
    const m = LINE_RE.exec(line)
    if (!m) continue
    let v = m[1] ?? ""
    const q = v[0]
    if ((q === "'" || q === '"') && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1)
    if (v.length >= MIN_VALUE_LEN) out.push(v)
  }
  return out
}

// Test seam: point at temp files instead of the real vault.
let sourceOverride: string[] | null = null
export function setRedactionSources(paths: string[] | null): void {
  sourceOverride = paths
  cache = null
}

function sources(): string[] {
  if (sourceOverride) return sourceOverride
  const env = storePath()
  return [env, join(dirname(env), "secrets.mirror")]
}

let cache: { at: number; values: string[] } | null = null

function knownValues(now = Date.now()): string[] {
  if (cache && now - cache.at < REFRESH_MS) return cache.values
  const set = new Set<string>()
  for (const path of sources()) {
    let content = ""
    try { content = readFileSync(path, "utf8") } catch { continue }
    for (const v of parseSecretValues(content)) {
      set.add(v)
      // The same value as it appears inside a JSON string (quotes, backslashes).
      const escaped = JSON.stringify(v).slice(1, -1)
      if (escaped !== v) set.add(escaped)
    }
  }
  // Longest first, so a value that contains another is masked whole.
  cache = { at: now, values: [...set].sort((a, b) => b.length - a.length) }
  return cache.values
}

export function redactSecrets(text: string): string {
  if (!text) return text
  let out = text
  for (const v of knownValues()) {
    if (out.includes(v)) out = out.split(v).join(MASK)
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep)
  return out
}
