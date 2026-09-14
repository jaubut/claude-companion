import { broadcast } from "../state"
import { createDialogWatcher, type SessionStatus } from "../lib/dialog-watch"
import type { Dialog } from "../lib/dialogs"
import { listSessions, setSessionStatus } from "../lib/sessions"
import { getPendingQuestions } from "../lib/questions"
import { capturePane } from "../lib/tmux-pane"
import { markWaiting, unmarkWaiting } from "./waiting"

// Dialog mirror: any Claude Code dialog open in a live tmux session (/model,
// /mcp, trust, MCP-enable) is parsed off the pane and pushed to clients as a
// `dialog` frame; keys tapped on the phone go back through /api/dialog/key.
async function readSessionStatus(pid: string): Promise<SessionStatus | null> {
  try {
    const text = await Bun.file(`${process.env.HOME}/.claude/sessions/${pid}.json`).text()
    const j = JSON.parse(text) as { status?: string; waitingFor?: string }
    return { status: j.status ?? "", waitingFor: j.waitingFor ?? "" }
  } catch {
    return null
  }
}

export const dialogWatcher = createDialogWatcher({
  sessions: listSessions,
  capture: capturePane,
  sessionStatus: readSessionStatus,
  hasPendingQuestion: (s) => getPendingQuestions().some((q) => (q.sessionId && q.sessionId === s.sessionId) || q.cwd === s.cwd),
  onDialog(key, dialog) {
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const yellow = "\x1b[33m"; const cyan = "\x1b[36m"
    process.stderr.write(`${dim}[companion]${reset} ${yellow}→ phone${reset} ${cyan}dialog${reset} ${dim}${dialog.title || "(untitled)"} · ${dialog.items.length} rows · ${key}${reset}\n`)
    broadcast({ type: "dialog", key, dialog })
    // A dialog is modal in the terminal: nothing else can be driven while it is
    // up, so it outranks every other waiting reason. Edge-triggered and deduped
    // by signature upstream, so this only fires on a real open. The reason's ref
    // is the key it was opened with — the liveness sweep below can close an
    // already-collapsed key, and unmarkWaiting falls back to that ref.
    markWaiting(key, "dialog", key)
  },
  onDialogClosed(key) {
    broadcast({ type: "dialog_closed", key })
    unmarkWaiting(key, "dialog", key)
  },
  onStatus(key, st) {
    setSessionStatus(key, st.status, st.waitingFor)
  },
})
dialogWatcher.start()

// The dialog currently in the way on `target`, or null. Used by both inject
// paths (POST /api/inject and the WS "input" message) to refuse rather than
// type into an open dialog.
//
// The watcher polls every 2s, so a dialog the user answered a moment ago can
// still be in the map. Re-check that one session before refusing on it: a
// false refusal is user-visible ("I typed and nothing happened"), and the
// re-check is one capture-pane. It also closes the stale entry and broadcasts
// `dialog_closed`, so the phone's badge clears as a side effect.
export async function openDialogFor(target: { key: string } | null | undefined): Promise<Dialog | null> {
  if (!target) return null
  if (!dialogWatcher.current()[target.key]) return null
  await dialogWatcher.refresh(target.key)
  return dialogWatcher.current()[target.key] ?? null
}
