import { parseDialog, dialogSignature, type Dialog } from "./dialogs"
import type { Session } from "./sessions"

// Watches live tmux sessions for an open Claude Code dialog (/model, /mcp,
// trust, MCP-enable, a question the hook missed) and mirrors it to clients.
//
// Cheap gate first: Claude Code's ~/.claude/sessions/<pid>.json says
// status "waiting" + waitingFor "dialog open" while a dialog is up, so the
// pane is only captured for sessions in that state (or with no status file,
// older CLIs). AskUserQuestion pickers already routed to the phone by the
// hooks are skipped — the phone has the structured card for those.

export interface SessionStatus {
  status: string
  waitingFor: string
}

export interface DialogWatchDeps {
  sessions(): Session[]
  capture(pane: string): Promise<string | null>
  sessionStatus(pid: string): Promise<SessionStatus | null>
  hasPendingQuestion(s: Session): boolean
  onDialog(key: string, dialog: Dialog): void
  onDialogClosed(key: string): void
  onStatus(key: string, status: SessionStatus): void
  pollMs?: number
}

export interface DialogWatcher {
  start(): void
  stop(): void
  tick(): Promise<void>
  refresh(key: string): Promise<void>
  current(): Record<string, Dialog>
}

const POLL_MS = 2_000

export function createDialogWatcher(deps: DialogWatchDeps): DialogWatcher {
  const open = new Map<string, { sig: string; dialog: Dialog }>()
  const lastStatus = new Map<string, string>()
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  function close(key: string): void {
    if (!open.has(key)) return
    open.delete(key)
    deps.onDialogClosed(key)
  }

  async function check(s: Session): Promise<void> {
    if (!s.tmuxPane) { close(s.key); return }
    const st = s.pid ? await deps.sessionStatus(s.pid) : null
    if (st) {
      const sig = `${st.status}|${st.waitingFor}`
      if (lastStatus.get(s.key) !== sig) {
        lastStatus.set(s.key, sig)
        deps.onStatus(s.key, st)
      }
      if (st.status !== "waiting") { close(s.key); return }
    }
    if (deps.hasPendingQuestion(s)) { close(s.key); return }
    const pane = await deps.capture(s.tmuxPane)
    const dialog = pane === null ? null : parseDialog(pane)
    if (!dialog) { close(s.key); return }
    const sig = dialogSignature(dialog)
    if (open.get(s.key)?.sig === sig) return
    open.set(s.key, { sig, dialog })
    deps.onDialog(s.key, dialog)
  }

  async function tick(): Promise<void> {
    if (ticking) return
    ticking = true
    try {
      const live = deps.sessions()
      const liveKeys = new Set(live.map((s) => s.key))
      for (const key of [...open.keys()]) if (!liveKeys.has(key)) close(key)
      for (const key of [...lastStatus.keys()]) if (!liveKeys.has(key)) lastStatus.delete(key)
      for (const s of live) {
        try { await check(s) } catch { /* one bad pane doesn't stop the sweep */ }
      }
    } finally {
      ticking = false
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), deps.pollMs ?? POLL_MS)
      void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
    async refresh(key) {
      const s = deps.sessions().find((x) => x.key === key)
      if (s) await check(s)
    },
    current() {
      const out: Record<string, Dialog> = {}
      for (const [k, v] of open) out[k] = v.dialog
      return out
    },
  }
}
