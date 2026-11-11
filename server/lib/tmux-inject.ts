import { KeyGateTimeout, keyGate } from "./key-gate"
import { paneKey, tmuxArgv, tmuxSocketFlags } from "./tmux-pane"
import { INJECT_QUEUE_MS, INJECT_SEND_MS } from "./herdr-inject"

// $TMUX_PANE is always "%N" (pane id). Reject anything else — stale targets,
// session names, or accidentally-shell-quoted strings — before we spawn tmux.
export const TMUX_PANE_RE = /^%\d+$/

export interface TmuxResult {
  ok: boolean
  reason: string
}

export type TmuxSender = (args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<TmuxResult>
export async function tmuxSendKeys(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<TmuxResult> {
  try {
    // `args` may lead with `-S <socket>` (tmuxSocketFlags): global flags go
    // before the command, so they are passed straight through.
    const proc = Bun.spawn([...tmuxArgv(), ...args], { stdout: "pipe", stderr: "pipe" })
    // Killed on its own timeout AND when the key gate aborts the turn.
    const kill = () => { try { proc.kill() } catch { /* already exited */ } }
    const timer = setTimeout(kill, timeoutMs)
    if (signal?.aborted) kill()
    signal?.addEventListener("abort", kill, { once: true })
    try {
      const stderr = (await new Response(proc.stderr).text()).trim()
      await proc.exited
      const code = proc.exitCode ?? 1
      if (code === 0) return { ok: true, reason: "" }
      return { ok: false, reason: stderr || `exit ${code}` }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", kill)
    }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

// Exported with an injectable sender for the tests only.
export async function deliverViaTmux(
  paneId: string,
  text: string,
  sendKeys: TmuxSender = tmuxSendKeys,
  deadline: number = Date.now() + INJECT_QUEUE_MS,
  socket = "",
  canDeliver?: () => boolean,
): Promise<TmuxResult> {
  // Two send-keys calls — first with `-l` (literal) so the text is typed
  // exactly as-is regardless of contents, second to send Enter as a real
  // key event. tmux holds the pty master, so the Enter byte sequence
  // arrives as a key event that Ink's onSubmit fires on (a raw \n in
  // stdin does not — see claude-code issue #15553).
  // Both run as ONE turn of the per-pane key gate (lib/key-gate.ts): the text
  // waits out any open Escape window ("do both" arrived as "o both"), nothing
  // lands between text and Enter, the turn must START by `deadline` (else it
  // is cancelled, never typed late) and is bounded by INJECT_SEND_MS.
  if (!TMUX_PANE_RE.test(paneId)) return { ok: false, reason: `invalid pane id "${paneId}"` }
  try {
    // The gate is keyed by (socket, pane): %3 on `tmux -L cc` and %3 on the
    // default server are two keyboards.
    const flags = tmuxSocketFlags(socket)
    return await keyGate.send(paneKey(paneId, socket), "Enter", async (signal): Promise<TmuxResult> => {
      if (canDeliver && !canDeliver()) return { ok: false, reason: "target_changed" }
      const literal = await sendKeys([...flags, "send-keys", "-t", paneId, "-l", text], 2000, signal)
      if (!literal.ok) return { ok: false, reason: `send-keys -l: ${literal.reason}` }
      if (signal.aborted) return { ok: false, reason: "send-keys -l: timed out" }
      if (canDeliver && !canDeliver()) return { ok: false, reason: "target_changed" }
      const enter = await sendKeys([...flags, "send-keys", "-t", paneId, "Enter"], 2000, signal)
      if (!enter.ok) return { ok: false, reason: `send-keys Enter: ${enter.reason}` }
      return { ok: true, reason: "" }
    }, { startBy: deadline, timeoutMs: INJECT_SEND_MS })
  } catch (err) {
    return { ok: false, reason: err instanceof KeyGateTimeout ? `key gate: ${err.message}` : String(err) }
  }
}
