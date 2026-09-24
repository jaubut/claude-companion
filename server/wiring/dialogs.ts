import { companionLog } from "../lib/log"
import { broadcast } from "../state"
import { createDialogWatcher, type SessionStatus } from "../lib/dialog-watch"
import { isPaneDirty, isScraping, yieldPane } from "../lib/command-scrape"
import { isPaneClean } from "../lib/command-list"
import type { Dialog } from "../lib/dialogs"
import { listSessions, setSessionStatus } from "../lib/sessions"
import { getPendingQuestions } from "../lib/questions"
import { capturePane } from "../lib/tmux-pane"
import { paneKey } from "../lib/tmux-argv"
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
  capture: (pane, socket) => capturePane(pane, undefined, { socket }),
  sessionStatus: readSessionStatus,
  hasPendingQuestion: (s) => getPendingQuestions().some((q) => (q.sessionId && q.sessionId === s.sessionId) || q.cwd === s.cwd),
  isScraping,
  onDialog(key, dialog) {
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const yellow = "\x1b[33m"; const cyan = "\x1b[36m"
    companionLog(`${yellow}→ phone${reset} ${cyan}dialog${reset} ${dim}${dialog.title || "(untitled)"} · ${dialog.items.length} rows · ${key}${reset}`)
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
// Hand the pane back before an inject looks at it.
//
// The companion's own /help scrape holds the input box for tens of seconds and
// puts a modal on screen. A user's message arriving mid-scrape must never be
// refused because of it: ask the scrape to stop (it Escapes the dialog and
// clears the line itself) and wait, bounded, then deliver. Call this BEFORE
// `openDialogFor` — otherwise the check races our own overlay.
//
// Returns TRUE only when the pane is actually free. The first cut returned
// void, and a timed-out abort then fell through to the normal checks with the
// flow still held: the watcher was still skipping that session, so
// `openDialogFor` answered null, the dialog refusal passed, and the user's
// text was typed straight into the open /help modal. A pane we could not take
// back is a refusal (`busy_flow`, 409) — the phone can retry a second later,
// which is strictly better than answering someone else's dialog.
//
// "Could not take back" now covers two shapes, and they are one answer here:
// the flow never let go (timeout), or it let go with the /help overlay still
// on screen (`endFlow(key, {clean:false})` — see lib/command-scrape.ts). The
// pane is equally unusable either way.
//
// The dirty one outlives the flow, and this is where it is settled. A dirty
// release deletes the flow, so a RETRY a moment later finds nothing holding
// the pane; before this it was waved straight through (the watcher had been
// skipping that session all scrape, so `openDialogFor` answered a stale null)
// and typed into the overlay the previous inject had just been refused for.
// Now the mark survives, and the only thing that clears it is the capture
// below saying the pane really is back to an empty prompt.
// Bounded by the caller (VERIFY_TIMEOUT_MS in lib/command-scrape.ts): on
// abort the capture is killed and the answer is "not clean" — the mark stays.
async function paneLooksClean(target: { key: string; tmuxPane?: string; tmuxSocket?: string }, signal: AbortSignal): Promise<boolean> {
  // Refresh first: the watcher skipped this session for the whole scrape, so
  // its map is stale by construction, and if what is left on the pane IS a
  // modal this publishes it — the phone gets the card, the inject path gets a
  // real `dialog_open` refusal, and the user can Escape it from the phone
  // instead of waiting on a mark to expire.
  await dialogWatcher.refresh(target.key)
  if (!target.tmuxPane || signal.aborted) return false
  const text = await capturePane(target.tmuxPane, signal, { socket: target.tmuxSocket || undefined })
  return text !== null && !signal.aborted && isPaneClean(text)
}

export async function yieldPaneForInject(
  target: { key: string; tmuxPane?: string; tmuxSocket?: string } | null | undefined,
): Promise<boolean> {
  if (!target) return true
  const wasDirty = isPaneDirty(target.key)
  // `pane` makes the hand-over wait out an Escape window any route left open on
  // this pane (lib/key-gate.ts). The delivery itself goes through the same
  // gate; this keeps the verdict honest, so freed never means "free, but a
  // chord window is still open".
  const { held, freed } = await yieldPane(target.key, { pane: target.tmuxPane ? paneKey(target.tmuxPane, target.tmuxSocket) : undefined, verify: (signal) => paneLooksClean(target, signal) })
  if (held === "list") {
    const dim = "\x1b[2m"; const reset = "\x1b[0m"; const yellow = "\x1b[33m"
    const what = wasDirty ? "command scrape residue" : "command scrape aborted"
    const why = freed
      ? wasDirty ? " (pane re-checked: clean)" : ""
      : wasDirty ? " (pane re-checked: still not clean)"
      : isScraping(target.key) ? " (timed out — pane still held)"
      : " (released dirty — overlay may still be up)"
    companionLog(`${yellow}${what}${reset} ${dim}for inject → ${target.key}${why}${reset}`)
  }
  return freed
}

export async function openDialogFor(target: { key: string } | null | undefined): Promise<Dialog | null> {
  if (!target) return null
  if (!dialogWatcher.current()[target.key]) return null
  await dialogWatcher.refresh(target.key)
  return dialogWatcher.current()[target.key] ?? null
}

// The target's pane as it is right now, styled (`capture-pane -e`), for the
// inject guard's pane_not_ready check (lib/inject-guard.ts). Undefined when
// there is no tmux pane to read (nothing to check); null when the capture
// failed or stalled past the deadline (refused — never typed into blind).
const PANE_SNAPSHOT_TIMEOUT_MS = 1_000

export async function paneSnapshotFor(
  target: { tmuxPane?: string; tmuxSocket?: string } | null | undefined,
): Promise<string | null | undefined> {
  if (!target?.tmuxPane) return undefined
  return capturePane(target.tmuxPane, AbortSignal.timeout(PANE_SNAPSHOT_TIMEOUT_MS), { escapes: true, socket: target.tmuxSocket || undefined })
}
