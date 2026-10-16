import { inputText, unstyle } from "./command-menu"
import { parseDialog } from "./dialogs"
import type { HerdrDelivery } from "./herdr-inject"

// A first prompt for a freshly spawned herdr agent (takeover seed, orchestrator
// worker prompt), delivered once nothing stands in the way. A start dialog (MCP
// picker, trust) or text Jeremie typed holds it without spending a try; the
// phone answers the dialog, never a blind key. Pure: the callers own the turns,
// the run state and the herdr calls.

/** Refusals with no dialog in the way (agent not ready…) before the prompt is given up. */
export const SEED_TRIES = 24
export const SEED_RETRY_MS = 5_000
/** A prompt waiting on a dialog or typed input stays pending this long at most. */
export const SEED_WAIT_MS = 2 * 60 * 60_000

/** What stands between a pending prompt and the pane: a dialog (its title, "" when untitled), text Jeremie typed, or nothing. */
export type SeedGate = { kind: "dialog"; title: string } | { kind: "typing" } | { kind: "ready" }

/**
 * A dialog on the screen (parsed like the phone's mirror) or herdr's agent `blocked`; else typed input; else ready.
 * `screen` null = unreadable, which reads as ready (the delivery itself refuses). `agentStatus` is only asked when no dialog shows.
 */
export async function seedGate(screen: () => Promise<string | null>, agentStatus: () => Promise<string | null>): Promise<SeedGate> {
  const raw = await screen()
  const dialog = raw === null ? null : parseDialog(unstyle(raw))
  if (dialog) return { kind: "dialog", title: dialog.title }
  if ((await agentStatus()) === "blocked") return { kind: "dialog", title: "" }
  return raw !== null && inputText(raw) ? { kind: "typing" } : { kind: "ready" }
}

export interface PumpOpts {
  gate: () => Promise<SeedGate>
  deliver: () => Promise<HerdrDelivery>
  /** False once the run or task settled (cancel, done): checked before every pass. */
  stillWanted: () => boolean
  /** Called once per dialog title. */
  onDialog: (title: string) => void
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export type PumpOutcome = { kind: "delivered" } | { kind: "dropped" } | { kind: "gave_up"; reason: string }

/** Deliver once the gate is ready, while wanted; ≤ SEED_TRIES non-dialog refusals and ≤ SEED_WAIT_MS in all. */
export async function pumpPrompt(o: PumpOpts): Promise<PumpOutcome> {
  const since = o.now()
  const alerted = new Set<string>()
  let tries = 0
  let reason = "waited 2 h"
  while (tries < SEED_TRIES && o.now() - since < SEED_WAIT_MS) {
    if (!o.stillWanted()) return { kind: "dropped" }
    const gate = await o.gate()
    if (gate.kind === "dialog" && !alerted.has(gate.title)) {
      alerted.add(gate.title)
      o.onDialog(gate.title)
    }
    if (gate.kind === "ready") {
      const r = await o.deliver()
      if (r.ok) return { kind: "delivered" }
      if (!r.blocked) {
        tries++
        reason = r.reason
      }
    }
    await o.sleep(SEED_RETRY_MS)
  }
  return { kind: "gave_up", reason }
}
