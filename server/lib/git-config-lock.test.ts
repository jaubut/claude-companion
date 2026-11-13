import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ProcReader, clearStaleGitConfigLock, linuxProc } from "./git-config-lock"
import { createWorkerSupervisor } from "./worker-supervisor"

describe("clearStaleGitConfigLock", () => {
  test.skipIf(process.platform !== "linux" || !Bun.which("bwrap"))("a sandbox killed mid-run leaves no config.lock stub after supervisor start, and the next worktree add -b succeeds", async () => {
    const home = mkdtempSync(join(tmpdir(), "worker-lock-"))
    const repoDir = join(home, "repo")
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repoDir, ...args], { stderr: "pipe" })
    try {
      mkdirSync(repoDir)
      git("init", "-q", "-b", "main")
      git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init")
      const lock = join(repoDir, ".git", "config.lock")
      // What Claude Code's Linux sandbox does to the repo a worktree belongs to.
      const sandbox = spawn("bwrap", ["--die-with-parent", "--bind", "/", "/", "--dev", "/dev", "--ro-bind", "/dev/null", lock, "sleep", "30"], { detached: true, stdio: "ignore" })
      const exited = new Promise((resolve) => sandbox.once("exit", resolve))
      for (let i = 0; i < 100 && !existsSync(lock); i++) await Bun.sleep(20)
      await Bun.sleep(100)
      clearStaleGitConfigLock(repoDir, linuxProc, quiet)
      expect(existsSync(lock)).toBe(true) // a live sandbox keeps its mask
      // Kill the whole group, as the supervisor does, and wait until every member (bwrap's sleep child too) is gone:
      // a member still alive still has the mount, and the sweep rightly keeps the stub.
      process.kill(-sandbox.pid!, "SIGKILL")
      await exited
      for (let i = 0; i < 100; i++) { try { process.kill(-sandbox.pid!, 0) } catch { break } await Bun.sleep(20) }
      const st = statSync(lock) // the stub a killed sandbox leaves on the host
      expect({ size: st.size, mode: st.mode & 0o777 }).toEqual({ size: 0, mode: 0o444 })
      const stateFile = join(home, "state.json")
      writeFileSync(stateFile, JSON.stringify([{ taskId: "task-1", repo: "repo", repoDir, worktree: join(home, "wt-old"), sessionId: "s", status: "completed" }]))
      createWorkerSupervisor({
        host: "h", home, stateFile, now: () => 0, uuid: () => "u", trust: () => {}, reportJob: () => {},
        sh: async () => ({ ok: true, out: "", err: "", code: 0 }),
      })
      expect(existsSync(lock)).toBe(false)
      const add = git("-c", "branch.autoSetupMerge=always", "worktree", "add", "-q", "-b", "dispatch/task-2", join(home, "wt"), "main")
      expect(add.stderr.toString()).toBe("")
      expect(add.exitCode).toBe(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  const errno = (code: string) => Object.assign(new Error(code), { code })
  function withStub(fn: (repoDir: string, lock: string) => void): void {
    const repoDir = mkdtempSync(join(tmpdir(), "worker-lock-unit-"))
    try {
      mkdirSync(join(repoDir, ".git"))
      const lock = join(repoDir, ".git", "config.lock")
      writeFileSync(lock, "")
      chmodSync(lock, 0o444)
      fn(repoDir, lock)
    } finally {
      rmSync(repoDir, { recursive: true, force: true })
    }
  }
  const quiet = () => {}
  const statLine = (comm: string, state = "S") => `42 (${comm}) ${state} 1 42 42 0 -1`
  const idle: ProcReader = { pids: () => ["42"], stat: () => statLine("bash"), mountinfo: () => "" }
  const quarantine = (repoDir: string) => join(repoDir, ".git", "companion-config-lock.stale")

  test.skipIf(process.platform !== "linux")("a stub nobody holds is removed through the injected reader", () => {
    withStub((repoDir, lock) => {
      expect(clearStaleGitConfigLock(repoDir, idle, quiet)).toBeNull()
      expect(existsSync(lock)).toBe(false)
      expect(existsSync(quarantine(repoDir))).toBe(false)
    })
  })

  test.skipIf(process.platform !== "linux")("a lock swapped in during the scan (new inode) is never removed", () => {
    withStub((repoDir, lock) => {
      const swap: ProcReader = {
        ...idle,
        pids: () => { writeFileSync(`${lock}.new`, "[core]\n"); renameSync(`${lock}.new`, lock); return idle.pids() },
      }
      expect(clearStaleGitConfigLock(repoDir, swap, quiet)).toContain("replaced during the sweep")
      expect(readFileSync(lock, "utf8")).toBe("[core]\n")
    })
  })

  test.skipIf(process.platform !== "linux")("the sandbox unlinking the stub and git O_EXCL-creating config.lock after validation never loses git's lock", () => {
    withStub((repoDir, lock) => {
      let gitFd = -1
      const race: ProcReader = {
        ...idle,
        // After the stub is validated and leased, before removal: a non-sweep remover, then git takes the lock.
        pids: () => { unlinkSync(lock); gitFd = openSync(lock, "wx"); writeFileSync(gitFd, "[core]\n"); return idle.pids() },
      }
      try {
        expect(clearStaleGitConfigLock(repoDir, race, quiet)).toContain("replaced during the sweep")
        expect(readFileSync(lock, "utf8")).toBe("[core]\n")
        expect(fstatSync(gitFd).ino).toBe(statSync(lock).ino) // git's own inode, still under its name
        expect(existsSync(quarantine(repoDir))).toBe(false)
      } finally {
        if (gitFd >= 0) closeSync(gitFd)
      }
    })
  })

  test.skipIf(process.platform !== "linux")("an unreadable mountinfo of a live process keeps the stub; an exited process does not", () => {
    withStub((repoDir, lock) => {
      clearStaleGitConfigLock(repoDir, { ...idle, mountinfo: () => { throw errno("EACCES") } }, quiet)
      expect(existsSync(lock)).toBe(true)
    })
    withStub((repoDir, lock) => {
      clearStaleGitConfigLock(repoDir, { ...idle, mountinfo: () => { throw errno("ENOENT") } }, quiet)
      expect(existsSync(lock)).toBe(false)
    })
  })

  test.skipIf(process.platform !== "linux")("an unreaped zombie is gone, not a holder", async () => {
    // `sleep 0` exits but its parent exec'd into `sleep 3`, which never reaps it.
    const parent = spawn("sh", ["-c", "sleep 0 & exec sleep 3"], { stdio: "ignore" })
    try {
      let zombie: string | undefined
      for (let i = 0; i < 50 && !zombie; i++) {
        await Bun.sleep(20)
        zombie = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).find((p) => {
          try { const f = readFileSync(`/proc/${p}/stat`, "utf8"); const r = f.slice(f.lastIndexOf(")") + 2).split(" "); return r[0] === "Z" && r[1] === String(parent.pid) } catch { return false }
        })
      }
      expect(zombie).toBeDefined()
      withStub((repoDir, lock) => {
        expect(clearStaleGitConfigLock(repoDir, { ...linuxProc, pids: () => [zombie!] }, quiet)).toBeNull()
        expect(existsSync(lock)).toBe(false)
      })
    } finally {
      parent.kill()
    }
  })

  test.skipIf(process.platform !== "linux")("a second sweep can't interleave: it keeps the stub while the first holds the guard, so git can't take the lock in between", () => {
    withStub((repoDir, lock) => {
      let nested: string | null = "not run"
      let gitCouldLock = true
      const racing: ProcReader = {
        ...idle,
        pids: () => {
          nested = clearStaleGitConfigLock(repoDir, idle, quiet) // another sweep, mid-scan of this one
          try { closeSync(openSync(lock, "wx")) } catch { gitCouldLock = false } // git takes config.lock with O_EXCL
          return idle.pids()
        },
      }
      expect(clearStaleGitConfigLock(repoDir, racing, quiet)).toBeNull()
      expect(nested).toContain("another sweep")
      expect(gitCouldLock).toBe(false)
      expect(existsSync(lock)).toBe(false) // the first sweep still removed the stub it validated
    })
  })

  test.skipIf(process.platform !== "linux")("an fd open on the stub in any process keeps it, read-only or writable, whatever the process is named", () => {
    withStub((repoDir, lock) => {
      const ro = openSync(lock, "r") // held by this (bun) process, not a `git`
      try {
        expect(clearStaleGitConfigLock(repoDir, idle, quiet)).toContain("open elsewhere")
        expect(existsSync(lock)).toBe(true)
      } finally {
        closeSync(ro)
      }
    })
    withStub((repoDir, lock) => {
      // A writable fd opened before the chmod to 0444: read-only permissions don't revoke it.
      chmodSync(lock, 0o644)
      const rw = openSync(lock, "r+")
      chmodSync(lock, 0o444)
      try {
        expect(clearStaleGitConfigLock(repoDir, idle, quiet)).toContain("open elsewhere")
        expect(existsSync(lock)).toBe(true)
      } finally {
        closeSync(rw)
      }
    })
    withStub((repoDir, lock) => {
      // A process other than the sweeper holding it.
      const holder = Bun.spawn(["sh", "-c", `exec 3<"$0"; read -r _`, lock], { stdin: "pipe", stdout: "ignore" })
      try {
        for (let i = 0; i < 100 && !readdirSync(`/proc/${holder.pid}/fd`).includes("3"); i++) Bun.sleepSync(10)
        expect(clearStaleGitConfigLock(repoDir, idle, quiet)).toContain("open elsewhere")
        expect(existsSync(lock)).toBe(true)
      } finally {
        holder.kill()
      }
    })
  })

  test.skipIf(process.platform !== "linux")("a non-git writer (git-config, a library) holding the stub open in another process keeps it", () => {
    withStub((repoDir, lock) => {
      // `comm` comes from the exec'd file name: a symlink makes the holder show up as `git-config`, not `git`.
      const bin = join(repoDir, "git-config")
      symlinkSync(Bun.which("sh")!, bin)
      const holder = Bun.spawn([bin, "-c", `exec 3<"$0"; read -r _`, lock], { stdin: "pipe", stdout: "ignore" })
      try {
        for (let i = 0; i < 100 && !readdirSync(`/proc/${holder.pid}/fd`).includes("3"); i++) Bun.sleepSync(10)
        expect(readFileSync(`/proc/${holder.pid}/comm`, "utf8").trim()).toBe("git-config")
        const why = clearStaleGitConfigLock(repoDir, linuxProc, quiet)
        expect(why).not.toBeNull()
        expect(existsSync(lock)).toBe(true)
      } finally {
        holder.kill()
      }
    })
  })

  test("a kept stub is logged with the reason", () => {
    withStub((repoDir) => {
      const lines: string[] = []
      const why = clearStaleGitConfigLock(repoDir, { ...idle, mountinfo: () => `1 2 0:1 /null ${join(repoDir, ".git", "config.lock")} ro\n` }, (l) => lines.push(l))
      expect(why).toContain("mounted by pid 42")
      expect(lines).toEqual([`config.lock stub kept in ${repoDir}: ${why}`])
    })
  })
})
