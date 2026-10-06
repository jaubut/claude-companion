// Context gauge: each session's context fill plus the account's 5h / 7d usage,
// for the phone's status row and sessions drawer.
//
// Two sources, keyed by Claude Code session id:
//   - "mod": the context-gauge mod inside Claude Code POSTs /hooks/gauge after
//     every turn, on session start and after a compact. Authoritative.
//   - "transcript": the server's fallback, from the same transcript tail
//     auto-compact reads at Stop. Used only while no mod report is fresh
//     (MOD_FRESH_MS); 5h / 7d are unknown on this path.
// A session's gauge drops STALE_MS after its last report or when it ends.
// The 5h / 7d figures are account-wide: one `account` copy, from the freshest
// mod report of any session.
//
// The wire key is the session registry's `key` (lib/sessions.ts) — the one the
// phone already uses — resolved at read / emit time through deps.resolveKey,
// since a mod report carries only the session id. Unresolvable → not exposed.

export const MOD_FRESH_MS = 10 * 60_000
export const STALE_MS = 30 * 60_000
export const EMIT_MIN_MS = 2_000
export const SWEEP_MS = 60_000
export const WINDOW_1M = 1_000_000
export const WINDOW_200K = 200_000

export type GaugeSource = "mod" | "transcript"

export interface GaugeAccount {
  fiveHourPercent: number | null
  fiveHourResetsAt: string | null
  sevenDayPercent: number | null
  at: number
}

export interface GaugeSessionItem {
  sessionKey: string
  ctxTokens: number | null
  ctxWindow: number | null
  ctxPercent: number | null
  source: GaugeSource
  at: number
}

// The `gauge` WS frame: one sessions[] item plus `account`. A cleared gauge
// (stale or session ended) carries null ctx fields and a null source.
export interface GaugeFrame {
  type: "gauge"
  sessionKey: string
  ctxTokens: number | null
  ctxWindow: number | null
  ctxPercent: number | null
  source: GaugeSource | null
  at: number
  account: GaugeAccount | null
}

export interface GaugeSnapshot {
  ok: true
  account: GaugeAccount | null
  sessions: GaugeSessionItem[]
}

// The /hooks/gauge body after validation: every field but sessionId optional.
export interface ModReport {
  sessionId: string
  cwd: string | null
  ctxTokens: number | null
  ctxWindow: number | null
  ctxPercent: number | null
  fiveHourPercent: number | null
  fiveHourResetsAt: string | null
  sevenDayPercent: number | null
  at: number | null
}

export interface GaugeDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  // Session id → registry key; `hint` is the key the reporter knew (Stop hook).
  resolveKey(sessionId: string, hint: string): string | null
  emit(frame: GaugeFrame): void
}

interface Entry {
  sessionId: string
  hintKey: string
  ctxTokens: number | null
  ctxWindow: number | null
  ctxPercent: number | null
  source: GaugeSource
  at: number // reporter's time when given, else receipt
  reportedAt: number // server receipt time of the last report (staleness)
  modAt: number // server receipt time of the last mod ctx report, 0 = none
}

interface EmitState {
  lastAt: number
  key: string
  timer: unknown
}

const SESSION_ID_MAX = 200
const RESETS_AT_MAX = 64

function finiteNonNeg(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
}

// Validates a /hooks/gauge body. Only session_id is required; a field of the
// wrong type counts as absent. Returns null when the body is unusable.
export function parseModReport(body: unknown): ModReport | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const sid = typeof b.session_id === "string" ? b.session_id.trim() : ""
  if (!sid || sid.length > SESSION_ID_MAX) return null
  const resets = typeof b.five_hour_resets_at === "string" && b.five_hour_resets_at.length <= RESETS_AT_MAX
    ? b.five_hour_resets_at
    : null
  return {
    sessionId: sid,
    cwd: typeof b.cwd === "string" && b.cwd ? b.cwd : null,
    ctxTokens: finiteNonNeg(b.ctx_tokens),
    ctxWindow: finiteNonNeg(b.ctx_window) || null,
    ctxPercent: finiteNonNeg(b.ctx_percent),
    fiveHourPercent: finiteNonNeg(b.five_hour_percent),
    fiveHourResetsAt: resets,
    sevenDayPercent: finiteNonNeg(b.seven_day_percent),
    at: finiteNonNeg(b.at) || null,
  }
}

// 1M when the model id says so ([1m]) or the tokens already exceed 200k.
export function windowFor(tokens: number, model = ""): number {
  return model.includes("[1m]") || tokens > WINDOW_200K ? WINDOW_1M : WINDOW_200K
}

export function percentOf(tokens: number, window: number): number {
  return Math.round((tokens / window) * 100)
}

export class GaugeStore {
  private entries = new Map<string, Entry>()
  private account: GaugeAccount | null = null
  private emits = new Map<string, EmitState>()
  private sweepTimer: unknown = null

  constructor(private deps: GaugeDeps) {}

  reportMod(r: ModReport): void {
    const now = this.deps.now()
    const at = r.at ?? now
    const hasCtx = r.ctxTokens !== null || r.ctxPercent !== null
    const prev = this.entries.get(r.sessionId)
    if (hasCtx) {
      const window = r.ctxWindow ?? (r.ctxTokens !== null ? windowFor(r.ctxTokens) : prev?.ctxWindow ?? null)
      const percent = r.ctxPercent !== null
        ? Math.round(r.ctxPercent)
        : r.ctxTokens !== null && window ? percentOf(r.ctxTokens, window) : null
      this.entries.set(r.sessionId, {
        sessionId: r.sessionId,
        hintKey: prev?.hintKey ?? "",
        ctxTokens: r.ctxTokens,
        ctxWindow: window,
        ctxPercent: percent,
        source: "mod",
        at,
        reportedAt: now,
        modAt: now,
      })
    } else if (prev) {
      prev.reportedAt = now
    }
    const accountChanged = this.mergeAccount(r, at)
    if (hasCtx || accountChanged) this.schedule(r.sessionId)
    this.ensureSweep()
  }

  // Stop-hook fallback. Ignored while a mod report for the session is fresh.
  reportTranscript(sessionId: string, hintKey: string, tokens: number, model = ""): void {
    if (!sessionId) return
    const now = this.deps.now()
    const prev = this.entries.get(sessionId)
    if (prev && this.modFreshFor(sessionId)) {
      if (hintKey) prev.hintKey = hintKey
      return
    }
    const window = windowFor(tokens, model)
    const percent = percentOf(tokens, window)
    if (prev && prev.source === "transcript" && prev.ctxTokens === tokens && prev.ctxWindow === window) {
      prev.reportedAt = now
      prev.at = now
      if (hintKey) prev.hintKey = hintKey
      return
    }
    this.entries.set(sessionId, {
      sessionId,
      hintKey: hintKey || prev?.hintKey || "",
      ctxTokens: tokens,
      ctxWindow: window,
      ctxPercent: percent,
      source: "transcript",
      at: now,
      reportedAt: now,
      modAt: prev?.modAt ?? 0,
    })
    this.schedule(sessionId)
    this.ensureSweep()
  }

  modFreshFor(sessionId: string, within = MOD_FRESH_MS): boolean {
    const e = this.entries.get(sessionId)
    return !!e && e.modAt > 0 && this.deps.now() - e.modAt < within
  }

  // Session ended: drop its gauge now. True when there was one.
  drop(sessionId: string): boolean {
    if (!sessionId || !this.entries.delete(sessionId)) return false
    this.schedule(sessionId)
    return true
  }

  // Drops every entry whose last report is older than STALE_MS.
  sweep(): number {
    const now = this.deps.now()
    let n = 0
    for (const [sid, e] of this.entries) {
      if (now - e.reportedAt < STALE_MS) continue
      this.entries.delete(sid)
      this.schedule(sid)
      n++
    }
    return n
  }

  snapshot(): GaugeSnapshot {
    this.sweep()
    const sessions: GaugeSessionItem[] = []
    for (const e of this.entries.values()) {
      const key = this.deps.resolveKey(e.sessionId, e.hintKey)
      if (key) sessions.push(this.item(key, e))
    }
    return { ok: true, account: this.account ? { ...this.account } : null, sessions }
  }

  stop(): void {
    if (this.sweepTimer) this.deps.clearTimer(this.sweepTimer)
    this.sweepTimer = null
    for (const s of this.emits.values()) if (s.timer) this.deps.clearTimer(s.timer)
    this.emits.clear()
  }

  // Newer reports win; a field the report left null keeps its last value.
  private mergeAccount(r: ModReport, at: number): boolean {
    if (r.fiveHourPercent === null && r.fiveHourResetsAt === null && r.sevenDayPercent === null) return false
    const cur = this.account
    if (cur && at < cur.at) return false
    const next: GaugeAccount = {
      fiveHourPercent: r.fiveHourPercent ?? cur?.fiveHourPercent ?? null,
      fiveHourResetsAt: r.fiveHourResetsAt ?? cur?.fiveHourResetsAt ?? null,
      sevenDayPercent: r.sevenDayPercent ?? cur?.sevenDayPercent ?? null,
      at,
    }
    const same = cur
      && cur.fiveHourPercent === next.fiveHourPercent
      && cur.fiveHourResetsAt === next.fiveHourResetsAt
      && cur.sevenDayPercent === next.sevenDayPercent
    this.account = next
    return !same
  }

  private item(key: string, e: Entry): GaugeSessionItem {
    return { sessionKey: key, ctxTokens: e.ctxTokens, ctxWindow: e.ctxWindow, ctxPercent: e.ctxPercent, source: e.source, at: e.at }
  }

  // ≤ 1 frame / EMIT_MIN_MS per session, trailing: the frame sent when the
  // window opens carries the state at that moment (latest value or a clear).
  private schedule(sessionId: string): void {
    const st = this.emits.get(sessionId)
    if (st?.timer) return
    const wait = st ? st.lastAt + EMIT_MIN_MS - this.deps.now() : 0
    if (wait <= 0) { this.flush(sessionId); return }
    st!.timer = this.deps.setTimer(() => {
      const cur = this.emits.get(sessionId)
      if (cur) cur.timer = null
      this.flush(sessionId)
    }, wait)
  }

  private flush(sessionId: string): void {
    const e = this.entries.get(sessionId)
    const st = this.emits.get(sessionId)
    const account = this.account ? { ...this.account } : null
    const now = this.deps.now()
    if (e) {
      const key = this.deps.resolveKey(sessionId, e.hintKey)
      if (!key) return // not on the phone's list yet; GET /api/gauge resolves later
      this.deps.emit({ type: "gauge", ...this.item(key, e), account })
      this.emits.set(sessionId, { lastAt: now, key, timer: null })
      return
    }
    // Cleared: tell the phone under the key it last saw, if any.
    if (!st?.key) { this.emits.delete(sessionId); return }
    this.deps.emit({ type: "gauge", sessionKey: st.key, ctxTokens: null, ctxWindow: null, ctxPercent: null, source: null, at: now, account })
    this.emits.delete(sessionId)
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return
    const tick = (): void => {
      this.sweep()
      this.sweepTimer = this.entries.size > 0 ? this.deps.setTimer(tick, SWEEP_MS) : null
    }
    this.sweepTimer = this.deps.setTimer(tick, SWEEP_MS)
  }
}
