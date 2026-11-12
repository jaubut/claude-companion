import { dlopen, FFIType } from "bun:ffi"
import { type Stats, closeSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { companionLog } from "./log"

/** The /proc reads clearStaleGitConfigLock makes; injectable for tests. */
export interface ProcReader {
  pids(): string[]; stat(pid: string): string; mountinfo(pid: string): string; fds(pid: string): string[]; fdTarget(pid: string, fd: string): string
}
export const linuxProc: ProcReader = {
  pids: () => readdirSync("/proc").filter((p) => /^\d+$/.test(p)),
  stat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
  mountinfo: (pid) => readFileSync(`/proc/${pid}/mountinfo`, "utf8"),
  fds: (pid) => readdirSync(`/proc/${pid}/fd`),
  fdTarget: (pid, fd) => readlinkSync(`/proc/${pid}/fd/${fd}`),
}
const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? String(err)
/** The process exited (ENOENT/ESRCH) or is a zombie (EINVAL on mountinfo). */
const gone = (err: unknown) => ["ENOENT", "ESRCH", "EINVAL"].includes(code(err))

let libc: { flock(fd: number, op: number): number } | null = null
const LOCK_EX = 2, LOCK_NB = 4

/**
 * Claude Code's Linux sandbox ro-binds /dev/null over `.git/config.lock` of the repo a worktree belongs to (hard-coded
 * in the CLI, no setting turns it off). A sandbox killed mid-command leaves that mount point on the host as a 0-byte
 * 0444 file, and every later `git config` write there fails ("could not lock config file"). Remove it, under an
 * exclusive flock on `.git/companion-config-lock.guard` so two sweeps never interleave, unless:
 * - a live process has it mounted, or its mountinfo can't be read (that is where a sandbox's hold shows);
 * - a `git` process has it open, or its fd table can't be read (ownership unknown). Other processes' fd tables are not
 *   read: root daemons, other users and the user's own `(sd-pam)` never let us, and only git ever opens config.lock.
 * Zombies are gone. Returns null when removed or absent, else why the stub was kept (also logged).
 * macOS: no /proc and no stub to begin with; the libc lookup fails and the stub, if any, is kept.
 */
export function clearStaleGitConfigLock(repoDir: string, proc: ProcReader = linuxProc, log: (line: string) => void = companionLog): string | null {
  const lock = join(repoDir, ".git", "config.lock")
  const isStub = (s: Stats) => s.isFile() && s.size === 0 && (s.mode & 0o222) === 0
  const keep = (why: string) => { log(`config.lock stub kept in ${repoDir}: ${why}`); return why }
  let guard = -1
  try {
    if (!isStub(lstatSync(lock))) return null
    libc ??= dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols
    guard = openSync(join(repoDir, ".git", "companion-config-lock.guard"), "a")
    if (libc.flock(guard, LOCK_EX | LOCK_NB) !== 0) return keep("another sweep holds the guard")
    const st = lstatSync(lock)
    if (!isStub(st)) return null
    const mountPoint = ` ${lock.replace(/ /g, "\\040")} `
    for (const pid of proc.pids()) {
      let stat: string
      try { stat = proc.stat(pid) } catch (err) { if (gone(err)) continue; return keep(`pid ${pid} stat unreadable (${code(err)})`) }
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
      if (stat[stat.lastIndexOf(")") + 2] === "Z") continue
      try { if (proc.mountinfo(pid).includes(mountPoint)) return keep(`mounted by pid ${pid} (${comm})`) }
      catch (err) { if (gone(err)) continue; return keep(`pid ${pid} (${comm}) mountinfo unreadable (${code(err)})`) }
      if (comm !== "git") continue
      let fds: string[]
      try { fds = proc.fds(pid) } catch (err) { if (gone(err)) continue; return keep(`git pid ${pid} fd table unreadable (${code(err)})`) }
      for (const fd of fds) {
        try { if (proc.fdTarget(pid, fd) === lock) return keep(`open in git pid ${pid}`) }
        catch (err) { if (!gone(err)) return keep(`git pid ${pid} fd ${fd} unreadable (${code(err)})`) }
      }
    }
    // Only the inode validated under the guard. ponytail: the lstat → unlink gap is still a race against a non-sweep
    // remover (Node has no unlink-by-fd): the sandbox itself unlinking the stub and git O_EXCL-creating config.lock on
    // the same reused inode, all within microseconds. Closing it needs unlinkat-by-handle, which Linux doesn't have.
    const now = lstatSync(lock)
    if (!isStub(now) || now.dev !== st.dev || now.ino !== st.ino || now.ctimeMs !== st.ctimeMs) return keep("replaced during the scan")
    unlinkSync(lock)
    return null
  } catch (err) {
    return code(err) === "ENOENT" ? null : keep(`sweep failed (${code(err)})`)
  } finally {
    if (guard >= 0) closeSync(guard)
  }
}
