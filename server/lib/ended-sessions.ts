// Ended Claude sessions whose herdr pane is still open: "Ended · Resume".
//
// Jeremie (2026-10-26): "once I close a session I still see the terminal and
// can easily resume the exact session (for MCP reloads)". A herdr-spawned
// claude that exits (/exit, a crash) leaves its pane at the shell — the
// workspace stays open unless COMPANION_HERDR_AUTOCLOSE=1 — so instead of
// dropping the row, the session is kept here and the phone shows it ended,
// with Resume: `claude --resume <id>` typed into that SAME pane.
//
// Kept apart from the sessions Map (like lib/shell-sessions.ts): an ended
// session must never be an inject, triage or canvas target. On the wire it is
// appended to the session list as `agent: "ended"`.
//
// A record lives while its pane does. herdr reuses pane ids ("w6:p1"), so the
// pane's terminal id is captured at the end and must still match: a new
// workspace that got the same pane id is not ours. A live session showing up
// in the pane (the resume landed, or someone started claude there) also ends
// the record.

import { type Herdr, herdrPaneAtShell, herdrPaneOf, realHerdr } from "./herdr"
import { SESSION_ID_RE } from "./recent-sessions"

export const ENDED_KEY_PREFIX = "ended:"

export interface EndedSession {
  key: string // "ended:<sessionId>"
  sessionId: string
  agent: string // "claude" | "kimi" — what ran
  title: string
  label: string
  cwd: string
  herdrPane: string
  terminalId: string
  endedAt: number
}

// The fields the ended session needs from the sessions registry.
export interface EndedSource {
  sessionId: string
  sidConfirmed: boolean
  agent: string
  title: string
  label: string
  cwd: string
  herdrPane?: string
  tmuxPane?: string
}

export function endedWire(e: EndedSession): Record<string, unknown> {
  return {
    key: e.key,
    agent: "ended",
    endedAgent: e.agent,
    label: e.label,
    title: e.title,
    cwd: e.cwd,
    sessionId: e.sessionId,
    tty: "",
    herdrPane: e.herdrPane,
    firstSeenAt: e.endedAt,
    lastSeenAt: e.endedAt,
    endedAt: e.endedAt,
    agentStatus: "",
    waitingFor: "",
    model: "",
  }
}

// Worth keeping: a herdr pane (and no tmux pane — herdrPaneOf), a confirmed
// session id in resume shape, and an agent `claude --resume` can bring back.
// Codex resumes differently; a guessed session id would resume the wrong chat.
export function resumable(s: EndedSource): boolean {
  return !!herdrPaneOf(s) && s.sidConfirmed && SESSION_ID_RE.test(s.sessionId) && s.agent !== "codex"
}

// The pane's terminal id, or null when herdr says the pane is gone.
async function paneTerminal(pane: string, h: Herdr): Promise<string | null> {
  try {
    const r = await h.call(["pane", "get", pane], 2_000)
    const t = (r.pane as { terminal_id?: unknown } | undefined)?.terminal_id
    return typeof t === "string" ? t : ""
  } catch {
    return null
  }
}

type Listener = (ended: EndedSession[]) => void

export function createEndedStore(opts: { herdr?: Herdr; now?: () => number } = {}) {
  const h = opts.herdr ?? realHerdr
  const now = opts.now ?? Date.now
  const byKey = new Map<string, EndedSession>()
  const listeners = new Set<Listener>()
  const emit = () => {
    const list = [...byKey.values()]
    for (const fn of listeners) {
      try { fn(list) } catch { /* ignore */ }
    }
  }

  return {
    list: (): EndedSession[] => [...byKey.values()],
    get: (key: string): EndedSession | undefined => byKey.get(key),
    on(fn: Listener): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    // A session left the registry (SessionEnd, pid-dead prune). Kept only
    // when resumable and its pane still exists; `live` = the registry now.
    async note(s: EndedSource, live: () => Array<{ herdrPane?: string; tmuxPane?: string }>): Promise<boolean> {
      if (!resumable(s)) return false
      const pane = herdrPaneOf(s)
      if (live().some((o) => herdrPaneOf(o) === pane)) return false
      const terminalId = await paneTerminal(pane, h)
      if (terminalId === null) return false
      const key = `${ENDED_KEY_PREFIX}${s.sessionId}`
      // One row per pane: a second end in the same pane replaces the first.
      for (const [k, e] of byKey) if (e.herdrPane === pane) byKey.delete(k)
      byKey.set(key, {
        key, sessionId: s.sessionId, agent: s.agent, title: s.title, label: s.label, cwd: s.cwd,
        herdrPane: pane, terminalId, endedAt: now(),
      })
      emit()
      return true
    },

    drop(key: string): void {
      if (byKey.delete(key)) emit()
    },

    // Drop every record whose pane is gone, is now someone else's (terminal
    // id changed), or has a live session in it again. Emits on a change.
    async sweep(live: () => Array<{ herdrPane?: string; tmuxPane?: string }>): Promise<boolean> {
      let changed = false
      for (const e of [...byKey.values()]) {
        const occupied = live().some((o) => herdrPaneOf(o) === e.herdrPane)
        const t = occupied ? null : await paneTerminal(e.herdrPane, h)
        if (occupied || t === null || (e.terminalId && t !== e.terminalId)) {
          byKey.delete(e.key)
          changed = true
        }
      }
      if (changed) emit()
      return changed
    },
  }
}

export type EndedStore = ReturnType<typeof createEndedStore>

export const endedStore = createEndedStore()

// ── Resume ───────────────────────────────────────────────────────────────

export function resumeCommand(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`bad session id: ${JSON.stringify(sessionId)}`)
  return `claude --resume ${sessionId}`
}

export type ResumeOutcome =
  | { ok: true; via: "pane" }
  | { ok: false; error: "target_gone" | "bad_resume" | "pane_gone" | "pane_busy" | "send_failed" }

export interface ResumeDeps {
  herdr?: Herdr
  // The pane's key-gate turn (herdr.ts herdrGatedText / herdrGatedKey).
  sendText: (pane: string, text: string) => Promise<boolean>
  sendKey: (pane: string, key: string) => Promise<boolean>
}

// Types `claude --resume <id>` + Enter into the ended session's own pane —
// only while it is still the same pane (terminal id) with its shell in front.
// `pane_gone` tells the caller to fall back to a new terminal.
export async function resumeInPane(store: EndedStore, key: string, deps: ResumeDeps): Promise<ResumeOutcome> {
  const h = deps.herdr ?? realHerdr
  const e = store.get(key)
  if (!e) return { ok: false, error: "target_gone" }
  if (!SESSION_ID_RE.test(e.sessionId)) return { ok: false, error: "bad_resume" }
  const t = await paneTerminal(e.herdrPane, h)
  if (t === null || (e.terminalId && t !== e.terminalId)) {
    store.drop(key)
    return { ok: false, error: "pane_gone" }
  }
  if (!(await herdrPaneAtShell(e.herdrPane, h))) return { ok: false, error: "pane_busy" }
  if (!(await deps.sendText(e.herdrPane, resumeCommand(e.sessionId)))) return { ok: false, error: "send_failed" }
  if (!(await deps.sendKey(e.herdrPane, "Enter"))) return { ok: false, error: "send_failed" }
  return { ok: true, via: "pane" }
}

// Records whose pane closed (or was taken back) leave within a few seconds.
// Idle (no herdr call) while there is nothing to watch.
export const ENDED_SWEEP_MS = 5_000

export function startEndedSweep(live: () => Array<{ herdrPane?: string; tmuxPane?: string }>, store: EndedStore = endedStore): () => void {
  let busy = false
  const timer = setInterval(() => {
    if (busy || store.list().length === 0) return
    busy = true
    void store.sweep(live).finally(() => { busy = false })
  }, ENDED_SWEEP_MS)
  return () => clearInterval(timer)
}
