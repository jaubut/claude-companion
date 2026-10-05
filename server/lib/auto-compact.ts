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
// still idle, not cancelled — types COMPACT_TEXT into that session's own tmux
// pane through the guarded inject path. When the bytes appended after the
// inject show a compact_boundary it pushes the result.
//
// One attempt per Stop; a new Stop or any user prompt / typing supersedes or
// cancels it. A per-session cooldown starts at the countdown push, so a
// cancel also holds the next attempt off for COOLDOWN_MS.
//
// Transcripts of >600k sessions are tens of MB: nothing here reads or parses a
// whole file. Checks read a growing tail window (TAIL_START_BYTES ×4 up to
// TAIL_MAX_BYTES) and parse it once; the boundary watch reads only the bytes
// appended since its last poll.
//
// Pure gating + transcript parsing here; the real deps (tmux, APNs, Claude's
// session file) are wired in wiring/auto-compact.ts.

export const IDLE_MS = 3 * 60_000
export const CANCEL_MS = 60_000
export const COOLDOWN_MS = 30 * 60_000
export const TYPING_POLL_MS = 20_000
export const BOUNDARY_POLL_MS = 15_000
export const BOUNDARY_WAIT_MS = 15 * 60_000
// A background launch older than this no longer blocks (its end may have left
// no trace we recognise).
export const BG_MAX_AGE_MS = 2 * 60 * 60_000
export const TAIL_START_BYTES = 256 * 1024
export const TAIL_MAX_BYTES = 16 * 1024 * 1024
export const COMPACT_TEXT = "/compact keep: current task, open PRs/branches, decisions made, next steps"

// AUTO_COMPACT_TOKENS: unset/blank/garbage/0/negative → off (0). Opt-in only.
export function thresholdFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number((env.AUTO_COMPACT_TOKENS ?? "").trim())
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

// ── Transcript parsing ────────────────────────────────────────────────────

export type Entry = Record<string, unknown>

export function parseLines(text: string): Entry[] {
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

function entryTime(e: Entry): number {
  const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN
  return Number.isFinite(t) ? t : NaN
}

function isBoundary(e: Entry): boolean {
  return e.type === "system" && e.subtype === "compact_boundary"
}

function usageTotal(e: Entry): number {
  const msg = e.message as Entry | undefined
  const u = msg?.usage as Entry | undefined
  if (!u) return 0
  return num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
}

// Context size = the last main-chain assistant turn's prompt size. Sidechain
// (subagent) entries and synthetic zero-usage messages are skipped. Nothing
// after the latest compact_boundary → the post-compact size is unknown → null.
export function contextTokens(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (isBoundary(e)) return null
    if (e.type !== "assistant" || e.isSidechain === true) continue
    const total = usageTotal(e)
    if (total > 0) return total
  }
  return null
}

// True when `entries` alone settle contextTokens (a usage turn or a boundary
// is in the window) — the tail need not grow.
function contextSettled(entries: Entry[]): boolean {
  return contextTokens(entries) !== null || entries.some(isBoundary)
}

export interface CompactBoundary {
  uuid: string
  timestamp: string
  preTokens: number
  postTokens: number
  trigger: string
}

export function compactBoundaries(entries: Entry[]): CompactBoundary[] {
  const out: CompactBoundary[] = []
  for (const e of entries) {
    if (!isBoundary(e)) continue
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
const STOP_TOOL_RE = /^(KillShell|KillBash|TaskStop)$/
// Claude Code's success text: "Successfully stopped task: <id> (…)" /
// "Successfully killed shell: <id>".
const STOP_OK_RE = /\bsuccessfully (stopped|killed)\b/i

function contentBlocks(e: Entry): Entry[] {
  const c = (e.message as Entry | undefined)?.content
  return Array.isArray(c) ? (c as Entry[]) : []
}

function blockText(b: Entry): string {
  if (typeof b.text === "string") return b.text
  if (typeof b.content === "string") return b.content
  if (Array.isArray(b.content)) {
    return (b.content as Entry[]).map((x) => (typeof x.text === "string" ? x.text : "")).join("\n")
  }
  return ""
}

// Every string a <task-notification> can sit in: a queue-operation's
// content, a user message's string content or its text / tool_result blocks.
function entryTexts(e: Entry): string[] {
  const out: string[] = []
  if (typeof e.content === "string") out.push(e.content)
  const c = (e.message as Entry | undefined)?.content
  if (typeof c === "string") out.push(c)
  for (const b of contentBlocks(e)) out.push(blockText(b))
  return out
}

// Entries after the latest compact_boundary — earlier history is summarised
// away and must not keep a task "open" forever.
function sinceLastBoundary(entries: Entry[]): Entry[] {
  for (let i = entries.length - 1; i >= 0; i--) if (isBoundary(entries[i]!)) return entries.slice(i + 1)
  return entries
}

// Background work Claude launched in this session (Bash / Agent with
// run_in_background) that has not reported back. Only launches after the
// latest compact_boundary and younger than BG_MAX_AGE_MS count. Done = a
// <task-notification> naming its tool_use id, or a KillShell / TaskStop /
// KillBash naming its task id whose result CONFIRMS the stop (not is_error,
// "Successfully stopped/killed"). Unknown shapes err towards "running" — the
// cost is a skipped compaction, never a compaction under a live agent.
export function openBackgroundTasks(entries: Entry[], now: number): string[] {
  const launched = new Map<string, string>() // tool_use id → task id ("" until the result names it)
  const stopCalls = new Map<string, string>() // stop tool_use id → task id it targets
  const doneToolUse = new Set<string>()
  const stoppedTask = new Set<string>()
  for (const e of sinceLastBoundary(entries)) {
    for (const t of entryTexts(e)) {
      if (t.includes("<task-notification>")) for (const m of t.matchAll(NOTIFY_TOOL_USE_RE)) doneToolUse.add(m[1]!)
    }
    if (e.isSidechain === true) continue
    const t = entryTime(e)
    const tooOld = Number.isFinite(t) && now - t > BG_MAX_AGE_MS
    for (const b of contentBlocks(e)) {
      if (b.type === "tool_use" && typeof b.id === "string") {
        const input = (b.input ?? {}) as Entry
        if (input.run_in_background === true && !tooOld) launched.set(b.id, "")
        if (STOP_TOOL_RE.test(typeof b.name === "string" ? b.name : "")) {
          const k = ["shell_id", "task_id", "bash_id", "id"].find((x) => typeof input[x] === "string")
          if (k) stopCalls.set(b.id, input[k] as string)
        }
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        if (launched.has(b.tool_use_id)) {
          const m = blockText(b).match(LAUNCH_ID_RE)
          if (m) launched.set(b.tool_use_id, m[1]!)
        }
        const target = stopCalls.get(b.tool_use_id)
        if (target && b.is_error !== true && STOP_OK_RE.test(blockText(b))) stoppedTask.add(target)
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

// True when the window holds everything openBackgroundTasks needs: the latest
// boundary, or an entry older than BG_MAX_AGE_MS (launches before it are aged
// out anyway).
function backgroundSettled(entries: Entry[], now: number): boolean {
  return entries.some((e) => isBoundary(e) || now - entryTime(e) > BG_MAX_AGE_MS)
}

function isHumanPrompt(e: Entry): boolean {
  if (e.type !== "user" || e.isSidechain === true || e.isMeta === true) return false
  const c = (e.message as Entry | undefined)?.content
  if (typeof c === "string") return !c.includes("<task-notification>")
  if (!Array.isArray(c)) return false
  return (c as Entry[]).some((b) => b.type === "text" && typeof b.text === "string" && !b.text.includes("<task-notification>"))
}

// Last human prompt's time (ms) — the idle-window fallback when the server
// restarted and missed the UserPromptSubmit hook. `fromStart` = the entries
// begin at the top of the file; otherwise a prompt-less tail window means the
// prompt predates it, so its first timestamp is a safe (late) bound.
export function lastHumanPromptAt(entries: Entry[], fromStart = true): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (!isHumanPrompt(e)) continue
    const t = entryTime(e)
    return Number.isFinite(t) ? t : 0
  }
  if (fromStart) return 0
  for (const e of entries) {
    const t = entryTime(e)
    if (Number.isFinite(t)) return t
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
export function compactGate(g: GateInput): GateVerdict {
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
  transcriptSize(path: string): Promise<number | null>
  // Bytes [start, end) as UTF-8; null when unreadable.
  readTranscript(path: string, start: number, end: number): Promise<string | null>
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
  offset: number // transcript bytes already scanned by the boundary watch
  boundaryDeadline: number
}

interface Tail {
  entries: Entry[]
  fromStart: boolean
  settled: boolean // `enough` held (or the window reached the top of the file)
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
    const tail = await this.readTail(target.transcriptPath, contextSettled)
    if (!tail) return
    const tokens = contextTokens(tail.entries)
    if (tokens === null || tokens <= threshold) return
    const now = this.deps.now()
    const lastAttemptAt = this.lastAttempt.get(target.key) ?? 0
    if (lastAttemptAt > 0 && now - lastAttemptAt < COOLDOWN_MS) {
      this.deps.log(`auto-compact ${target.name}: ${formatTokens(tokens)} > ${formatTokens(threshold)} — cooldown`)
      return
    }
    const activity = this.activityAt(target.key, tail)
    const wait = Math.max(0, activity + IDLE_MS - now)
    const p: Pending = {
      phase: "scheduled", target, tokens, timer: null, typingTimer: null,
      offset: 0, boundaryDeadline: 0,
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

  private activityAt(key: string, tail: Tail): number {
    return Math.max(this.lastActivity.get(key) ?? 0, lastHumanPromptAt(tail.entries, tail.fromStart))
  }

  // Parse the transcript's last bytes once: start at TAIL_START_BYTES and grow
  // ×4 until `enough(entries)` or TAIL_MAX_BYTES. The first (cut) line of a
  // window is dropped; a half-written last line fails to parse and is skipped.
  private async readTail(path: string, enough: (entries: Entry[]) => boolean): Promise<Tail | null> {
    const size = await this.deps.transcriptSize(path)
    if (size === null) return null
    for (let n = TAIL_START_BYTES; ; n *= 4) {
      const start = Math.max(0, size - n)
      const text = await this.deps.readTranscript(path, start, size)
      if (text === null) return null
      const entries = parseLines(start === 0 ? text : text.slice(text.indexOf("\n") + 1))
      const fromStart = start === 0
      if (fromStart || enough(entries)) return { entries, fromStart, settled: true }
      if (n >= TAIL_MAX_BYTES) return { entries, fromStart, settled: false }
    }
  }

  private async currentGate(key: string, p: Pending): Promise<{ verdict: GateVerdict; tokens: number | null }> {
    const now = this.deps.now()
    const tail = await this.readTail(p.target.transcriptPath, (es) => contextSettled(es) && backgroundSettled(es, now))
    if (!tail) return { verdict: { ok: false, reason: "below_threshold" }, tokens: null }
    const tokens = contextTokens(tail.entries)
    // Window capped before it covered the background-task horizon: launches
    // may hide above it — refuse rather than compact under a live task.
    const backgroundTasks = tail.settled ? openBackgroundTasks(tail.entries, now).length : 1
    if (!tail.settled) this.deps.log(`auto-compact ${p.target.name}: tail window capped at ${TAIL_MAX_BYTES >> 20}MB — background tasks unknown`)
    const [agentStatus, input] = await Promise.all([this.deps.agentStatus(key), this.deps.inputState(key)])
    const verdict = compactGate({
      threshold: this.deps.threshold(),
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
    // No iOS Cancel action yet (docs/auto-compact-api.md) — say how to cancel.
    void this.deps.push("countdown", p.target, `compacting ${p.target.name} in ${secs}s`, `Context ${formatTokens(p.tokens)} tokens. To cancel, type anything in the session's pane.`)
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
    // The boundary watch only scans what Claude appends from here on.
    const offset = await this.deps.transcriptSize(p.target.transcriptPath)
    if (this.pending.get(key) !== p || p.phase !== "countdown") return
    if (offset === null) {
      this.deps.log(`auto-compact ${p.target.name}: not injected — transcript unreadable`)
      this.clear(key, p)
      return
    }
    p.offset = offset
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
    const fresh = await this.readAppended(p)
    if (this.pending.get(key) !== p) return
    const b = compactBoundaries(fresh).pop()
    if (b) {
      const pre = b.preTokens || p.tokens
      const post = b.postTokens || contextTokens(fresh) || 0
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

  // Complete lines appended since p.offset; advances p.offset past them. A
  // shrunk file (rewritten) restarts from its current end.
  private async readAppended(p: Pending): Promise<Entry[]> {
    const size = await this.deps.transcriptSize(p.target.transcriptPath)
    if (size === null) return []
    if (size < p.offset) { p.offset = size; return [] }
    const start = p.offset
    if (size === start) return []
    const text = await this.deps.readTranscript(p.target.transcriptPath, start, size)
    if (text === null) return []
    const complete = text.slice(0, text.lastIndexOf("\n") + 1)
    p.offset = start + Buffer.byteLength(complete, "utf8")
    return parseLines(complete)
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
