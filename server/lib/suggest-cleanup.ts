// The `/` suggest probe's input-line handling (routes/command.ts), for tmux
// and herdr panes alike.
//
// The probe types `/prefix` into the session's real input box and must hand
// the pane back empty. "The C-u was sent" is not proof of that: a send can
// fail (herdr subprocess killed at the gate deadline, tmux error) or land
// without clearing, and a pane released as clean with `/prefix` still in the
// box gets the next phone message typed on top of it. So the release verdict
// is a fresh `-e` read of the input line after the clear, and anything short
// of an empty line ends the flow `clean:false` (a mark the next inject must
// clear by verifying the pane, lib/command-scrape.ts).

import { CLEAR_LINE_KEY, inputLine, mayClearLine } from "./command-menu"
import { CLEAR_SETTLE_MS } from "./command-list"
import { endFlow } from "./command-scrape"
import { companionLog } from "./log"

export interface ClearablePane {
  // escapes = a `capture-pane -e` shape (dim ghost text reads as empty).
  capture(escapes?: boolean): Promise<string | null>
  key(key: string): Promise<boolean>
}

const yellow = "\x1b[33m"; const reset = "\x1b[0m"

// C-u only over an empty line or text this flow typed itself. The line is
// read fresh, with -e, right before the key: anything else on it (a phone
// prompt whose Enter never landed, the user typing at the keyboard) is left
// alone and the caller is told so. Returns true when the line is ours to have
// cleared (or already empty) and the C-u, if one was needed, was sent.
export async function clearIfOurs(pane: ClearablePane, owned: readonly string[], who: string): Promise<boolean> {
  const typed = inputLine(await pane.capture(true) ?? "")
  if (!mayClearLine(typed, owned)) {
    companionLog(`${yellow}commands${reset} left the input line alone on ${who} — not ours: ${JSON.stringify((typed ?? "<unreadable>").slice(0, 40))}`)
    return false
  }
  if (typed === "") return true
  return pane.key(CLEAR_LINE_KEY)
}

// Clear what the probe typed, let the pane redraw, and read the line back.
// True only when the input line now reads empty.
export async function leaveInputEmpty(
  pane: ClearablePane,
  owned: readonly string[],
  who: string,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const sent = await clearIfOurs(pane, owned, who)
  await sleep(CLEAR_SETTLE_MS)
  if (!sent) return false
  const left = inputLine(await pane.capture(true) ?? "")
  if (left === "") return true
  companionLog(`${yellow}commands${reset} input line NOT empty after the probe on ${who}: ${JSON.stringify((left ?? "<unreadable>").slice(0, 40))} — released dirty`)
  return false
}

// End the probe's flow with the verdict of its cleanup. An empty line keeps
// endFlow's default (clean, no statement about older marks); anything else
// releases `clean:false`. Returns the verdict.
export async function finishSuggestProbe(
  key: string,
  pane: ClearablePane,
  owned: readonly string[],
  who: string,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  let clean = false
  try {
    clean = await leaveInputEmpty(pane, owned, who, sleep)
  } finally {
    endFlow(key, clean ? {} : { clean: false })
  }
  return clean
}
