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
  // True while the companion itself is driving that session's pane through
  // /help (lib/command-scrape.ts). The overlay on screen is ours.
  isScraping(key: string): boolean
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

  // Our own /help scrape is not a dialog the user has to deal with. Mirroring
  // it put "Help  General  Commands  Custom commands" on the phone, marked
  // the session waiting-on-a-dialog, and made every inject refuse with "has a
  // dialog open" for the ~2 minutes the scrape ran on a cramped pane — which
  // reads, from the phone, as a session that cannot be spawned.
  //
  // Checking once at the top of `check` was not enough: `check` awaits twice
  // (the status file, then the capture) and a scrape that CLAIMS the pane
  // during either await still published one Help card. Every later tick then
  // skipped the session, so nothing ever closed that card — it stuck for the
  // whole scrape. So the test is repeated after each await, and it closes any
  // entry already open for that key rather than leaving it to a later tick
  // that will not come.
  function ours(key: string): boolean {
    if (!deps.isScraping(key)) return false
    close(key)
    return true
  }

  async function check(s: Session): Promise<void> {
    if (!s.tmuxPane) { close(s.key); return }
    if (ours(s.key)) return
    const st = s.pid ? await deps.sessionStatus(s.pid) : null
    if (ours(s.key)) return
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
    if (ours(s.key)) return
    const dialog = pane === null ? null : parseDialog(pane)
    // Question pickers are the hooks' business (structured card + driver);
    // mirroring one — e.g. for the second the driver is still typing after
    // the phone answered — would put a stray dialog card on the phone.
    if (!dialog || dialog.kind === "question") { close(s.key); return }
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
