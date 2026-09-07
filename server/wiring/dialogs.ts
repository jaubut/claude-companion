import { broadcast } from "../state"
import { createDialogWatcher, type SessionStatus } from "../lib/dialog-watch"
import { listSessions, setSessionStatus } from "../lib/sessions"
import { getPendingQuestions } from "../lib/questions"
import { capturePane } from "../lib/tmux-pane"

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
  },
  onDialogClosed(key) {
    broadcast({ type: "dialog_closed", key })
  },
  onStatus(key, st) {
    setSessionStatus(key, st.status, st.waitingFor)
  },
})
dialogWatcher.start()
