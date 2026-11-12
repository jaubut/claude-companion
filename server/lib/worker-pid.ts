import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

// A worker's process group: alive, signalled, and identified across a server restart (boot id + start time), so a
// reloaded record never signals a recycled pid.

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(-pid, 0); return true } catch { return false }
}

export function defaultKillPid(pid: number, sig: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  try { process.kill(-pid, sig) } catch { /* gone */ }
}

export function defaultGetPidIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    if (existsSync(`/proc/${pid}/stat`)) {
      const bootId = existsSync("/proc/sys/kernel/random/boot_id") ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : "linux"
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const rparen = stat.lastIndexOf(")")
      const startTime = rparen > 0 ? stat.slice(rparen + 2).trim().split(/\s+/)[19] ?? "" : ""
      if (startTime) return `${bootId}:${pid}:${startTime}`
    }
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_000 })
    const out = (ps.stdout ?? "").trim()
    return ps.status === 0 && out ? `ps:${pid}:${out}` : null
  } catch { return null }
}
