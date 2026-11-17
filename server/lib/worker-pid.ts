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

/** The parent pid (a worker still parented to the Companion that spawned it has not been orphaned by a restart). */
export function defaultGetParentPid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    if (existsSync(`/proc/${pid}/stat`)) {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[1])
      return Number.isInteger(ppid) ? ppid : null
    }
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", timeout: 1_000 })
    const ppid = Number((ps.stdout ?? "").trim())
    return ps.status === 0 && Number.isInteger(ppid) && ppid > 0 ? ppid : null
  } catch { return null }
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
