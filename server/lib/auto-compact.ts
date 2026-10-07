// Smart auto-compact: compact a big session BETWEEN tasks, before Claude Code's
// own auto-compact (~967k) fires mid-task (a 76 s stall observed 2026-10-03).
//
// OFF unless AUTO_COMPACT_TOKENS is set to a positive number (opt-in).
//
// On a Stop hook the controller reads the session's context size (last main-
// chain assistant usage: input + cache_read + cache_creation) from the
// transcript TAIL. Over the threshold it waits until the user has been quiet
// for IDLE_MS, re-checks every gate, pushes "compacting <name> in 60s" (cancel
// = type in the pane, or POST /api/auto-compact/cancel), and after CANCEL_MS —
// still idle, not cancelled — types `/compact keep: …` into that session's own tmux
// pane through the guarded inject path. When the bytes appended after the
// inject show a compact_boundary it pushes the result.
//
// AUTO_COMPACT_ONLY (key or name globs) narrows which sessions any automatic
// trigger (size or boundary) can arm; the explicit test trigger ignores it.
// POST /api/auto-compact/test arms one session on demand: same path and gates,
// minus the size threshold (AutoCompactor.test).
//
// Boundary trigger (lib/auto-compact-keep.ts): under the size threshold but
// over AUTO_COMPACT_BOUNDARY_TOKENS (default 250k), a Stop also arms when a
// unit of work just closed — a PR merged, a dispatch / Turso task completed,
// or a short closing prompt ("nice", "merci") — once per closing (consumed at
// the countdown). Same gates after that.
//
// The typed text is `/compact keep: …` built from durable state this session
// touched (PRs, Turso notes + open tasks, STATE.md next lines), COMPACT_TEXT
// when none is found.
//
// One attempt per Stop; a new Stop or any user prompt / typing supersedes or
// cancels it. A per-session cooldown starts at the countdown push, so a
// cancel also holds the next attempt off for COOLDOWN_MS.
//
// No silent retry loop: an inject with no compact_boundary after it holds the
// session (`not_executed`, lib/auto-compact-guard.ts).
//
// Transcripts are tens of MB; none is parsed whole: context size reads a
// growing tail window (TAIL_START_BYTES ×4 up to TAIL_MAX_BYTES), background
// tasks an incremental per-session scan in SCAN_CHUNK_BYTES reads, the boundary
// watch only bytes appended since its last poll (shorter file → rescan).
//
// Controller here; parsing in lib/auto-compact-transcript.ts; real deps (tmux,
// APNs, Claude's session file) in wiring/auto-compact.ts.

import { type GateVerdict, type InputState, compactGate } from "./auto-compact-gate"
import { NOT_EXECUTED_MS, type NotExecuted, NotExecutedGuard, notExecutedPush } from "./auto-compact-guard"
import { COMPACT_TEXT, type KeepState, type SessionSnapshot, SessionScan, type UnitReason, buildKeep } from "./auto-compact-keep"
import {
  BackgroundScan, type CompactBoundary, type Entry, compactBoundaries, contextSettled, contextTokens,
  entryTime, isBoundary, lastHumanPromptAt, parseLines,
} from "./auto-compact-transcript"

export {
  BG_MAX_AGE_MS, BackgroundScan, type CompactBoundary, type Entry, compactBoundaries, contextTokens,
  lastHumanPromptAt, openBackgroundTasks, parseLines,
} from "./auto-compact-transcript"

export const IDLE_MS = 3 * 60_000
export const CANCEL_MS = 60_000
export const COOLDOWN_MS = 30 * 60_000
export const TYPING_POLL_MS = 20_000
export const BOUNDARY_POLL_MS = 15_000
export const BOUNDARY_WAIT_MS = 15 * 60_000
export { NOT_EXECUTED_BACKOFF_MS, NOT_EXECUTED_MS, type NotExecuted } from "./auto-compact-guard"
export const TAIL_START_BYTES = 256 * 1024
export const TAIL_MAX_BYTES = 16 * 1024 * 1024
export const SCAN_CHUNK_BYTES = 1024 * 1024
export { COMPACT_TEXT } from "./auto-compact-keep"
export { DEFAULT_BOUNDARY_TOKENS, boundaryFromEnv, inScope, scopeFromEnv, thresholdFromEnv } from "./auto-compact-settings"
export { type GateInput, type GateReason, type GateVerdict, type InputState, compactGate } from "./auto-compact-gate"

// ── Controller ────────────────────────────────────────────────────────────

export interface CompactTarget {
  key: string
  name: string
  sessionId: string
  transcriptPath: string
  /** Session cwd (STATE.md lookup for the keep text). */
  cwd?: string
}

// size = over the threshold; a UnitReason = boundary trigger; test = on demand.
export type Trigger = "size" | UnitReason | "test"

const TRIGGER_LABEL: Record<Exclude<Trigger, "size">, string> = {
  pr_merged: "PR merged",
  task_completed: "task completed",
  closing_prompt: "task closed",
  test: "test",
}

export interface CompactionDone {
  target: CompactTarget
  trigger: Trigger
  preTokens: number
  postTokens: number
  at: number
}

export type PushKind = "countdown" | "done" | "failed"

export interface AutoCompactDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  threshold(): number
  transcriptSize(path: string): Promise<number | null>
  // Bytes [start, end) as UTF-8; null when unreadable.
  readTranscript(path: string, start: number, end: number): Promise<string | null>
  agentStatus(key: string): Promise<string>
  inputState(key: string): Promise<InputState>
  push(kind: PushKind, target: CompactTarget, title: string, body: string): Promise<void>
  inject(key: string, text: string): Promise<{ ok: boolean; error?: string }>
  log(line: string): void
  // AUTO_COMPACT_ONLY scope; absent = every session. Gates every automatic
  // trigger (size, boundary); not consulted by test().
  eligible?(target: CompactTarget): boolean
  /** Boundary-trigger floor; absent or ≤ 0 = boundary trigger off. */
  boundaryThreshold?(): number
  /** Resolve the session's durable pointers (gh / Turso / STATE.md); absent → COMPACT_TEXT. */
  keepState?(target: CompactTarget, snap: SessionSnapshot): Promise<KeepState | null>
  /** A compaction we injected completed. */
  recordCompaction?(done: CompactionDone): void
}

export type TestResult =
  | { ok: true; waitMs: number; tokens: number | null }
  | { ok: false; error: "off" | "busy" | "in_progress" | "cooldown" | "transcript_unreadable" }

type Phase = "scheduled" | "countdown" | "injecting" | "awaiting_boundary"

interface Pending {
  phase: Phase
  target: CompactTarget
  trigger: Trigger // why it was armed; "test" skips only the size floor
  minTokens: number // the size floor this attempt was armed on
  timer: unknown
  typingTimer: unknown
  tokens: number
  offset: number // transcript bytes already scanned by the boundary watch
  injectedAt: number
  // 0, or (after the file was rewritten and rescanned from the top) the inject
  // time: boundaries older than it are pre-inject history, not our result.
  minBoundaryAt: number
  boundaryDeadline: number
  notExecuted: boolean // flagged after NOT_EXECUTED_MS without a boundary
}

interface Tail {
  entries: Entry[]
  fromStart: boolean
}

interface Scans {
  bg: BackgroundScan
  session: SessionScan
}

interface BgState {
  path: string
  offset: number // bytes fed to the scans (always at a line start)
  scans: Scans
  running: Promise<Scans | null> | null
}

export interface AutoCompactStatus {
  key: string
  phase: Phase
  name: string
  tokens: number
  trigger: Trigger
}

// A test trigger on a session with unknown context arms with 0 — leave the
// count out rather than claim "Context 0 tokens".
function countdownBody(tokens: number, trigger: Trigger): string {
  const parts = [tokens > 0 ? `Context ${formatTokens(tokens)} tokens` : "", trigger === "size" ? "" : TRIGGER_LABEL[trigger]].filter(Boolean)
  return `${parts.length ? `${parts.join(", ")}. ` : ""}To cancel, type anything in the session's pane.`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

export class AutoCompactor {
  private pending = new Map<string, Pending>()
  private lastActivity = new Map<string, number>()
  private lastAttempt = new Map<string, number>()
  private bg = new Map<string, BgState>()
  private consumed = new Map<string, number>() // last countdown: unit closings up to here are used
  private guard = new NotExecutedGuard()

  constructor(private deps: AutoCompactDeps) {}

  status(): AutoCompactStatus[] {
    return [...this.pending.entries()].map(([key, p]) => ({ key, phase: p.phase, name: p.target.name, tokens: p.tokens, trigger: p.trigger }))
  }

  // UserPromptSubmit (or typing seen in the pane): resets the idle window and
  // cancels anything not yet typed. A prompt after the inject is the
  // compaction itself or the user — the boundary watch is left alone.
  noteUserActivity(key: string, why = "user prompt"): void {
    this.lastActivity.set(key, this.deps.now())
    const p = this.pending.get(key)
    if (p && (p.phase === "scheduled" || p.phase === "countdown")) this.abort(key, why, p.phase === "countdown")
  }

  // Phone cancel action. True when something was pending.
  cancel(key: string, by = "phone"): boolean {
    const p = this.pending.get(key)
    if (!p || (p.phase !== "scheduled" && p.phase !== "countdown")) return false
    this.abort(key, `cancelled (${by})`, true)
    return true
  }

  forget(key: string): void {
    const p = this.pending.get(key)
    if (p) this.clear(key, p)
    this.lastActivity.delete(key)
    this.bg.delete(key)
    this.consumed.delete(key)
    this.guard.clear(key)
  }

  /** The not_executed guard on a session, if one holds. */
  notExecutedOf(key: string): NotExecuted | null { return this.guard.get(key) }

  async onStop(target: CompactTarget): Promise<void> {
    const prior = this.pending.get(target.key)
    if (prior?.phase === "injecting" || prior?.phase === "awaiting_boundary") return
    if (prior) this.abort(target.key, "superseded by a new Stop", false)

    const threshold = this.deps.threshold()
    if (threshold <= 0 || !target.transcriptPath) return
    if (this.deps.eligible && !this.deps.eligible(target)) return
    const tail = await this.readTail(target.transcriptPath, contextSettled)
    if (!tail) return
    const tokens = contextTokens(tail.entries)
    if (tokens === null) return
    if (this.guard.dropped(target.key, tokens)) this.deps.log(`auto-compact ${target.name}: context dropped to ${formatTokens(tokens)} — not_executed guard cleared`)
    let trigger: Trigger = "size"
    let minTokens = threshold
    if (tokens <= threshold) {
      const boundary = this.deps.boundaryThreshold?.() ?? 0
      if (boundary <= 0 || boundary >= threshold || tokens <= boundary) return
      const scans = await this.scanBackground(target.key, target.transcriptPath)
      const reason = scans?.session.closedSince(this.consumed.get(target.key) ?? 0)
      if (!reason) return
      if (this.pending.has(target.key)) return // a concurrent Stop armed meanwhile
      trigger = reason
      minTokens = boundary
    }
    const now = this.deps.now()
    const held = this.guard.check(target.key, now) // "dropped" above runs on every Stop, under the threshold too
    if (held !== "none") this.deps.log(`auto-compact ${target.name}: ${held === "held" ? `${formatTokens(tokens)} — held, last /compact not executed` : "not_executed backoff over — eligible again"}`)
    if (held === "held") return
    const lastAttemptAt = this.lastAttempt.get(target.key) ?? 0
    if (lastAttemptAt > 0 && now - lastAttemptAt < COOLDOWN_MS) {
      this.deps.log(`auto-compact ${target.name}: ${formatTokens(tokens)} > ${formatTokens(minTokens)}${trigger === "size" ? "" : ` (${TRIGGER_LABEL[trigger]})`} — cooldown`)
      return
    }
    this.arm(target, tokens, tail, trigger, minTokens)
  }

  // On-demand trigger for one session, whatever its size: the onStop path
  // without the threshold (idle wait, gates, countdown push, CANCEL_MS,
  // inject). Refuses up front what the gates would refuse anyway.
  async test(target: CompactTarget): Promise<TestResult> {
    if (this.deps.threshold() <= 0) return { ok: false, error: "off" }
    const prior = this.pending.get(target.key)
    if (prior?.phase === "injecting" || prior?.phase === "awaiting_boundary") return { ok: false, error: "in_progress" }
    if (await this.deps.agentStatus(target.key) !== "idle") return { ok: false, error: "busy" }
    const lastAttemptAt = this.lastAttempt.get(target.key) ?? 0
    if (lastAttemptAt > 0 && this.deps.now() - lastAttemptAt < COOLDOWN_MS) return { ok: false, error: "cooldown" }
    const tail = target.transcriptPath ? await this.readTail(target.transcriptPath, contextSettled) : null
    if (!tail) return { ok: false, error: "transcript_unreadable" }
    const cur = this.pending.get(target.key) // re-read: the awaits above may have raced a Stop
    if (cur?.phase === "injecting" || cur?.phase === "awaiting_boundary") return { ok: false, error: "in_progress" }
    if (cur) this.abort(target.key, "superseded by a test trigger", false)
    const tokens = contextTokens(tail.entries)
    const waitMs = this.arm(target, tokens ?? 0, tail, "test", this.deps.threshold())
    return { ok: true, waitMs, tokens }
  }

  // The one scheduler for every trigger (size, boundary, test): the gate check
  // once the user has been quiet IDLE_MS; returns the wait.
  private arm(target: CompactTarget, tokens: number, tail: Tail, trigger: Trigger, minTokens: number): number {
    const wait = Math.max(0, this.activityAt(target.key, tail) + IDLE_MS - this.deps.now())
    const p: Pending = {
      phase: "scheduled", target, trigger, minTokens, tokens, timer: null, typingTimer: null,
      offset: 0, injectedAt: 0, minBoundaryAt: 0, boundaryDeadline: 0, notExecuted: false,
    }
    this.pending.set(target.key, p)
    p.timer = this.deps.setTimer(() => { void this.evaluate(target.key, p) }, wait)
    this.watchTyping(target.key, p)
    const why = trigger === "size" ? "" : ` (${TRIGGER_LABEL[trigger]})`
    this.deps.log(`auto-compact ${target.name}: ${formatTokens(tokens)} > ${formatTokens(minTokens)}${why} — check in ${Math.round(wait / 1000)}s`)
    return wait
  }

  // The session's current context size from the same tail read onStop uses
  // (the context gauge's fallback). null = unreadable or unknown since the
  // last compact.
  async contextTokensOf(transcriptPath: string): Promise<number | null> {
    if (!transcriptPath) return null
    const tail = await this.readTail(transcriptPath, contextSettled)
    return tail ? contextTokens(tail.entries) : null
  }

  // SessionStart(source=compact) — a compaction just finished somewhere;
  // settle the boundary watch now instead of on the next poll. It is also a
  // real compaction: the not_executed guard goes.
  async onCompacted(key: string): Promise<void> {
    if (this.guard.clear(key)) this.deps.log(`auto-compact ${key}: compaction seen — not_executed guard cleared`)
    const p = this.pending.get(key)
    if (p?.phase === "awaiting_boundary" || p?.phase === "injecting") await this.checkBoundary(key, p)
  }

  private activityAt(key: string, tail: Tail): number {
    return Math.max(this.lastActivity.get(key) ?? 0, lastHumanPromptAt(tail.entries, tail.fromStart))
  }

  // Parse the transcript's last bytes: start at TAIL_START_BYTES and grow ×4
  // until `enough(entries)` or TAIL_MAX_BYTES. Each step reads and parses only
  // the bytes in front of what is already parsed. The first (cut) line of a
  // window is left for the next step; a half-written last line fails to parse
  // and is skipped.
  private async readTail(path: string, enough: (entries: Entry[]) => boolean): Promise<Tail | null> {
    const size = await this.deps.transcriptSize(path)
    if (size === null) return null
    let entries: Entry[] = []
    let end = size // bytes [end, size) are parsed; `end` is a line start
    for (let n = TAIL_START_BYTES; ; n *= 4) {
      const start = Math.max(0, size - n)
      if (start < end) {
        const text = await this.deps.readTranscript(path, start, end)
        if (text === null) return null
        let body = text
        if (start > 0) {
          const i = text.indexOf("\n")
          body = i < 0 ? "" : text.slice(i + 1) // one line longer than the window: grow
        }
        // The suffix after a newline decodes cleanly, so its byte length is exact.
        end = start === 0 ? 0 : end - Buffer.byteLength(body, "utf8")
        entries = parseLines(body).concat(entries)
      }
      const fromStart = start === 0
      if (fromStart || enough(entries) || n >= TAIL_MAX_BYTES) return { entries, fromStart }
    }
  }

  // Complete lines in [from, to) in SCAN_CHUNK_BYTES reads, each chunk parsed
  // once and handed to `fn`. Returns the offset after the last complete line
  // (a half-written last line is left for the next call), null if unreadable.
  private async forEachChunk(path: string, from: number, to: number, fn: (entries: Entry[]) => void): Promise<number | null> {
    let offset = from
    let chunk = SCAN_CHUNK_BYTES
    while (offset < to) {
      const end = Math.min(to, offset + chunk)
      const text = await this.deps.readTranscript(path, offset, end)
      if (text === null) return null
      const cut = text.lastIndexOf("\n")
      if (cut < 0) {
        if (end >= to) break
        chunk *= 2 // a single line longer than the chunk
        continue
      }
      const complete = text.slice(0, cut + 1)
      offset += Buffer.byteLength(complete, "utf8")
      chunk = SCAN_CHUNK_BYTES
      fn(parseLines(complete))
    }
    return offset
  }

  // Bring the session's scans (background tasks + durable-state pointers) up
  // to the transcript's current end.
  private scanBackground(key: string, path: string): Promise<Scans | null> {
    const fresh = (): Scans => ({ bg: new BackgroundScan(), session: new SessionScan() })
    let st = this.bg.get(key)
    if (!st || st.path !== path) {
      st = { path, offset: 0, scans: fresh(), running: null }
      this.bg.set(key, st)
    }
    if (st.running) return st.running
    const s = st
    s.running = (async () => {
      const size = await this.deps.transcriptSize(path)
      if (size === null) return null
      if (size < s.offset) { s.offset = 0; s.scans = fresh() } // rewritten → rescan
      const offset = await this.forEachChunk(path, s.offset, size, (es) => {
        const now = this.deps.now()
        s.scans.bg.feed(es, now)
        s.scans.session.feed(es, now)
      })
      if (offset === null) return null
      s.offset = offset
      return s.scans
    })().finally(() => { s.running = null })
    return s.running
  }

  private async currentGate(key: string, p: Pending): Promise<{ verdict: GateVerdict; tokens: number | null }> {
    const [tail, scan] = await Promise.all([
      this.readTail(p.target.transcriptPath, contextSettled),
      this.scanBackground(key, p.target.transcriptPath),
    ])
    if (!tail) return { verdict: { ok: false, reason: "below_threshold" }, tokens: null }
    const now = this.deps.now()
    const tokens = contextTokens(tail.entries)
    // Unreadable history: launches may hide in it — refuse rather than compact
    // under a live task.
    const backgroundTasks = scan ? scan.bg.open(now).length : 1
    const [agentStatus, input] = await Promise.all([this.deps.agentStatus(key), this.deps.inputState(key)])
    const verdict = compactGate({
      threshold: this.deps.threshold() > 0 ? p.minTokens : 0,
      tokens,
      now,
      lastUserActivityAt: this.activityAt(key, tail),
      idleMs: IDLE_MS,
      agentStatus,
      backgroundTasks,
      // The countdown push already stamped the cooldown; the fire re-check
      // must not refuse its own attempt.
      lastAttemptAt: p.phase === "countdown" ? 0 : this.lastAttempt.get(key) ?? 0,
      cooldownMs: COOLDOWN_MS,
      input,
      force: p.trigger === "test",
    })
    return { verdict, tokens }
  }

  private async evaluate(key: string, p: Pending): Promise<void> {
    if (this.pending.get(key) !== p || p.phase !== "scheduled") return
    const { verdict, tokens } = await this.currentGate(key, p)
    if (this.pending.get(key) !== p || p.phase !== "scheduled") return
    if (!verdict.ok) {
      this.deps.log(`auto-compact ${p.target.name}: skipped — ${verdict.reason}`)
      this.clear(key, p)
      return
    }
    p.tokens = tokens ?? p.tokens
    p.phase = "countdown"
    this.lastAttempt.set(key, this.deps.now())
    this.consumed.set(key, this.deps.now())
    const secs = Math.round(CANCEL_MS / 1000)
    this.deps.log(`auto-compact ${p.target.name}: push countdown (${formatTokens(p.tokens)}${p.trigger === "size" ? "" : `, ${TRIGGER_LABEL[p.trigger]}`}, ${secs}s)`)
    // No iOS Cancel action yet (docs/auto-compact-api.md) — say how to cancel.
    void this.deps.push("countdown", p.target, `compacting ${p.target.name} in ${secs}s`, countdownBody(p.tokens, p.trigger))
      .catch(() => { /* push is best effort; the inject gate still applies */ })
    p.timer = this.deps.setTimer(() => { void this.fire(key, p) }, CANCEL_MS)
  }

  private async fire(key: string, p: Pending): Promise<void> {
    if (this.pending.get(key) !== p || p.phase !== "countdown") return
    const [{ verdict }, keep] = await Promise.all([this.currentGate(key, p), this.keepText(p)])
    if (this.pending.get(key) !== p || p.phase !== "countdown") return
    if (!verdict.ok) {
      this.deps.log(`auto-compact ${p.target.name}: not injected — ${verdict.reason}`)
      this.clear(key, p)
      return
    }
    // The boundary watch only scans what Claude appends from here on.
    const offset = await this.deps.transcriptSize(p.target.transcriptPath)
    if (this.pending.get(key) !== p || p.phase !== "countdown") return
    if (offset === null) {
      this.deps.log(`auto-compact ${p.target.name}: not injected — transcript unreadable`)
      this.clear(key, p)
      return
    }
    p.offset = offset
    p.injectedAt = this.deps.now()
    p.phase = "injecting"
    this.stopTypingWatch(p)
    const res = await this.deps.inject(key, keep)
    if (this.pending.get(key) !== p) return
    if (!res.ok) {
      this.deps.log(`auto-compact ${p.target.name}: inject refused — ${res.error ?? "unknown"}`)
      this.clear(key, p)
      return
    }
    this.deps.log(`auto-compact ${p.target.name}: injected /compact (${keep === COMPACT_TEXT ? "generic keep" : `keep ${keep.length} chars`})`)
    p.phase = "awaiting_boundary"
    p.boundaryDeadline = this.deps.now() + BOUNDARY_WAIT_MS
    p.timer = this.deps.setTimer(() => { void this.checkBoundary(key, p) }, BOUNDARY_POLL_MS)
  }

  private async checkBoundary(key: string, p: Pending): Promise<void> {
    if (this.pending.get(key) !== p) return
    const fresh = await this.readAppended(p)
    if (this.pending.get(key) !== p) return
    const b = fresh.boundary
    if (b) {
      const pre = b.preTokens || p.tokens
      const post = b.postTokens || fresh.post || 0
      this.deps.log(`auto-compact ${p.target.name}: compact_boundary ${formatTokens(pre)} -> ${formatTokens(post)}`)
      this.guard.clear(key)
      this.clear(key, p)
      try {
        this.deps.recordCompaction?.({ target: p.target, trigger: p.trigger, preTokens: pre, postTokens: post, at: this.deps.now() })
      } catch { /* stats are best effort */ }
      void this.deps.push("done", p.target, `compacted ${p.target.name}: ${formatTokens(pre)} -> ${formatTokens(post)} tokens`, "Context compacted between tasks.")
        .catch(() => { /* best effort */ })
      return
    }
    if (p.phase !== "awaiting_boundary") return
    if (!p.notExecuted && this.deps.now() - p.injectedAt >= NOT_EXECUTED_MS) this.flagNotExecuted(key, p)
    if (this.deps.now() >= p.boundaryDeadline) {
      this.deps.log(`auto-compact ${p.target.name}: no compact_boundary after ${Math.round(BOUNDARY_WAIT_MS / 60_000)} min — giving up`)
      this.clear(key, p)
      return
    }
    if (p.timer) this.deps.clearTimer(p.timer)
    p.timer = this.deps.setTimer(() => { void this.checkBoundary(key, p) }, BOUNDARY_POLL_MS)
  }

  // Enter went in, nothing compacted. The watch keeps polling: a late boundary still counts.
  private flagNotExecuted(key: string, p: Pending): void {
    p.notExecuted = true
    this.guard.record(key, this.deps.now(), p.tokens)
    this.deps.log(`auto-compact ${p.target.name}: not_executed — no compact_boundary ${Math.round(NOT_EXECUTED_MS / 1000)}s after the inject; held until a compaction or the backoff`)
    const { title, body } = notExecutedPush(p.target.name)
    void this.deps.push("failed", p.target, title, body).catch(() => { /* best effort */ })
  }

  // The latest compact_boundary in the complete lines appended since p.offset
  // (and the context size after it); advances p.offset past them. A shrunk
  // (rewritten) file is rescanned from the top, keeping only boundaries
  // stamped at or after the inject.
  private async readAppended(p: Pending): Promise<{ boundary?: CompactBoundary; post: number | null }> {
    const out: { boundary?: CompactBoundary; post: number | null } = { post: null }
    const path = p.target.transcriptPath
    const size = await this.deps.transcriptSize(path)
    if (size === null) return out
    if (size < p.offset) { p.offset = 0; p.minBoundaryAt = p.injectedAt }
    const offset = await this.forEachChunk(path, p.offset, size, (es) => {
      for (const e of es) {
        if (isBoundary(e)) {
          if (p.minBoundaryAt > 0 && !(entryTime(e) >= p.minBoundaryAt)) continue
          out.boundary = compactBoundaries([e])[0]
          out.post = null
        } else if (out.boundary) {
          out.post = contextTokens([e]) ?? out.post
        }
      }
    })
    if (offset !== null) p.offset = offset
    return out
  }

  // `/compact keep: …` from the session's durable state; COMPACT_TEXT when
  // there is no resolver, nothing found, or the lookup fails.
  private async keepText(p: Pending): Promise<string> {
    if (!this.deps.keepState) return COMPACT_TEXT
    try {
      const scans = await this.scanBackground(p.target.key, p.target.transcriptPath)
      if (!scans) return COMPACT_TEXT
      return buildKeep(await this.deps.keepState(p.target, scans.session.snapshot()))
    } catch (err) {
      this.deps.log(`auto-compact ${p.target.name}: keep lookup failed — ${(err as Error)?.message ?? "error"}`)
      return COMPACT_TEXT
    }
  }

  // Typing without submitting fires no hook; the pane is the only witness.
  private watchTyping(key: string, p: Pending): void {
    const tick = async (): Promise<void> => {
      if (this.pending.get(key) !== p || (p.phase !== "scheduled" && p.phase !== "countdown")) return
      const state = await this.deps.inputState(key)
      if (this.pending.get(key) !== p) return
      if (state === "typing") { this.noteUserActivity(key, "user typing"); return }
      p.typingTimer = this.deps.setTimer(() => { void tick() }, TYPING_POLL_MS)
    }
    p.typingTimer = this.deps.setTimer(() => { void tick() }, TYPING_POLL_MS)
  }

  private stopTypingWatch(p: Pending): void {
    if (p.typingTimer) this.deps.clearTimer(p.typingTimer)
    p.typingTimer = null
  }

  private abort(key: string, why: string, logIt: boolean): void {
    const p = this.pending.get(key)
    if (!p) return
    if (logIt || p.phase === "countdown") this.deps.log(`auto-compact ${p.target.name}: ${why}`)
    this.clear(key, p)
  }

  private clear(key: string, p: Pending): void {
    if (p.timer) this.deps.clearTimer(p.timer)
    this.stopTypingWatch(p)
    p.timer = null
    if (this.pending.get(key) === p) this.pending.delete(key)
  }
}
