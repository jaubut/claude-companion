import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearStaleGitConfigLock, createWorkerSupervisor } from "./worker-supervisor"

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
      const sandbox = Bun.spawn(["bwrap", "--die-with-parent", "--bind", "/", "/", "--dev", "/dev", "--ro-bind", "/dev/null", lock, "sleep", "30"])
      for (let i = 0; i < 100 && !existsSync(lock); i++) await Bun.sleep(20)
      await Bun.sleep(100)
      clearStaleGitConfigLock(repoDir)
      expect(existsSync(lock)).toBe(true) // a live sandbox keeps its mask
      sandbox.kill("SIGKILL")
      await sandbox.exited
      expect(statSync(lock).size).toBe(0) // the stub a killed sandbox leaves on the host
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
})
