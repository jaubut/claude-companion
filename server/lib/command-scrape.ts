// Who is currently driving a session's input box on the companion's behalf
// (PRJ-OR1T Phase 16b, hardened).
//
// Two flows type into a live pane: the `/` suggestion probe (~1.5s) and the
// full `/help` scrape (tens of seconds — it opens a real, modal Claude Code
// dialog and pages it). The scrape is the one that bites:
//
//   - the dialog watcher saw our own /help overlay, mirrored it to the phone
//     as "Help  General  Commands  Custom commands", and marked the session
//     waiting-on-a-dialog;
//   - every inject then refused with "has a dialog open" — a dialog WE opened.
//     From the phone that reads as "the session I just spawned is broken".
//
// So the set is not an implementation detail of the route: it is the fact both
// the watcher and the inject guard need. The watcher skips a scraping session
// (there is nothing to mirror — the dialog is ours), and inject asks the
// scrape to get out of the way, bounded, instead of refusing.
//
// Deliberately module state, not DI: it is a per-process fact about a pane,
// like a lock, and both consumers must see the same one. The consumers that
// need testing (`dialog-watch.ts`) take it as a dep.

export type PaneFlow = "suggest" | "list"

interface FlowState {
  kind: PaneFlow
  since: number
  abort: boolean
  waiters: Array<(clean: boolean) => void>
}

const flows = new Map<string, FlowState>()

// How long an inject waits for an aborted scrape to release the pane. The
// scrape checks the abort flag between every keystroke and after each fixed
// sleep, so the realistic worst case is one Escape + settle; this is the
// backstop for a wedged tmux, and it is well under the phone's HTTP timeout.
export const SCRAPE_ABORT_WAIT_MS = 5_000

// Claim the pane. False when another flow already holds it (the caller answers
// `busy_flow`); the claim is released by `endFlow` in a finally.
export function beginFlow(key: string, kind: PaneFlow): boolean {
  if (flows.has(key)) return false
  flows.set(key, { kind, since: Date.now(), abort: false, waiters: [] })
  return true
}

// Release the claim, and say in what STATE the pane is being handed back.
//
// `clean` is the verdict of the flow's own cleanup — for the scrape, whether
// `closeHelpOverlay` actually saw the pane come back with no overlay and an
// empty input line. It has to travel to the waiters: the first cut had no
// verdict at all, so `closeHelpOverlay` could answer `clean:false` and the
// route's `finally { endFlow(key) }` would release anyway, every waiter would
// resolve `freed:true`, and the inject that had asked for the pane typed
// straight into the still-open /help modal. A dirty release is a `busy_flow`
// refusal on both inject paths instead — recoverable, unlike answering
// somebody else's dialog.
//
// Defaults to clean: the `/` suggest probe ends with a C-u and has nothing to
// leave behind, and `resetFlows()` in tests is not a statement about a pane.
export function endFlow(key: string, opts: { clean?: boolean } = {}): void {
  const st = flows.get(key)
  if (!st) return
  flows.delete(key)
  const clean = opts.clean !== false
  for (const w of st.waiters) {
    try { w(clean) } catch { /* a waiter that throws must not strand the others */ }
  }
}

export function isFlowActive(key: string): boolean {
  return flows.has(key)
}

// The /help scrape specifically — the only flow that puts a dialog on screen.
export function isScraping(key: string): boolean {
  return flows.get(key)?.kind === "list"
}

// Read by the scrape loop between steps.
export function scrapeAbortRequested(key: string): boolean {
  return flows.get(key)?.abort === true
}

// Wait, bounded, for whoever holds the pane to release it AND to release it
// clean. True only when the pane is usable now: no flow (or one that released
// with `clean`). False on timeout, and false on a dirty release — the flow let
// go but left an overlay or typed text on screen, which for the caller is the
// same problem as never getting the pane at all.
export function waitForFlow(key: string, timeoutMs: number = SCRAPE_ABORT_WAIT_MS): Promise<boolean> {
  const st = flows.get(key)
  if (!st) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    st.waiters.push((clean) => finish(clean))
  })
}

// Ask the scrape to stop, then wait for it. The scrape does its own cleanup
// (Escape closes the help dialog, C-u clears the line) before it releases, so
// the caller that wakes up here finds the input box exactly as the user left
// it — and if it could NOT, it says so through `endFlow(key, {clean:false})`
// and this resolves false. A no-op on a session with no flow, or on the short
// suggest probe — which has no abort points and is simply waited out.
export function abortScrape(key: string, timeoutMs: number = SCRAPE_ABORT_WAIT_MS): Promise<boolean> {
  const st = flows.get(key)
  if (!st) return Promise.resolve(true)
  st.abort = true
  return waitForFlow(key, timeoutMs)
}

// The `/` suggestion probe holds the pane for ~1.5s and has no abort points
// (it ends with a C-u that would eat a message injected mid-probe), so it is
// simply waited out.
export const SUGGEST_WAIT_MS = 3_000

export interface PaneYield {
  // Which flow was holding the pane when we asked, if any.
  held: PaneFlow | null
  // The pane is free NOW, and clean. False means either the flow is still
  // holding it, or it let go with our /help overlay still on screen. Either
  // way the caller must refuse (`busy_flow`) rather than type into an unknown
  // screen: while the flow was held the dialog watcher was skipping that
  // session, so the dialog check cannot see the modal that may still be up.
  freed: boolean
}

// Take the pane back for someone else (an inject). Aborts a scrape, waits out
// a suggest probe, both bounded. The decision is here rather than in the
// wiring so it can be tested without booting the watcher.
export async function yieldPane(
  key: string,
  opts: { abortMs?: number; waitMs?: number } = {},
): Promise<PaneYield> {
  const held = flows.get(key)?.kind ?? null
  if (!held) return { held: null, freed: true }
  if (held === "list") return { held, freed: await abortScrape(key, opts.abortMs ?? SCRAPE_ABORT_WAIT_MS) }
  return { held, freed: await waitForFlow(key, opts.waitMs ?? SUGGEST_WAIT_MS) }
}

// Tests only: drop every claim.
export function resetFlows(): void {
  for (const key of [...flows.keys()]) endFlow(key)
}
