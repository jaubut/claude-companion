import { dlopen, FFIType } from "bun:ffi"
import { type Stats, closeSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { companionLog } from "./log"

/** The /proc reads clearStaleGitConfigLock makes; injectable for tests. */
export interface ProcReader {
  pids(): string[]; stat(pid: string): string; mountinfo(pid: string): string
}
export const linuxProc: ProcReader = {
  pids: () => readdirSync("/proc").filter((p) => /^\d+$/.test(p)),
  stat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
  mountinfo: (pid) => readFileSync(`/proc/${pid}/mountinfo`, "utf8"),
}
const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? String(err)
/** The process exited (ENOENT/ESRCH) or is a zombie (EINVAL on mountinfo). */
const gone = (err: unknown) => ["ENOENT", "ESRCH", "EINVAL"].includes(code(err))

let libc: { flock(fd: number, op: number): number; fcntl(fd: number, cmd: number, arg: number): number } | null = null
const LOCK_EX = 2, LOCK_NB = 4
const F_SETSIG = 10, F_SETLEASE = 1024, F_WRLCK = 1, SIGWINCH = 28

/**
 * Claude Code's Linux sandbox ro-binds /dev/null over `.git/config.lock` of the repo a worktree belongs to (hard-coded
 * in the CLI, no setting turns it off). A sandbox killed mid-command leaves that mount point on the host as a 0-byte
 * 0444 file, and every later `git config` write there fails ("could not lock config file"). Remove it, under an
 * exclusive flock on `.git/companion-config-lock.guard` so two sweeps never interleave, unless:
 * - any process has the stub open: the kernel refuses a write lease on an inode with another open fd, whatever the
 *   holder's name or uid, so ownership is never guessed from /proc/<pid>/fd;
 * - a live process has it mounted, or its mountinfo can't be read (a mount is not an fd; that is where a sandbox's
 *   hold shows). Zombies are gone.
 * The lease is held to the end, so nobody can open the stub after the check. Removal is an atomic rename to a
 * quarantine name, then only the inode the lease covers is unlinked; anything else that was moved is linked back.
 * Returns null when removed or absent, else why the stub was kept (also logged).
 * macOS: no /proc and no stub to begin with; the libc lookup fails and the stub, if any, is kept.
 */
export function clearStaleGitConfigLock(repoDir: string, proc: ProcReader = linuxProc, log: (line: string) => void = companionLog): string | null {
  const lock = join(repoDir, ".git", "config.lock")
  const quarantine = join(repoDir, ".git", "companion-config-lock.stale")
  const isStub = (s: Stats) => s.isFile() && s.size === 0 && (s.mode & 0o222) === 0
  const keep = (why: string) => { log(`config.lock stub kept in ${repoDir}: ${why}`); return why }
  let guard = -1, fd = -1
  try {
    if (!isStub(lstatSync(lock))) return null
    libc ??= dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    }).symbols
    guard = openSync(join(repoDir, ".git", "companion-config-lock.guard"), "a")
    if (libc.flock(guard, LOCK_EX | LOCK_NB) !== 0) return keep("another sweep holds the guard")
    fd = openSync(lock, "r")
    const st = fstatSync(fd)
    if (!isStub(st)) return null
    // A lease break signals the lease holder (SIGIO by default, which would kill the server): use an ignored signal.
    if (libc.fcntl(fd, F_SETSIG, SIGWINCH) !== 0 || libc.fcntl(fd, F_SETLEASE, F_WRLCK) !== 0) return keep("open elsewhere (write lease refused)")
    const mountPoint = ` ${lock.replace(/ /g, "\\040")} `
    for (const pid of proc.pids()) {
      let stat: string
      try { stat = proc.stat(pid) } catch (err) { if (gone(err)) continue; return keep(`pid ${pid} stat unreadable (${code(err)})`) }
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
      if (stat[stat.lastIndexOf(")") + 2] === "Z") continue
      try { if (proc.mountinfo(pid).includes(mountPoint)) return keep(`mounted by pid ${pid} (${comm})`) }
      catch (err) { if (gone(err)) continue; return keep(`pid ${pid} (${comm}) mountinfo unreadable (${code(err)})`) }
    }
    renameSync(lock, quarantine)
    const moved = lstatSync(quarantine)
    if (moved.dev === st.dev && moved.ino === st.ino) { unlinkSync(quarantine); return null }
    // ponytail: the stub was replaced (sandbox unlink + git O_EXCL create) after the open; git's live lock goes back
    // under its name, nameless for microseconds. A third writer taking config.lock in that gap leaves it here, logged.
    try { linkSync(quarantine, lock) } catch (err) { return keep(`replaced during the sweep; restore failed (${code(err)}), moved file left at ${quarantine}`) }
    unlinkSync(quarantine)
    return keep("replaced during the sweep")
  } catch (err) {
    return code(err) === "ENOENT" ? null : keep(`sweep failed (${code(err)})`)
  } finally {
    if (fd >= 0) closeSync(fd)
    if (guard >= 0) closeSync(guard)
  }
}
