import { parseDialog, dialogSignature, type Dialog } from "./dialogs"
import type { Session } from "./sessions"
import { herdrPaneOf } from "./herdr"

// Watches live tmux and herdr sessions for an open Claude Code dialog (/model, /mcp,
// trust, MCP-enable, a question the hook missed) and mirrors it to clients.
//
// Cheap gate first: Claude Code's ~/.claude/sessions/<pid>.json says
// status "waiting" + waitingFor "dialog open" while a dialog is up, so the
// pane is only captured for sessions in that state (or with no status file,
// older CLIs). AskUserQuestion pickers already routed to the phone by the
// hooks are skipped — the phone has the structured card for those.
//
// An ORPHANED question picker is the exception: once the hook windows lapse
// (or the server restarted and lost them) the phone card is gone but the
// picker is still on screen, and the session sat "waiting · input needed"
// with nothing to tap (2026-10-03: two sessions stuck 1–4 h). A question
// picker on screen with no pending card for QUESTION_ORPHAN_MS is mirrored
// as a plain dialog card — rows + hint keys work on it like on /model.

export interface SessionStatus {
  status: string
  waitingFor: string
}

export interface DialogWatchDeps {
  now?(): number
  sessions(): Session[]
  // The session's screen, plain text: its tmux pane, else its herdr pane.
  capture(s: Session): Promise<string | null>
  sessionStatus(pid: string): Promise<SessionStatus | null>
  hasPendingQuestion(s: Session): boolean
  // A question just answered from the phone: its picker is still on screen
  // while the question driver types the answer — still the hooks' business.
  questionAnsweredRecently?(s: Session): boolean
  // An approval the hooks already routed to the phone: its terminal
  // permission dialog is the hooks' business too (approval card), so it is
  // never mirrored as a second, generic dialog card.
  hasPendingApproval?(s: Session): boolean
  // True while the companion itself is driving that session's pane through
  // /help (lib/command-scrape.ts). The overlay on screen is ours.
  isScraping(key: string): boolean
  onDialog(key: string, dialog: Dialog): void
  onDialogClosed(key: string): void
  onStatus(key: string, status: SessionStatus): void
  // An orphaned question picker: try to re-raise it as a structured question
  // card (lib/orphan-question.ts). True = done, false = mirror it as a dialog.
  raiseOrphanQuestion?(s: Session, pane: string): boolean
  // A question screen parseDialog can't see (the review / Submit screen has
  // no key-hint footer) — still counts for the orphan clock.
  isQuestionScreen?(pane: string): boolean
  // The question picker on this session went away.
  onQuestionPickerGone?(key: string): void
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

// How long a question picker must sit on screen with no phone card before it
// is mirrored. Covers the second or two the driver is still typing an answer
// the phone just gave (that picker must not flash up as a stray card).
export const QUESTION_ORPHAN_MS = 10_000

export function createDialogWatcher(deps: DialogWatchDeps): DialogWatcher {
  const open = new Map<string, { sig: string; dialog: Dialog }>()
  const lastStatus = new Map<string, string>()
  // key → when an un-carded question picker was first seen on screen
  const questionSince = new Map<string, number>()
  const now = deps.now ?? Date.now
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
  function questionGone(key: string): void {
    questionSince.delete(key)
    deps.onQuestionPickerGone?.(key)
  }

  function ours(key: string): boolean {
    if (!deps.isScraping(key)) return false
    close(key)
    return true
  }

  async function check(s: Session): Promise<void> {
    if (!s.tmuxPane && !herdrPaneOf(s)) { close(s.key); return }
    // Status file and pane parser are both Claude Code's. Codex has no
    // per-session status source (~/.codex/sessions holds rollout event logs
    // only), and its TUI parsed with Claude picker rules can mis-light a
    // dialog badge. Add a Codex reader here if Codex ever exposes one.
    if (s.agent !== "claude") { close(s.key); return }
    if (ours(s.key)) return
    const st = s.pid ? await deps.sessionStatus(s.pid) : null
    if (ours(s.key)) return
    if (st) {
      const sig = `${st.status}|${st.waitingFor}`
      if (lastStatus.get(s.key) !== sig) {
        lastStatus.set(s.key, sig)
        deps.onStatus(s.key, st)
      }
      if (st.status !== "waiting") { questionGone(s.key); close(s.key); return }
    }
    if (deps.hasPendingQuestion(s) || deps.hasPendingApproval?.(s)) { questionSince.delete(s.key); close(s.key); return }
    const pane = await deps.capture(s)
    if (ours(s.key)) return
    const dialog = pane === null ? null : parseDialog(pane)
    // Question pickers are the hooks' business (structured card + driver);
    // mirroring one — e.g. for the second the driver is still typing after
    // the phone answered — would put a stray dialog card on the phone.
    const questionScreen = dialog?.kind === "question" || (pane !== null && !!deps.isQuestionScreen?.(pane))
    if (!dialog && !questionScreen) { questionGone(s.key); close(s.key); return }
    if (questionScreen) {
      // Just answered from the phone: the driver is still typing into this
      // picker. Only the question screen is held back — a real /model or
      // trust dialog in the same window still mirrors.
      if (deps.questionAnsweredRecently?.(s)) { questionSince.delete(s.key); close(s.key); return }
      const since = questionSince.get(s.key) ?? now()
      questionSince.set(s.key, since)
      if (now() - since < QUESTION_ORPHAN_MS) { close(s.key); return }
      // Structured card first (Approvals tab); the dialog mirror is the
      // fallback when the transcript has no matching open call.
      if (pane !== null && deps.raiseOrphanQuestion?.(s, pane)) { close(s.key); return }
    } else {
      questionGone(s.key)
    }
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
      for (const key of [...questionSince.keys()]) if (!liveKeys.has(key)) questionSince.delete(key)
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
