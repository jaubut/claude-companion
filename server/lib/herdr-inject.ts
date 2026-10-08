// herdr delivery for phone messages and the AskUserQuestion picker. Lives
// apart from keyboard-inject.ts (which imports it) — this module must never
// import keyboard-inject back, so the inject time limits live here.

import { keyGate } from "./key-gate"
import { type Herdr, herdrErrorCode, herdrGateKey, herdrSendKey, herdrSendText, realHerdr } from "./herdr"
import type { PickerIO } from "./question-driver"

// An inject's key-gate turn must START within INJECT_QUEUE_MS of the call or
// it is refused, never typed late (Codex round 3: a wedged sender held it, and
// the global lock, forever); once started it is bounded by INJECT_SEND_MS.
export const INJECT_QUEUE_MS = 2_000
export const INJECT_SEND_MS = 4_000

// Slash commands (/exit, /clear, /model …) and `!` bash-mode run locally in
// Claude Code and never fire UserPromptSubmit, so "no hook" is not evidence
// of a lost prompt for them (log 2026-09-25: `/exit` delivered, session
// ended, then flagged "not submitted"). Their proof, when there is one, is
// the session ending or clearing — see noteSessionBoundary.
// A slash command is `/name` whose first word has no second `/` — an
// absolute path like `/Users/me/file.txt` is a normal prompt and fires the hook.
export function isHooklessInput(text: string): boolean {
  const t = text.trim()
  if (t.startsWith("!")) return true
  return /^\/[A-Za-z][\w:.-]*(?:\s|$)/.test(t)
}

export type HerdrDelivery = { ok: true } | { ok: false; blocked: boolean; reason: string }

// One key-gate turn on the herdr pane (same Escape-window rules as tmux).
// Normal text: `herdr agent prompt` (bracketed paste + Enter as one write; it
// refuses with agent_blocked while an approval/question is up). A slash
// command or `!` input is TYPED instead (send-text + Enter): Claude Code never
// executes a pasted slash command (see inject-verified.ts). That path has no
// built-in blocked check, so it asks `agent get` first.
export async function deliverViaHerdr(
  pane: string,
  text: string,
  opts: { typed?: boolean; deadline?: number; herdr?: Herdr } = {},
): Promise<HerdrDelivery> {
  // herdr 0.9.3 has no `--` end-of-options separator (`agent prompt` takes
  // `--` as the text), so text with a leading dash would parse as an option.
  if (text.startsWith("-")) return { ok: false, blocked: false, reason: "leading_dash" }
  const h = opts.herdr ?? realHerdr
  const typed = opts.typed ?? isHooklessInput(text)
  try {
    return await keyGate.send(herdrGateKey(pane), "Enter", async (): Promise<HerdrDelivery> => {
      if (!typed) {
        await h.call(["agent", "prompt", pane, text])
        return { ok: true }
      }
      const got = await h.call(["agent", "get", pane])
      if ((got.agent as { agent_status?: string } | undefined)?.agent_status === "blocked") {
        return { ok: false, blocked: true, reason: "agent_blocked" }
      }
      await h.call(["pane", "send-text", pane, text])
      await h.call(["pane", "send-keys", pane, "enter"])
      return { ok: true }
    }, { startBy: opts.deadline ?? Date.now() + INJECT_QUEUE_MS, timeoutMs: INJECT_SEND_MS })
  } catch (err) {
    const code = herdrErrorCode(err)
    return { ok: false, blocked: code === "agent_blocked", reason: err instanceof Error ? err.message : String(err) }
  }
}

// herdr pane: readable (`pane read`) and keyed (`pane send-keys`/`send-text`).
export function herdrPickerIO(pane: string): PickerIO {
  return {
    capture: () => realHerdr.read(pane),
    key: (name) => herdrSendKey(pane, name),
    digit: (n) => herdrSendKey(pane, String(n)),
    text: (t) => herdrSendText(pane, t),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}
