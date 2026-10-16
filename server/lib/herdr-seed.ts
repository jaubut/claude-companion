import { inputText, unstyle } from "./command-menu"
import { parseDialog } from "./dialogs"
import type { HerdrDelivery } from "./herdr-inject"

// A first prompt for a freshly spawned herdr agent (takeover seed, orchestrator
// worker prompt), delivered once nothing stands in the way. A start dialog (MCP
// picker, trust) or text Jeremie typed holds it without spending a try; the
// phone answers the dialog, never a blind key. Pure: the callers own the turns,
// the run state and the herdr calls.

/** Refusals with no dialog in the way and no wait to sit out (see WAIT_CODES) before the prompt is given up. */
export const SEED_TRIES = 24
export const SEED_RETRY_MS = 5_000
/** A prompt waiting on a dialog or typed input stays pending this long at most. */
export const SEED_WAIT_MS = 2 * 60 * 60_000

/** Refusals that mean "not yet" (a slow boot): waited out like a dialog, bounded by SEED_WAIT_MS, never a try. */
const WAIT_CODES: readonly string[] = ["agent_not_ready"]
/** Refusals no retry can fix (a prompt herdr cannot take, the agent gone from its pane): give up at once. */
const FATAL_CODES: readonly string[] = ["leading_dash", "agent_gone"]

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

export interface LandedIO {
  screen: () => Promise<string | null>
  agentStatus: () => Promise<string | null>
  /** One Enter through the pane's key gate (herdrGatedKey); true once sent. */
  enter: () => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}

/** Time for Claude Code to take a submitted prompt before the re-check. */
export const SUBMIT_SETTLE_MS = 500

/**
 * Did a refused delivery land anyway? herdr-inject's key gate gives up after a few
 * seconds while `agent prompt` may still go through, so a timeout is not proof of
 * nothing typed. In: herdr's agent `working`, or the prompt's opening in the
 * transcript (above the input box). The paste sitting UNSUBMITTED in the input box
 * (its opening, or a long paste's `[Pasted text #N …]` marker: Enter was lost) gets
 * one Enter, then counts as in once the agent works or the box is empty. Never re-pasted.
 */
export async function promptLanded(text: string, io: LandedIO): Promise<boolean> {
  if ((await io.agentStatus()) === "working") return true
  const head = squash(text.split("\n").find((l) => l.trim()) ?? "").slice(0, 60)
  const raw = head ? await io.screen() : null
  if (raw === null) return false
  const box = inputText(raw)
  if (box && (squash(box).includes(head) || PASTED_RE.test(box))) {
    if (!(await io.enter())) return false
    await io.sleep(SUBMIT_SETTLE_MS)
    if ((await io.agentStatus()) === "working") return true
    const after = await io.screen()
    return after !== null && inputText(after) === ""
  }
  // The box does not hold it, so a match on the screen is in the transcript above it.
  return squash(unstyle(raw)).includes(head)
}

const PASTED_RE = /\[Pasted text #\d+/i
const squash = (s: string): string => s.replace(/\s+/g, " ").trim()

export interface PumpOpts {
  gate: () => Promise<SeedGate>
  deliver: () => Promise<HerdrDelivery>
  /** Asked after a non-dialog refusal, before retrying: true = it went in after all (promptLanded). */
  landed?: () => Promise<boolean>
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
      if (FATAL_CODES.includes(r.code ?? "")) return { kind: "gave_up", reason: r.reason }
      const wait = r.blocked || WAIT_CODES.includes(r.code ?? "")
      if (!wait && o.landed && await o.landed()) return { kind: "delivered" }
      if (!wait) {
        tries++
        reason = r.reason
      }
    }
    await o.sleep(SEED_RETRY_MS)
  }
  return { kind: "gave_up", reason }
}
