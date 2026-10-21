// Create a detached tmux session and confirm the agent inside it survived.
// `tmux new-session -d` exits 0 even when its command dies at once (the session
// ends, an empty server quits), so a 0 exit alone proves nothing. Split out of
// spawn-session.ts so the check is testable with an injected runner.

import { spawnServerFlags, tmuxArgv } from "./tmux-pane"

// Full tmux argv (tmuxArgv() included) → exit code + output; -1 = killed/unspawnable.
export type TmuxArgvRunner = (argv: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>

const runTmuxArgv: TmuxArgvRunner = async (argv, timeoutMs = 1_500) => {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; p.kill() }, timeoutMs)
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    clearTimeout(timer)
    return { code: timedOut ? -1 : code, stdout, stderr: timedOut ? "timed out" : stderr }
  } catch (err) {
    return { code: -1, stdout: "", stderr: (err as Error).message }
  }
}

export interface DetachedDeps {
  run: TmuxArgvRunner
  which: (bin: string) => string | null
  sleep: (ms: number) => Promise<void>
}

export const realDetachedDeps: DetachedDeps = { run: runTmuxArgv, which: (b) => Bun.which(b), sleep: (ms) => Bun.sleep(ms) }

// How long a fresh session must survive before the spawn reports ok.
const SESSION_SURVIVE_MS = 1_500

/** Runs `createArgv` (a new-session -d), then confirms the session lived. Returns an error string, or null on success. */
export async function createConfirmed(sessionName: string, createArgv: string[], deps: DetachedDeps): Promise<string | null> {
  const tmux = (...args: string[]) => deps.run([...tmuxArgv(), ...spawnServerFlags(), ...args])
  // remain-on-exit, chained onto the create, runs before tmux can reap the
  // child — so a pane that dies at once stays readable for the check below.
  const create = await deps.run([...createArgv, ";", "set-window-option", "-t", sessionName, "remain-on-exit", "on"], 8_000)
  if (create.code === -1) return `tmux new-session failed: ${create.stderr.trim()}`
  if (create.code !== 0) return create.stderr.trim() || `tmux exit ${create.code}`

  // detach-on-destroy so a human attaching later (`tmux attach -t cc-foo`) is
  // dropped back to their shell when claude exits, not switched to a sibling
  // session. mouse=on so the wheel scrolls (copy-mode) in a Canvas terminal
  // node attached to it; set per session, never globally. Best-effort: the
  // session works without them.
  await tmux("set-option", "-t", sessionName, "detach-on-destroy", "on", ";", "set-option", "-t", sessionName, "mouse", "on")

  await deps.sleep(SESSION_SURVIVE_MS)
  if ((await tmux("has-session", "-t", `=${sessionName}`)).code !== 0) return "session_exited"
  // remain-on-exit off BEFORE reading pane_dead: a pane dying after this closes
  // normally, one already dead stays readable — no window for a zombie session.
  await tmux("set-window-option", "-t", sessionName, "remain-on-exit", "off")
  // Only a readable "0" is alive: a session that vanished in between fails the
  // read with empty stdout, which must not count as success.
  const dead = await tmux("display-message", "-p", "-t", sessionName, "#{pane_dead}")
  if (dead.code === 0 && dead.stdout.trim() === "0") return null
  if (dead.code !== 0) return "session_exited"
  const tail = (await tmux("capture-pane", "-p", "-t", sessionName)).stdout.trim().split("\n").slice(-5).join("\n").slice(-500)
  await tmux("kill-session", "-t", `=${sessionName}`)
  return tail ? `session_exited: ${tail}` : "session_exited"
}
