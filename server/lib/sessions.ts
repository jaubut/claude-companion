// Session registry — tracks each active Claude Code instance by cwd, so the
// phone can pick which terminal an injected reply goes to instead of always
// hitting the frontmost macOS app.
//
// Hooks send tty / TERM_PROGRAM / iTerm session id alongside every event;
// this module keeps the freshest snapshot per cwd and broadcasts changes.

export interface Session {
  cwd: string
  sessionId: string
  termProgram: string
  tty: string
  iTermSessionId: string
  pid: string
  lastSeenAt: number
}

type Listener = (sessions: Session[]) => void

const sessions = new Map<string, Session>()
const listeners = new Set<Listener>()

const PRUNE_AFTER_MS = 60 * 60 * 1000

function prune(now: number): boolean {
  let changed = false
  for (const [key, s] of sessions) {
    if (now - s.lastSeenAt > PRUNE_AFTER_MS) {
      sessions.delete(key)
      changed = true
    }
  }
  return changed
}

export function recordSession(meta: Partial<Session> & { cwd: string }): Session | null {
  if (!meta.cwd) return null
  const now = Date.now()
  const prev = sessions.get(meta.cwd)
  const next: Session = {
    cwd: meta.cwd,
    sessionId: meta.sessionId || prev?.sessionId || "",
    termProgram: meta.termProgram || prev?.termProgram || "",
    tty: meta.tty || prev?.tty || "",
    iTermSessionId: meta.iTermSessionId || prev?.iTermSessionId || "",
    pid: meta.pid || prev?.pid || "",
    lastSeenAt: now,
  }
  sessions.set(meta.cwd, next)

  const pruned = prune(now)
  const meaningfulChange =
    pruned ||
    !prev ||
    prev.tty !== next.tty ||
    prev.termProgram !== next.termProgram ||
    prev.sessionId !== next.sessionId

  if (meaningfulChange) emit()
  return next
}

export function getSession(cwd: string): Session | null {
  return sessions.get(cwd) ?? null
}

export function removeSession(cwd: string): boolean {
  const existed = sessions.delete(cwd)
  if (existed) emit()
  return existed
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
  return {
    termProgram: headers.get("x-companion-term-program") ?? "",
    tty: headers.get("x-companion-tty") ?? "",
    iTermSessionId: headers.get("x-companion-iterm-session-id") ?? "",
    pid: headers.get("x-companion-pid") ?? "",
  }
}
