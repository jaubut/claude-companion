// Session registry — tracks each active Claude Code instance, so the phone
// can pick which terminal an injected reply goes to instead of always hitting
// the frontmost macOS app.
//
// Identity rule: a "session" is a *terminal window*, not a cwd. When the same
// terminal cds between projects or runs /resume, it stays one entry with a
// sticky `label` chosen from the first cwd seen. The `cwd` field tracks the
// most recent working directory for hooks that care (e.g. branch guard).
//
// Key resolution (first non-empty wins), scoped by agent:
//   1. tty          — stable for a terminal window's lifetime
//   2. iTermSessionId — stable within an iTerm tab
//   3. sessionId    — stable per agent invocation
//   4. cwd          — last-resort fallback for legacy hooks
//
// The agent prefix matters because macOS recycles TTY names. Without it, a new
// Codex process on /dev/ttys007 can inherit an old iOS cache entry from a
// previous Claude process that used the same TTY.

export interface Session {
  key: string
  agent: "claude" | "codex" | "kimi"
  label: string
  // The chat's name: first real prompt of the session (see session-titles.ts).
  // Empty until a prompt lands or a resolver recovers it from the transcript.
  title: string
  // sessionId came from an authoritative source (hook payload, Claude Code's
  // ~/.claude/sessions/<pid>.json, or the transcript itself) rather than a
  // newest-transcript-in-this-cwd guess. Guesses never name a chat.
  sidConfirmed: boolean
  // Claude Code's own view of the session, from ~/.claude/sessions/<pid>.json:
  // "busy" | "waiting" | "idle" and what it waits for ("dialog open", …).
  agentStatus: string
  waitingFor: string
  cwd: string
  sessionId: string
  termProgram: string
  tty: string
  iTermSessionId: string
  // tmux pane id (e.g. "%12") when Claude is running inside a tmux pane —
  // hook reads $TMUX_PANE from its env and forwards it as a header. When
  // present, inject uses `tmux send-keys` (pane-id-keyed, no focus race)
  // instead of AppleScript (focus-bound, swap-prone with multiple windows).
  tmuxPane: string
  // The orchestrator task this session is a worker for, from
  // X-Companion-Task-Id (COMPANION_TASK_ID in the worker's env, issued at
  // dispatch). Empty for every session a human started — identity is issued,
  // never inferred (PRJ-OR1T Phase 8).
  taskId: string
  // "Waiting for input" as a property of the session, not of the host
  // (PRJ-OR1T Phase 9). Set by the Stop hook, cleared when THIS session gets
  // input; 0 means not waiting. The host-wide rollup every client used to read
  // is derived at read time by waitingSummary(), never stored.
  waitingSince: number
  waitingKind: string
  pid: string
  firstSeenAt: number
  lastSeenAt: number
}

type Listener = (sessions: Session[]) => void

const sessions = new Map<string, Session>()
const listeners = new Set<Listener>()

// An agent session can sit idle for hours between turns (user went AFK,
// waiting on review, etc.) without firing a hook. Pruning on last-seen alone
// drops those still-alive sessions, which means the phone's pin goes stale
// while the terminal is literally still open. So: trust process liveness as
// the primary signal, and only fall back to last-seen when the pid is missing
// or ambiguous (which would otherwise let orphans linger forever).
const PRUNE_AFTER_MS_NO_PID = 60 * 60 * 1000
const PRUNE_INTERVAL_MS = 60 * 1000

function isAgentPidAlive(pid: string, agent: Session["agent"]): boolean {
  if (!pid) return false
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 1) return false
  // `kill -0` only tells us a process with that pid exists. After pid reuse it
  // could be anything, so verify the command name still matches the agent.
  try {
    const res = Bun.spawnSync(["ps", "-p", String(n), "-o", "comm="])
    if (!res.success) return false
    const comm = new TextDecoder().decode(res.stdout).trim()
    const base = comm.split("/").pop() ?? comm
    if (agent === "codex") return base === "codex"
    return base === "claude"
  } catch {
    return false
  }
}

function prune(now: number): boolean {
  let changed = false
  for (const [key, s] of sessions) {
    if (s.pid) {
      if (!isAgentPidAlive(s.pid, s.agent)) {
        sessions.delete(key)
        changed = true
      }
      continue
    }
    if (now - s.lastSeenAt > PRUNE_AFTER_MS_NO_PID) {
      sessions.delete(key)
      changed = true
    }
  }
  return changed
}

// Periodic background prune so idle sessions disappear without waiting for
// the next hook to trigger an opportunistic prune.
let pruneTimer: ReturnType<typeof setInterval> | null = null
function ensurePruneTimer(): void {
  if (pruneTimer) return
  pruneTimer = setInterval(() => {
    if (prune(Date.now())) emit()
  }, PRUNE_INTERVAL_MS)
  // Don't keep the event loop alive just for pruning.
  if (typeof (pruneTimer as unknown as { unref?: () => void }).unref === "function") {
    (pruneTimer as unknown as { unref: () => void }).unref()
  }
}
ensurePruneTimer()

function deriveKey(meta: Partial<Session> & { cwd: string }): string {
  const agent = meta.agent === "codex" ? "codex" : "claude"
  if (meta.tty) return `${agent}:tty:${meta.tty}`
  if (meta.iTermSessionId) return `${agent}:iterm:${meta.iTermSessionId}`
  if (meta.sessionId) return `${agent}:sid:${meta.sessionId}`
  return `${agent}:cwd:${meta.cwd}`
}

function hasTtyIdentity(key: string): boolean {
  return key.startsWith("tty:") || key.includes(":tty:")
}

function hasStrongIdentity(key: string): boolean {
  return hasTtyIdentity(key) || key.startsWith("iterm:") || key.includes(":iterm:")
}

function basename(cwd: string): string {
  if (!cwd) return ""
  return cwd.split("/").filter(Boolean).pop() ?? cwd
}

// Tail of the tty for disambiguation when two sessions share a cwd.
// macOS `/dev/ttys017` → `s017`; Linux `/dev/pts/8` → `pts8`. Empty if we
// don't have a tty yet. (Linux ttys used to fall through untagged, which is
// why every Zettlab session launched from $HOME was labelled "aubut".)
export function ttyTag(tty: string): string {
  const mac = tty.match(/ttys?(\d+)$/)
  if (mac) return `s${mac[1]}`
  const pts = tty.match(/pts\/(\d+)$/)
  return pts ? `pts${pts[1]}` : ""
}

function makeLabel(cwd: string, tty: string): string {
  const base = basename(cwd)
  const tag = ttyTag(tty)
  if (!base && !tag) return ""
  if (!tag) return base
  if (!base) return tag
  return `${base} · ${tag}`
}

export interface RecordOptions {
  // Provisional sources (discovery, rehydrate) know the cwd but not the
  // session root the user cares about — the first real hook with a cwd from
  // claude-code's own session sets the label. For provisional records we skip
  // the label so the UI falls back to the tty (e.g. "ttys009") until a real
  // hook lands, which avoids labelling every discovered session "jeremieaubut"
  // when claudes were launched from HOME.
  provisional?: boolean
  // Whether meta.sessionId is exact. Hooks and rehydrate are exact; a ps
  // discovery that fell back to the newest transcript in the cwd is not.
  // Defaults to true for non-provisional records.
  sessionIdConfirmed?: boolean
}

export function recordSession(
  meta: Partial<Session> & { cwd: string },
  opts: RecordOptions = {},
): Session | null {
  if (!meta.cwd) return null
  const now = Date.now()
  const key = deriveKey(meta)
  const prev = sessions.get(key)

  const mergedTty = meta.tty || prev?.tty || ""
  // Always include the tty tag when we have one so the picker can distinguish
  // sessions that share a cwd. When two Claude windows run from the same repo
  // they'd otherwise collide to an identical "claude-companion" label.
  // Session-id trust: a guess never overwrites a confirmed id, and a
  // confirmed id that differs from what we had drops the old title so the
  // resolver names the chat from the right transcript.
  const incomingSid = meta.sessionId || ""
  const incomingConfirmed = opts.sessionIdConfirmed ?? !opts.provisional
  let sessionId = prev?.sessionId || ""
  let sidConfirmed = prev?.sidConfirmed ?? false
  let titleReset = false
  if (incomingSid && (incomingConfirmed || !sidConfirmed)) {
    if (incomingConfirmed && sessionId && sessionId !== incomingSid) titleReset = true
    sessionId = incomingSid
    sidConfirmed = incomingConfirmed
  }

  const explicitLabel = meta.label?.trim() ?? ""
  const generatedLabel = opts.provisional && !prev?.label
    ? ""
    : makeLabel(meta.cwd, mergedTty)
  const nextLabel = explicitLabel || generatedLabel

  const next: Session = {
    key,
    agent: meta.agent || prev?.agent || "claude",
    label: nextLabel || prev?.label || "",
    title: meta.title?.trim() || (titleReset ? "" : prev?.title || ""),
    sidConfirmed,
    agentStatus: meta.agentStatus ?? prev?.agentStatus ?? "",
    waitingFor: meta.waitingFor ?? prev?.waitingFor ?? "",
    cwd: meta.cwd,
    sessionId,
    termProgram: meta.termProgram || prev?.termProgram || "",
    tty: mergedTty,
    iTermSessionId: meta.iTermSessionId || prev?.iTermSessionId || "",
    tmuxPane: meta.tmuxPane || prev?.tmuxPane || "",
    // Sticky: ps-discovery and rehydrate re-record a worker with no headers at
    // all, and must not erase the identity a hook already established.
    taskId: meta.taskId || prev?.taskId || "",
    // Same stickiness, and for the same reason: cli.ts re-runs discovery on an
    // interval with no waiting fields at all, so a plain merge would blink
    // every waiting badge off on the next tick.
    waitingSince: meta.waitingSince ?? prev?.waitingSince ?? 0,
    waitingKind: meta.waitingKind ?? prev?.waitingKind ?? "",
    pid: meta.pid || prev?.pid || "",
    // Creation time is the picker's sort key — keep the earliest we know
    // (a discovery pass may report the real process start after a hook
    // registered the session as "now").
    firstSeenAt: Math.min(prev?.firstSeenAt ?? now, meta.firstSeenAt ?? now),
    lastSeenAt: now,
  }
  sessions.set(key, next)

  if (!prev && next.pid && meta.firstSeenAt === undefined) {
    void backfillStart(key, next.pid)
  }
  if (!next.title && next.sessionId && next.sidConfirmed && titleResolver && !resolvingTitle.has(key)) {
    resolvingTitle.add(key)
    titleResolver(next)
      .then((t) => { if (t) setSessionTitle(key, t) })
      .catch(() => { /* best effort */ })
      .finally(() => resolvingTitle.delete(key))
  }

  // When a hook fires with a stronger identity than what rehydrate seeded, the
  // weaker entry (e.g. sid:/cwd:) refers to the same terminal — drop it so the
  // picker doesn't show duplicates for one window.
  let collapsed = false
  if (hasTtyIdentity(key)) {
    for (const [otherKey, s] of sessions) {
      if (otherKey === key) continue
      if (hasStrongIdentity(otherKey)) continue
      if (s.agent !== next.agent) continue
      const sameCwd = s.cwd === next.cwd
      const sameSid = next.sessionId && s.sessionId === next.sessionId
      if (sameCwd || sameSid) {
        // Waiting is the only field with no re-derivation path: a Stop hook
        // that fired without a tty (the Linux `?` case) set it on the weaker
        // record, and deleting that record outright would lose it for good.
        // Everything else here re-derives itself within one poll.
        if (!next.waitingSince && s.waitingSince) {
          next.waitingSince = s.waitingSince
          next.waitingKind = s.waitingKind
        }
        sessions.delete(otherKey)
        collapsed = true
      }
    }
  }

  const pruned = prune(now)
  const meaningfulChange =
    collapsed ||
    pruned ||
    !prev ||
    prev.cwd !== next.cwd ||
    prev.agent !== next.agent ||
    prev.label !== next.label ||
    prev.title !== next.title ||
    prev.agentStatus !== next.agentStatus ||
    prev.waitingFor !== next.waitingFor ||
    prev.firstSeenAt !== next.firstSeenAt ||
    prev.tty !== next.tty ||
    prev.termProgram !== next.termProgram ||
    prev.sessionId !== next.sessionId ||
    // Both are load-bearing, not cosmetic: wiring/events.ts broadcasts the
    // frame AND runs reconcileDispatch in the same onSessions callback, and
    // that callback only fires on a meaningful change. A worker that registers
    // via ps-discovery first and gains its identity from a later hook changes
    // no other field here — without these two it would never re-reconcile, and
    // every identity-first bind would silently wait out the 90s degrade.
    prev.taskId !== next.taskId ||
    prev.tmuxPane !== next.tmuxPane ||
    // Shape completeness only: no caller puts waiting in `meta`, so the sticky
    // merge always falls through to prev. The real emit path is the setters.
    prev.waitingSince !== next.waitingSince

  if (meaningfulChange) emit()
  return next
}

// ---- titles + creation time -------------------------------------------------

type TitleResolver = (s: Session) => Promise<string | null>
let titleResolver: TitleResolver | null = null
const resolvingTitle = new Set<string>()

// The server installs this: stored title by session id, else the transcript's
// first prompt. Runs once per session that lacks a title.
export function setTitleResolver(fn: TitleResolver | null): void {
  titleResolver = fn
}

export function setSessionStatus(key: string, status: string, waitingFor: string): void {
  const s = sessions.get(key)
  if (!s || (s.agentStatus === status && s.waitingFor === waitingFor)) return
  s.agentStatus = status
  s.waitingFor = waitingFor
  emit()
}

export function setSessionTitle(key: string, title: string): void {
  const s = sessions.get(key)
  const t = title.trim()
  if (!s || !t || s.title === t) return
  s.title = t
  emit()
}

// ---- waiting for input (PRJ-OR1T Phase 9) -----------------------------------
//
// tmux's model: the flag is per window (`window_activity_flag`), the
// per-session aggregate (`session_activity_flag`) is documented as "1 if any
// window has activity" and is computed on read. Same here — the map below is
// private, and every rollup is derived.

export interface WaitingSession {
  key: string
  cwd: string
  kind: string
  since: number
}

// Returns the epoch ms stamped on the record, or 0 if the key is unknown.
export function setSessionWaiting(key: string, kind: string): number {
  const s = sessions.get(key)
  if (!s) return 0
  s.waitingSince = Date.now()
  s.waitingKind = kind
  emit()
  return s.waitingSince
}

// Idempotent: clearing a session that isn't waiting is a no-op with no emit,
// because the phone can send an answer over both the WS and REST paths.
export function clearSessionWaiting(key: string): boolean {
  const s = sessions.get(key)
  if (!s || !s.waitingSince) return false
  s.waitingSince = 0
  s.waitingKind = ""
  emit()
  return true
}

function waitingList(): WaitingSession[] {
  const out: WaitingSession[] = []
  for (const s of sessions.values()) {
    if (s.waitingSince) out.push({ key: s.key, cwd: s.cwd, kind: s.waitingKind, since: s.waitingSince })
  }
  return out
}

// The three legacy scalars every shipped client still reads, derived from the
// most recent waiter, plus the full list for clients that can address a
// session. Replaces state.ts's host-wide singleton.
export function waitingSummary(): {
  waitingForInput: boolean
  waitingCwd: string
  waitingKey: string
  waitingSessions: WaitingSession[]
} {
  const waitingSessions = waitingList()
  const newest = waitingSessions.reduce<WaitingSession | null>(
    (a, b) => (a && a.since >= b.since ? a : b),
    null,
  )
  return {
    waitingForInput: waitingSessions.length > 0,
    waitingCwd: newest?.cwd ?? "",
    waitingKey: newest?.key ?? "",
    waitingSessions,
  }
}

// Clear on behalf of an inject. With a target, clear exactly that target. With
// none, clear the single waiter if there is exactly one — otherwise clear
// nothing and report how many were waiting, so the caller can log a refusal.
// Guessing here would blank the badge of a session that never got the text.
export function clearWaitingForTarget(target: Session | null): { cleared: Session | null; refused: number } {
  if (target) {
    return { cleared: clearSessionWaiting(target.key) ? target : null, refused: 0 }
  }
  const waiting = waitingList()
  const only = waiting.length === 1 ? sessions.get(waiting[0]!.key) ?? null : null
  if (!only) return { cleared: null, refused: waiting.length }
  clearSessionWaiting(only.key)
  return { cleared: only, refused: 0 }
}

// `ps -o lstart=` for a pid → epoch ms, 0 if unknown.
export async function processStartMs(pid: string): Promise<number> {
  try {
    const p = Bun.spawn(["ps", "-p", pid, "-o", "lstart="], { stdout: "pipe", stderr: "ignore" })
    const raw = (await new Response(p.stdout).text()).trim()
    if ((await p.exited) !== 0) return 0
    const start = Date.parse(raw)
    return Number.isFinite(start) ? start : 0
  } catch {
    return 0
  }
}

// A hook-registered session knows its pid but not when it started; ask ps so
// the picker order survives a companion restart (ps-discovery reports the
// same start time later).
async function backfillStart(key: string, pid: string): Promise<void> {
  const start = await processStartMs(pid)
  const s = sessions.get(key)
  if (!s || !start || start >= s.firstSeenAt) return
  s.firstSeenAt = start
  emit()
}

export function getSessionByKey(key: string): Session | null {
  return sessions.get(key) ?? null
}

// Back-compat + graceful lookup: accept either a session key or a cwd. The
// frontend now sends `key`, but legacy clients and the HTTP inject endpoint
// may still pass a cwd. Match directly on key first, then fall back to any
// session whose current cwd matches.
export function resolveSession(target: string): Session | null {
  if (!target) return null
  const direct = sessions.get(target)
  if (direct) return direct
  if (target.startsWith("tty:")) {
    const tty = target.slice("tty:".length)
    for (const s of sessions.values()) {
      if (s.tty === tty) return s
    }
  }
  if (target.startsWith("iterm:")) {
    const iTermSessionId = target.slice("iterm:".length)
    for (const s of sessions.values()) {
      if (s.iTermSessionId === iTermSessionId) return s
    }
  }
  if (target.startsWith("sid:")) {
    const sessionId = target.slice("sid:".length)
    for (const s of sessions.values()) {
      if (s.sessionId === sessionId) return s
    }
  }
  if (target.startsWith("cwd:")) {
    const cwd = target.slice("cwd:".length)
    for (const s of sessions.values()) {
      if (s.cwd === cwd) return s
    }
  }
  for (const s of sessions.values()) {
    if (s.cwd === target) return s
  }
  return null
}

export function removeSessionByCwd(cwd: string): boolean {
  let removed = false
  for (const [key, s] of sessions) {
    if (s.cwd === cwd) {
      sessions.delete(key)
      removed = true
    }
  }
  if (removed) emit()
  return removed
}

export function removeSessionByKey(key: string): boolean {
  const existed = sessions.delete(key)
  if (existed) emit()
  return existed
}

// Precise removal by tty — preferred over removeSessionByCwd when a
// session-end hook arrives with a tty header, so we don't accidentally drop
// a sibling session that happens to share the same cwd.
export function removeSessionByTty(tty: string): boolean {
  if (!tty) return false
  let removed = false
  for (const [key, s] of sessions) {
    if (s.tty === tty) {
      sessions.delete(key)
      removed = true
    }
  }
  if (removed) emit()
  return removed
}

// Precise removal by tmux pane — the tmux equivalent of removeSessionByTty,
// for workers whose hooks report a pane but no usable tty. Without it a
// session-end from one worker falls through to removeSessionByCwd and takes
// every sibling session in that directory with it.
export function removeSessionByTmuxPane(pane: string): boolean {
  if (!pane) return false
  let removed = false
  for (const [key, s] of sessions) {
    if (s.tmuxPane === pane) {
      sessions.delete(key)
      removed = true
    }
  }
  if (removed) emit()
  return removed
}

export function listSessions(): Session[] {
  return Array.from(sessions.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

export function onSessions(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(): void {
  const snapshot = listSessions()
  for (const fn of listeners) {
    try { fn(snapshot) } catch { /* ignore */ }
  }
}

export function metaFromHeaders(headers: Headers): Partial<Session> {
  const raw = (name: string): string => {
    const v = headers.get(name) ?? ""
    // Claude Code hooks sometimes emit "not a tty" when stdin is piped — treat
    // that as absent so we don't key a session on garbage.
    return v === "not a tty" ? "" : v
  }
  return {
    termProgram: raw("x-companion-term-program"),
    agent: raw("x-companion-agent") === "codex" ? "codex" : "claude",
    tty: raw("x-companion-tty"),
    iTermSessionId: raw("x-companion-iterm-session-id"),
    tmuxPane: raw("x-companion-tmux-pane"),
    taskId: raw("x-companion-task-id"),
    pid: raw("x-companion-pid"),
  }
}
