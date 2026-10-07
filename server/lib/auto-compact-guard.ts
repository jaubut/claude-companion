// The not_executed guard: no silent retry loop for auto-compact.
//
// 2026-10-06: a pasted `/compact keep: …` was submitted (Enter went in, the
// read-back passed) but Claude Code never ran it, so the context stayed over
// the threshold and the next boundary sent the same command again, 3 times.
// An inject with no compact_boundary within NOT_EXECUTED_MS is recorded here;
// the session is not re-armed until a real compaction is seen or
// NOT_EXECUTED_BACKOFF_MS passes.

export const NOT_EXECUTED_MS = 90_000
export const NOT_EXECUTED_BACKOFF_MS = 2 * 60 * 60_000

/** An inject that "succeeded" with no compaction after it. */
export interface NotExecuted {
  at: number
  tokens: number // context the failed attempt was armed on
}

export class NotExecutedGuard {
  private held = new Map<string, NotExecuted>()

  get(key: string): NotExecuted | null {
    return this.held.get(key) ?? null
  }

  record(key: string, at: number, tokens: number): void {
    this.held.set(key, { at, tokens })
  }

  /** A real compaction was seen. True when a guard was lifted. */
  clear(key: string): boolean {
    return this.held.delete(key)
  }

  /** Context fell below half of the failed attempt's: compacted some other way. Lifts the guard. */
  dropped(key: string, tokens: number): boolean {
    const g = this.held.get(key)
    if (!g || !(g.tokens > 0 && tokens < g.tokens / 2)) return false
    return this.held.delete(key)
  }

  /** "held" inside the backoff; "expired" (guard lifted) after it; "none" without a guard. */
  check(key: string, now: number): "none" | "held" | "expired" {
    const g = this.held.get(key)
    if (!g) return "none"
    if (now - g.at < NOT_EXECUTED_BACKOFF_MS) return "held"
    this.held.delete(key)
    return "expired"
  }
}

/** The phone notification for a not_executed attempt. */
export function notExecutedPush(name: string): { title: string; body: string } {
  const secs = Math.round(NOT_EXECUTED_MS / 1000)
  const hold = Math.round(NOT_EXECUTED_BACKOFF_MS / 60_000)
  return {
    title: `Compact non exécuté — ${name}`,
    body: `/compact envoyé il y a ${secs} s, aucune compaction. Pas de nouvel essai avant ${hold} min ou une compaction.`,
  }
}
