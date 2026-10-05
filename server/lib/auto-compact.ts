// Smart auto-compact: compact a big session BETWEEN tasks, before Claude Code's
// own auto-compact (~967k) fires mid-task (a 76 s stall observed 2026-10-03).
//
// On a Stop hook the controller reads the session's context size (last main-
// chain assistant usage: input + cache_read + cache_creation). Over
// AUTO_COMPACT_TOKENS (default 600 000, 0 = off) it waits until the user has
// been quiet for IDLE_MS, re-checks every gate, pushes "compacting <name> in
// 60s — cancel?", and after CANCEL_MS — still idle, not cancelled — types
// COMPACT_TEXT into that session's own tmux pane through the guarded inject
// path. When the transcript shows the compact_boundary it pushes the result.
//
// One attempt per Stop; a new Stop or any user prompt / typing supersedes or
// cancels it. A per-session cooldown starts at the countdown push, so a
// cancel also holds the next attempt off for COOLDOWN_MS.
//
// Pure gating + transcript parsing here; the real deps (tmux, APNs, Claude's
// session file) are wired in wiring/auto-compact.ts.

export const DEFAULT_THRESHOLD = 600_000
export const IDLE_MS = 3 * 60_000
export const CANCEL_MS = 60_000
export const COOLDOWN_MS = 30 * 60_000
export const TYPING_POLL_MS = 20_000
export const BOUNDARY_POLL_MS = 15_000
export const BOUNDARY_WAIT_MS = 15 * 60_000
export const COMPACT_TEXT = "/compact keep: current task, open PRs/branches, decisions made, next steps"

// AUTO_COMPACT_TOKENS: unset/blank/garbage → default; 0 (or negative) → off.
export function thresholdFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.AUTO_COMPACT_TOKENS ?? "").trim()
  if (!raw) return DEFAULT_THRESHOLD
  const n = Number(raw)
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD
  return n <= 0 ? 0 : Math.floor(n)
}

// ── Transcript parsing ────────────────────────────────────────────────────

type Entry = Record<string, unknown>

function parseLines(text: string): Entry[] {
  const out: Entry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as unknown
      if (e && typeof e === "object") out.push(e as Entry)
    } catch { /* partial / corrupt line */ }
  }
  return out
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

function usageTotal(e: Entry): number {
  const msg = e.message as Entry | undefined
  const u = msg?.usage as Entry | undefined
  if (!u) return 0
  return num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
}

// Context size = the last main-chain assistant turn's prompt size. Sidechain
// (subagent) entries and synthetic zero-usage messages are skipped. Entries
// before the latest compact_boundary still count only if nothing came after it
// (then the post-compact size is unknown → null).
export function contextTokens(text: string): number | null {
  const entries = parseLines(text)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.type === "system" && e.subtype === "compact_boundary") return null
    if (e.type !== "assistant" || e.isSidechain === true) continue
    const total = usageTotal(e)
    if (total > 0) return total
  }
  return null
}

export interface CompactBoundary {
  uuid: string
  timestamp: string
  preTokens: number
  postTokens: number
  trigger: string
}

export function compactBoundaries(text: string): CompactBoundary[] {
  const out: CompactBoundary[] = []
  for (const e of parseLines(text)) {
    if (e.type !== "system" || e.subtype !== "compact_boundary") continue
    const meta = (e.compactMetadata ?? {}) as Entry
    out.push({
      uuid: typeof e.uuid === "string" ? e.uuid : "",
      timestamp: typeof e.timestamp === "string" ? e.timestamp : "",
      preTokens: num(meta.preTokens),
      postTokens: num(meta.postTokens),
      trigger: typeof meta.trigger === "string" ? meta.trigger : "",
    })
  }
  return out
}

const NOTIFY_TOOL_USE_RE = /<task-notification>[\s\S]*?<tool-use-id>(toolu_[A-Za-z0-9_-]+)<\/tool-use-id>/g
const LAUNCH_ID_RE = /(?:with ID|agentId|task_id|shell_id)[:=]\s*"?([A-Za-z0-9_-]+)/i

function contentBlocks(e: Entry): Entry[] {
  const c = (e.message as Entry | undefined)?.content
  return Array.isArray(c) ? (c as Entry[]) : []
}

function blockText(b: Entry): string {
  if (typeof b.content === "string") return b.content
  if (Array.isArray(b.content)) {
    return (b.content as Entry[]).map((x) => (typeof x.text === "string" ? x.text : "")).join("\n")
  }
  return ""
}

// Background work Claude launched in this session (Bash / Agent with
// run_in_background) that has not reported back. Done = a <task-notification>
// naming its tool_use id, or a KillShell / TaskStop / KillBash naming the
// launch's task id. Unknown shapes err towards "running" — the cost is a
// skipped compaction, never a compaction under a live agent.
export function openBackgroundTasks(text: string): string[] {
  const launched = new Map<string, string>() // tool_use id → task id ("" until the result names it)
  const doneToolUse = new Set<string>()
  const stoppedTask = new Set<string>()
  for (const m of text.matchAll(NOTIFY_TOOL_USE_RE)) doneToolUse.add(m[1]!)
  for (const e of parseLines(text)) {
    if (e.isSidechain === true) continue
    for (const b of contentBlocks(e)) {
      if (b.type === "tool_use" && typeof b.id === "string") {
        const input = (b.input ?? {}) as Entry
        if (input.run_in_background === true) launched.set(b.id, "")
        const name = typeof b.name === "string" ? b.name : ""
        if (/^(KillShell|KillBash|TaskStop)$/.test(name)) {
          for (const k of ["shell_id", "task_id", "bash_id", "id"]) {
            if (typeof input[k] === "string") stoppedTask.add(input[k] as string)
          }
        }
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string" && launched.has(b.tool_use_id)) {
        const m = blockText(b).match(LAUNCH_ID_RE)
        if (m) launched.set(b.tool_use_id, m[1]!)
      }
    }
  }
  const open: string[] = []
  for (const [toolUse, taskId] of launched) {
    if (doneToolUse.has(toolUse)) continue
    if (taskId && stoppedTask.has(taskId)) continue
    open.push(taskId || toolUse)
  }
  return open
}

function isHumanPrompt(e: Entry): boolean {
  if (e.type !== "user" || e.isSidechain === true || e.isMeta === true) return false
  const c = (e.message as Entry | undefined)?.content
  if (typeof c === "string") return !c.includes("<task-notification>")
  if (!Array.isArray(c)) return false
  return (c as Entry[]).some((b) => b.type === "text" && typeof b.text === "string" && !b.text.includes("<task-notification>"))
}

// Last human prompt's time (ms) from the transcript — the idle-window
// fallback when the server restarted and missed the UserPromptSubmit hook.
export function lastHumanPromptAt(text: string): number {
  const entries = parseLines(text)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (!isHumanPrompt(e)) continue
    const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

// ── Gate ──────────────────────────────────────────────────────────────────

export type InputState = "empty" | "typing" | "not_ready" | "unknown"

export interface GateInput {
  threshold: number
  tokens: number | null
  now: number
  lastUserActivityAt: number
  idleMs: number
  agentStatus: string
  backgroundTasks: number
  lastAttemptAt: number
  cooldownMs: number
  input: InputState
}

export type GateReason =
  | "off"
  | "below_threshold"
  | "cooldown"
  | "user_active"
  | "typing"
  | "busy"
  | "background_tasks"
  | "pane_not_ready"

export type GateVerdict = { ok: true } | { ok: false; reason: GateReason }

// Every condition, cheapest first. `agentStatus` is Claude Code's own view
// (~/.claude/sessions/<pid>.json); only an explicit "idle" passes — "busy",
// "waiting" (a dialog) and unknown all refuse.
export function gate(g: GateInput): GateVerdict {
  if (g.threshold <= 0) return { ok: false, reason: "off" }
  if (g.tokens === null || g.tokens <= g.threshold) return { ok: false, reason: "below_threshold" }
  if (g.lastAttemptAt > 0 && g.now - g.lastAttemptAt < g.cooldownMs) return { ok: false, reason: "cooldown" }
  if (g.now - g.lastUserActivityAt < g.idleMs) return { ok: false, reason: "user_active" }
  if (g.input === "typing") return { ok: false, reason: "typing" }
  if (g.agentStatus !== "idle") return { ok: false, reason: "busy" }
  if (g.backgroundTasks > 0) return { ok: false, reason: "background_tasks" }
  if (g.input !== "empty") return { ok: false, reason: "pane_not_ready" }
  return { ok: true }
}

// ── Controller ────────────────────────────────────────────────────────────

export interface CompactTarget {
  key: string
  name: string
  sessionId: string
  transcriptPath: string
}

export type PushKind = "countdown" | "done"

export interface AutoCompactDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  threshold(): number
  readTranscript(path: string): Promise<string | null>
  agentStatus(key: string): Promise<string>
  inputState(key: string): Promise<InputState>
  push(kind: PushKind, target: CompactTarget, title: string, body: string): Promise<void>
  inject(key: string, text: string): Promise<{ ok: boolean; error?: string }>
  log(line: string): void
}

type Phase = "scheduled" | "countdown" | "injecting" | "awaiting_boundary"

interface Pending {
  phase: Phase
  target: CompactTarget
  timer: unknown
  typingTimer: unknown
  tokens: number
  boundariesBefore: number
  boundaryDeadline: number
}

export interface AutoCompactStatus {
  key: string
  phase: Phase
  name: string
  tokens: number
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

  constructor(private deps: AutoCompactDeps) {}

  status(): AutoCompactStatus[] {
    return [...this.pending.entries()].map(([key, p]) => ({ key, phase: p.phase, name: p.target.name, tokens: p.tokens }))
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
  }

  async onStop(target: CompactTarget): Promise<void> {
    const prior = this.pending.get(target.key)
    if (prior?.phase === "injecting" || prior?.phase === "awaiting_boundary") return
    if (prior) this.abort(target.key, "superseded by a new Stop", false)

    const threshold = this.deps.threshold()
    if (threshold <= 0 || !target.transcriptPath) return
    const text = await this.deps.readTranscript(target.transcriptPath)
    if (text === null) return
    const tokens = contextTokens(text)
    if (tokens === null || tokens <= threshold) return
    const now = this.deps.now()
    const lastAttemptAt = this.lastAttempt.get(target.key) ?? 0
    if (lastAttemptAt > 0 && now - lastAttemptAt < COOLDOWN_MS) {
      this.deps.log(`auto-compact ${target.name}: ${formatTokens(tokens)} > ${formatTokens(threshold)} — cooldown`)
      return
    }
    const activity = this.activityAt(target.key, text)
    const wait = Math.max(0, activity + IDLE_MS - now)
    const p: Pending = {
      phase: "scheduled", target, tokens, timer: null, typingTimer: null,
      boundariesBefore: compactBoundaries(text).length, boundaryDeadline: 0,
    }
    this.pending.set(target.key, p)
    p.timer = this.deps.setTimer(() => { void this.evaluate(target.key, p) }, wait)
    this.watchTyping(target.key, p)
    this.deps.log(`auto-compact ${target.name}: ${formatTokens(tokens)} > ${formatTokens(threshold)} — check in ${Math.round(wait / 1000)}s`)
  }

  // SessionStart(source=compact) — a compaction just finished somewhere;
  // settle the boundary watch now instead of on the next poll.
  async onCompacted(key: string): Promise<void> {
    const p = this.pending.get(key)
    if (p?.phase === "awaiting_boundary" || p?.phase === "injecting") await this.checkBoundary(key, p)
  }

  private activityAt(key: string, text: string): number {
    return Math.max(this.lastActivity.get(key) ?? 0, lastHumanPromptAt(text))
  }

  private async currentGate(key: string, p: Pending): Promise<{ verdict: GateVerdict; tokens: number | null }> {
    const text = await this.deps.readTranscript(p.target.transcriptPath)
    if (text === null) return { verdict: { ok: false, reason: "below_threshold" }, tokens: null }
    const tokens = contextTokens(text)
    const [agentStatus, input] = await Promise.all([this.deps.agentStatus(key), this.deps.inputState(key)])
    const verdict = gate({
      threshold: this.deps.threshold(),
      tokens,
      now: this.deps.now(),
      lastUserActivityAt: this.activityAt(key, text),
      idleMs: IDLE_MS,
      agentStatus,
      backgroundTasks: openBackgroundTasks(text).length,
      // The countdown push already stamped the cooldown; the fire re-check
      // must not refuse its own attempt.
      lastAttemptAt: p.phase === "countdown" ? 0 : this.lastAttempt.get(key) ?? 0,
      cooldownMs: COOLDOWN_MS,
      input,
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
    const secs = Math.round(CANCEL_MS / 1000)
    this.deps.log(`auto-compact ${p.target.name}: push countdown (${formatTokens(p.tokens)}, ${secs}s)`)
    void this.deps.push("countdown", p.target, `compacting ${p.target.name} in ${secs}s — cancel?`, `Context ${formatTokens(p.tokens)} tokens. Tap Cancel to keep it as is.`)
      .catch(() => { /* push is best effort; the inject gate still applies */ })
    p.timer = this.deps.setTimer(() => { void this.fire(key, p) }, CANCEL_MS)
  }

  private async fire(key: string, p: Pending): Promise<void> {
    if (this.pending.get(key) !== p || p.phase !== "countdown") return
    const { verdict } = await this.currentGate(key, p)
    if (this.pending.get(key) !== p || p.phase !== "countdown") return
    if (!verdict.ok) {
      this.deps.log(`auto-compact ${p.target.name}: not injected — ${verdict.reason}`)
      this.clear(key, p)
      return
    }
    p.phase = "injecting"
    this.stopTypingWatch(p)
    const res = await this.deps.inject(key, COMPACT_TEXT)
    if (this.pending.get(key) !== p) return
    if (!res.ok) {
      this.deps.log(`auto-compact ${p.target.name}: inject refused — ${res.error ?? "unknown"}`)
      this.clear(key, p)
      return
    }
    this.deps.log(`auto-compact ${p.target.name}: injected /compact`)
    p.phase = "awaiting_boundary"
    p.boundaryDeadline = this.deps.now() + BOUNDARY_WAIT_MS
    p.timer = this.deps.setTimer(() => { void this.checkBoundary(key, p) }, BOUNDARY_POLL_MS)
  }

  private async checkBoundary(key: string, p: Pending): Promise<void> {
    if (this.pending.get(key) !== p) return
    const text = await this.deps.readTranscript(p.target.transcriptPath)
    if (this.pending.get(key) !== p) return
    const all = text === null ? [] : compactBoundaries(text)
    const fresh = all.slice(p.boundariesBefore)
    const b = fresh[fresh.length - 1]
    if (b) {
      const pre = b.preTokens || p.tokens
      const post = b.postTokens || (text ? contextTokens(text) : null) || 0
      this.deps.log(`auto-compact ${p.target.name}: compact_boundary ${formatTokens(pre)} -> ${formatTokens(post)}`)
      this.clear(key, p)
      void this.deps.push("done", p.target, `compacted ${p.target.name}: ${formatTokens(pre)} -> ${formatTokens(post)} tokens`, "Context compacted between tasks.")
        .catch(() => { /* best effort */ })
      return
    }
    if (p.phase !== "awaiting_boundary") return
    if (this.deps.now() >= p.boundaryDeadline) {
      this.deps.log(`auto-compact ${p.target.name}: no compact_boundary after ${Math.round(BOUNDARY_WAIT_MS / 60_000)} min — giving up`)
      this.clear(key, p)
      return
    }
    if (p.timer) this.deps.clearTimer(p.timer)
    p.timer = this.deps.setTimer(() => { void this.checkBoundary(key, p) }, BOUNDARY_POLL_MS)
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
