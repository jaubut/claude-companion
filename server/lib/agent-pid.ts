import type { Session } from "./sessions"

// Process-liveness helpers for a registered agent session. Type-only import of
// `Session` (erased at runtime) so this stays free of a cycle with the registry
// that calls it.

export function isAgentPidAlive(pid: string, agent: Session["agent"]): boolean {
  if (!pid) return false
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 1) return false
  // `kill -0` only tells us a process with that pid exists. After pid reuse it
  // could be anything, so verify the command name still matches the agent.
  try {
    const res = Bun.spawnSync(["ps", "-p", String(n), "-o", "comm="])
    if (!res.success) return false
    const comm = new TextDecoder().decode(res.stdout).trim()
    const base = comm.split("/").pop() ?? comm
    if (agent === "codex") return base === "codex"
    return base === "claude"
  } catch {
    return false
  }
}

// `ps -o lstart=` for a pid → epoch ms, 0 if unknown.
export async function processStartMs(pid: string): Promise<number> {
  try {
    const p = Bun.spawn(["ps", "-p", pid, "-o", "lstart="], { stdout: "pipe", stderr: "ignore" })
    const raw = (await new Response(p.stdout).text()).trim()
    if ((await p.exited) !== 0) return 0
    const start = Date.parse(raw)
    return Number.isFinite(start) ? start : 0
  } catch {
    return 0
  }
}
