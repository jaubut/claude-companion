// The read behind a dirty mark's verify (wiring/dialogs.ts paneLooksClean):
// one styled capture of the session's own pane, tmux (`capture-pane -e`) or
// herdr (`pane read --format ansi`), judged by isPaneClean. Styled on both
// so dim predicted text in an empty input box is not taken for typed input;
// isPaneClean unstyles it for the overlay check itself.

import { isPaneClean } from "./command-list"
import { herdrPaneOf, realHerdr } from "./herdr"
import { capturePane } from "./tmux-pane"

export type CleanTarget = { tmuxPane?: string; tmuxSocket?: string; herdrPane?: string }

export interface PaneReadDeps {
  herdrRead(pane: string, signal: AbortSignal): Promise<string | null>
  tmuxCapture(pane: string, socket: string | undefined, signal: AbortSignal): Promise<string | null>
}

const realReads: PaneReadDeps = {
  herdrRead: (pane, signal) => realHerdr.read(pane, signal),
  tmuxCapture: (pane, socket, signal) => capturePane(pane, signal, { escapes: true, socket }),
}

export async function paneReadsClean(target: CleanTarget, signal: AbortSignal, deps: PaneReadDeps = realReads): Promise<boolean> {
  const herdrPane = herdrPaneOf(target)
  if ((!target.tmuxPane && !herdrPane) || signal.aborted) return false
  const text = herdrPane
    ? await deps.herdrRead(herdrPane, signal)
    : await deps.tmuxCapture(target.tmuxPane!, target.tmuxSocket, signal)
  return text !== null && !signal.aborted && isPaneClean(text)
}
