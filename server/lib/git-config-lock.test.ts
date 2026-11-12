import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ProcReader, clearStaleGitConfigLock } from "./git-config-lock"
import { createWorkerSupervisor } from "./worker-supervisor"

// Inside a Claude Code sandbox, its own pid 1 runs as us with an unreadable fd table: the sweep rightly counts it as a holder.
const unreadableOwnProcess = process.platform === "linux" && readdirSync("/proc").some((p) => {
  if (!/^\d+$/.test(p)) return false
  try { readdirSync(`/proc/${p}/fd`); return false } catch { try { return statSync(`/proc/${p}`).uid === process.getuid!() } catch { return false } }
})

describe("clearStaleGitConfigLock", () => {
  test.skipIf(process.platform !== "linux" || !Bun.which("bwrap") || unreadableOwnProcess)("a sandbox killed mid-run leaves no config.lock stub after supervisor start, and the next worktree add -b succeeds", async () => {
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
      clearStaleGitConfigLock(repoDir)
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
  const idle: ProcReader = { pids: () => ["42"], mountinfo: () => "", fds: () => [], fdTarget: () => "", uid: () => process.getuid!() }

  test("a stub nobody holds is removed through the injected reader", () => {
    withStub((repoDir, lock) => {
      clearStaleGitConfigLock(repoDir, idle)
      expect(existsSync(lock)).toBe(false)
    })
  })

  test("a lock swapped in during the scan (new inode) is never removed", () => {
    withStub((repoDir, lock) => {
      const swap: ProcReader = {
        ...idle,
        pids: () => { writeFileSync(`${lock}.new`, "[core]\n"); renameSync(`${lock}.new`, lock); return idle.pids() },
      }
      clearStaleGitConfigLock(repoDir, swap)
      expect(readFileSync(lock, "utf8")).toBe("[core]\n")
    })
  })

  test("an unreadable /proc entry of a live process keeps the stub; an exited one does not", () => {
    withStub((repoDir, lock) => {
      clearStaleGitConfigLock(repoDir, { ...idle, mountinfo: () => { throw errno("EACCES") } })
      expect(existsSync(lock)).toBe(true)
      clearStaleGitConfigLock(repoDir, { ...idle, fds: () => { throw errno("EPERM") } }) // same uid as the lock's owner
      expect(existsSync(lock)).toBe(true)
      clearStaleGitConfigLock(repoDir, { ...idle, fdTarget: () => { throw errno("EACCES") }, fds: () => ["3"] })
      expect(existsSync(lock)).toBe(true)
    })
    withStub((repoDir, lock) => {
      clearStaleGitConfigLock(repoDir, { ...idle, mountinfo: () => { throw errno("ENOENT") }, fds: () => { throw errno("ESRCH") } })
      expect(existsSync(lock)).toBe(false)
    })
    withStub((repoDir, lock) => {
      // Another user's fd table (root daemons, non-dumpable processes) is always unreadable; its mountinfo was read and is clean.
      clearStaleGitConfigLock(repoDir, { ...idle, fds: () => { throw errno("EACCES") }, uid: () => process.getuid!() + 1 })
      expect(existsSync(lock)).toBe(false)
    })
  })
})
