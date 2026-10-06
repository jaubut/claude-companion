// AUTO_COMPACT_* env settings (threshold, boundary floor, session scope).

export const DEFAULT_BOUNDARY_TOKENS = 250_000

// AUTO_COMPACT_TOKENS: unset/blank/garbage/0/negative → off (0). Opt-in only.
export function thresholdFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number((env.AUTO_COMPACT_TOKENS ?? "").trim())
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

// AUTO_COMPACT_BOUNDARY_TOKENS: unset/blank/garbage → 250k; 0/negative → the
// boundary trigger is off. Only consulted while AUTO_COMPACT_TOKENS is on.
export function boundaryFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.AUTO_COMPACT_BOUNDARY_TOKENS ?? "").trim()
  const n = Number(raw)
  if (!raw || !Number.isFinite(n)) return DEFAULT_BOUNDARY_TOKENS
  return n > 0 ? Math.floor(n) : 0
}

// AUTO_COMPACT_ONLY: comma list of session keys or name globs (`*`, `?`,
// case-insensitive). Unset/blank → [] = every session.
export function scopeFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return (env.AUTO_COMPACT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean)
}

function globRegex(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${body}$`, "i")
}

export function inScope(target: { key: string; name: string }, patterns: string[]): boolean {
  if (patterns.length === 0) return true
  return patterns.some((p) => { const re = globRegex(p); return re.test(target.key) || re.test(target.name) })
}
