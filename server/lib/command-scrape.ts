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

import { ESC_SETTLE_MS } from "./command-list"

export type PaneFlow = "suggest" | "list"

interface FlowState {
  kind: PaneFlow
  since: number
  abort: boolean
  waiters: Array<(clean: boolean) => void>
}

const flows = new Map<string, FlowState>()

// When each key last had a flow released on it. The `/help` close path ends in
// an Escape, and Escape is a chord prefix (see ESC_SETTLE_MS in
// lib/command-list.ts): a key arriving inside that window is swallowed. The
// close path already settles, so this is the backstop for everything else that
// can shorten the gap — a throw on the route's path, a release from a flow
// that never ran a close at all.
const releasedAt = new Map<string, number>()

// Panes handed back DIRTY, and by which flow (R1).
//
// A dirty release deletes the flow, so the verdict only ever reached the
// waiters that were already parked on it: the first inject got `freed:false`
// and refused, and an immediate retry a millisecond later saw no flow at all,
// `openDialogFor()` answered null (the watcher had been skipping that session
// for the whole scrape and its next sweep is up to 2s away), and the user's
// text went into the /help modal that is demonstrably still up — the exact
// hole the verdict was added to close, reopened by a retry.
//
// So the verdict outlives the flow: the pane is marked, and every later
// yieldPane on that key has to PROVE the pane is usable (a real capture) before
// it reports it free.
// `seq` identifies THIS mark: a mark cleared and re-set while a verification
// was in flight is a different statement about a different screen, and the
// stale verdict must not clear it (R4c).
interface DirtyMark { kind: PaneFlow; at: number; seq: number }
const dirty = new Map<string, DirtyMark>()
let markSeq = 0

// R4b — a dirty mark does NOT expire on a clock.
//
// It used to: `yieldDirty` deleted any mark older than DIRTY_TTL_MS (10s) and
// returned `freed:true` WITHOUT looking at the pane. That is the same
// absence-of-evidence hand-over the mark exists to prevent, just on a timer —
// a /help overlay left up by a scrape that could not close it is still up at
// t+10s, and the first inject to arrive after that was waved straight into it.
//
// The worry the TTL answered (a mark refusing forever on a healthy pane) is
// answered better by the verifier: every inject path passes one, a clean
// capture clears the mark on the spot, and a pane the user has typed into
// legitimately is not a pane the companion should type into either. The only
// things that clear a mark now are a verified-clean capture and an explicit
// `endFlow(key, {clean:true})`.

// How long an inject waits for an aborted scrape to release the pane. The
// scrape checks the abort flag between every keystroke and after each fixed
// sleep, so the realistic worst case is one Escape + settle; this is the
// backstop for a wedged tmux, and it is well under the phone's HTTP timeout.
export const SCRAPE_ABORT_WAIT_MS = 5_000

// Claim the pane. False when another flow already holds it (the caller answers
// `busy_flow`); the claim is released by `endFlow` in a finally.
//
// R4a — a dirty mark also refuses a `suggest` probe. The probe types `/prefix`
// and reads the menu that pops up; on a pane with our own /help overlay still
// on it that is typing into somebody's modal and parsing the result as a
// command list. It has no cleanup that could fix the pane either — it ends
// with a C-u, which Escape-less leaves the overlay exactly where it was.
// A `list` scrape is allowed through: it drives /help deliberately and its
// close path is the thing that CAN clear the mark (`endFlow(clean:true)`).
export function beginFlow(key: string, kind: PaneFlow): boolean {
  if (flows.has(key)) return false
  if (kind === "suggest" && dirty.has(key)) return false
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
//
// `clean:false` also leaves a MARK on the key (see `dirty` above) — the
// waiters parked on this flow are not the only callers that must not be handed
// this pane. Only an explicit `clean:true` clears a mark: the default is "no
// statement about the pane", and a suggest probe ending normally says nothing
// about an overlay a scrape left behind.
export function endFlow(key: string, opts: { clean?: boolean } = {}): void {
  const st = flows.get(key)
  if (!st) return
  flows.delete(key)
  const clean = opts.clean !== false
  releasedAt.set(key, Date.now())
  if (!clean) dirty.set(key, { kind: st.kind, at: Date.now(), seq: ++markSeq })
  else if (opts.clean === true) dirty.delete(key)
  for (const w of st.waiters) {
    try { w(clean) } catch { /* a waiter that throws must not strand the others */ }
  }
}

// Was this pane handed back dirty and never verified since? Read by the wiring
// for its log line, and by tests. No clock in it any more (R4b): a mark is a
// statement about a screen, and screens do not fix themselves.
export function isPaneDirty(key: string): boolean {
  return dirty.has(key)
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
  // Which flow was holding the pane when we asked — or, when the pane carries
  // a dirty mark and no flow, the flow that left it that way. Either shape
  // means "a companion flow is why this answer is what it is".
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
//
// `verify` is a real look at the pane (capture + `isPaneClean`), supplied by
// the wiring. It is only ever asked on a key that was released dirty, and it
// is the ONLY way such a key becomes free again: no verifier, no hand-over.
// An unverifiable pane is a busy pane — the caller refuses `busy_flow` and the
// phone can retry a second later, which beats typing into someone's modal.
export interface YieldOpts {
  abortMs?: number
  waitMs?: number
  verify?: () => Promise<boolean>
  // The chord window a released Escape opens. Injectable for the tests only.
  settleMs?: number
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// The remainder of the chord window since the last release on this key.
//
// The `/help` close path ends in an Escape and settles ESC_SETTLE_MS itself,
// so this is normally zero. It is not free to skip anyway: the route releases
// in a `finally`, so a throw between the last Escape and the release gets here
// with a hot keyboard, and the inject waiting on that release is exactly the
// caller whose first character disappears.
async function settleAfterRelease(key: string, opts: YieldOpts): Promise<void> {
  const settleMs = opts.settleMs ?? ESC_SETTLE_MS
  const at = releasedAt.get(key)
  if (at === undefined) return
  const remaining = settleMs - (Date.now() - at)
  if (remaining > 0) await (opts.sleep ?? realSleep)(remaining)
}

export async function yieldPane(key: string, opts: YieldOpts = {}): Promise<PaneYield> {
  const held = flows.get(key)?.kind ?? null
  if (!held) return yieldDirty(key, opts)
  const ok = held === "list"
    ? await abortScrape(key, opts.abortMs ?? SCRAPE_ABORT_WAIT_MS)
    : await waitForFlow(key, opts.waitMs ?? SUGGEST_WAIT_MS)
  if (!ok) return { held, freed: false }
  // The flow let go and said the pane is clean. Two things still stand between
  // that and handing the keyboard over:
  if (held === "list") {
    // (1) the close path's last keystroke was an Escape. Anything typed inside
    // its chord window is read as opt+<char> and swallowed — measured as the
    // inject that arrived as "❯ ing".
    await settleAfterRelease(key, opts)
  }
  // (2) R4a — a HELD flow's verdict is about ITS OWN work, not about a mark an
  // earlier flow left on the key. The suggest probe is the case that bit: it
  // releases clean-by-default (a C-u and no opinion), so an inject parked on a
  // suggest probe that started over a dirty pane used to be handed `freed:true`
  // without a single capture, straight into the /help overlay the mark was
  // warning about. Keep `held` from the flow, take `freed` from the mark.
  const verified = await yieldDirty(key, opts)
  return { held, freed: verified.freed }
}

// No flow holds the pane. Free — unless the last flow said otherwise and
// nothing has looked at the pane since.
async function yieldDirty(key: string, opts: YieldOpts): Promise<PaneYield> {
  const mark = dirty.get(key)
  if (!mark) return { held: null, freed: true }
  const clean = opts.verify ? await opts.verify().catch(() => false) : false

  // R4c — `verify()` is a real capture against a real pane: it takes time, and
  // the world moves under it. A scrape that began while we were looking now
  // holds the keyboard, and our verdict describes a screen from before it
  // started typing. Clearing the mark on that and reporting `freed:true` hands
  // an inject a pane somebody else is driving.
  const holder = flows.get(key)
  if (holder) return { held: holder.kind, freed: false }
  const after = dirty.get(key)
  // The mark we verified is gone: only an explicit clean release does that, and
  // that is a stronger statement about the pane than our capture.
  if (after === undefined) return { held: null, freed: true }
  // A DIFFERENT mark — a flow ran and released dirty while we looked. Our
  // capture says nothing about what it left behind.
  if (after.seq !== mark.seq) return { held: after.kind, freed: false }

  if (clean) dirty.delete(key)
  return { held: mark.kind, freed: clean }
}

// Tests only: drop every claim, and every memory of a bad hand-off.
export function resetFlows(): void {
  for (const key of [...flows.keys()]) endFlow(key)
  dirty.clear()
  releasedAt.clear()
}
