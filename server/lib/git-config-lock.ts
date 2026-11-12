import { type Stats, lstatSync, readFileSync, readdirSync, readlinkSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"

/** The /proc reads clearStaleGitConfigLock makes; injectable for tests. */
export interface ProcReader {
  pids(): string[]; mountinfo(pid: string): string; fds(pid: string): string[]; fdTarget(pid: string, fd: string): string; uid(pid: string): number
}
const realProc: ProcReader = {
  pids: () => readdirSync("/proc").filter((p) => /^\d+$/.test(p)),
  mountinfo: (pid) => readFileSync(`/proc/${pid}/mountinfo`, "utf8"),
  fds: (pid) => readdirSync(`/proc/${pid}/fd`),
  fdTarget: (pid, fd) => readlinkSync(`/proc/${pid}/fd/${fd}`),
  uid: (pid) => statSync(`/proc/${pid}`).uid,
}
const exited = (err: unknown) => { const c = (err as NodeJS.ErrnoException).code; return c === "ENOENT" || c === "ESRCH" }

/**
 * Claude Code's Linux sandbox ro-binds /dev/null over `.git/config.lock` of the repo a worktree belongs to (hard-coded
 * in the CLI, no setting turns it off). A sandbox killed mid-command leaves that mount point on the host as a 0-byte
 * 0444 file, and every later `git config` write there fails ("could not lock config file"). Remove it unless some live
 * process still has it mounted or open. A live process whose mountinfo can't be read, or one running as the lock's
 * owner whose fd table can't be read, counts as a holder; other users' fd tables are always unreadable (root daemons,
 * non-dumpable processes) and are skipped, their mountinfo already read clean. Without /proc (macOS, where the sandbox
 * doesn't do this) it is left alone.
 */
export function clearStaleGitConfigLock(repoDir: string, proc: ProcReader = realProc): void {
  const lock = join(repoDir, ".git", "config.lock")
  try {
    const st = lstatSync(lock)
    const isStub = (s: Stats) => s.isFile() && s.size === 0 && (s.mode & 0o222) === 0
    if (!isStub(st)) return
    const mountPoint = ` ${lock.replace(/ /g, "\\040")} `
    for (const pid of proc.pids()) {
      try { if (proc.mountinfo(pid).includes(mountPoint)) return } catch (err) { if (exited(err)) continue; return }
      let fds: string[]
      try { fds = proc.fds(pid) } catch (err) {
        if (exited(err)) continue
        try { if (proc.uid(pid) !== st.uid) continue } catch (e) { if (exited(e)) continue }
        return
      }
      for (const fd of fds) {
        try { if (proc.fdTarget(pid, fd) === lock) return } catch (err) { if (!exited(err)) return }
      }
    }
    // Same file as the one validated before the scan: a real git lock created meanwhile is a new inode (or not 0444).
    // ponytail: the lstat → unlink gap is still a race (Node has no unlink-by-fd); it is microseconds, and git only
    // creates config.lock with O_EXCL, i.e. after this stub is already gone.
    const now = lstatSync(lock)
    if (!isStub(now) || now.dev !== st.dev || now.ino !== st.ino || now.ctimeMs !== st.ctimeMs) return
    unlinkSync(lock)
  } catch { /* no stub, or no /proc */ }
}
