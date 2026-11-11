import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BuilderReport } from "./builder-jobs"
import {
  type SpawnWorkerOpts,
  buildHeadlessClaudeArgs,
  buildWorkerEnv,
  createWorkerSupervisor,
  parseStreamJsonLine,
} from "./worker-supervisor"

describe("parseStreamJsonLine", () => {
  test("parses assistant tool_use, text with PR URL, result, and ignores malformed JSON", () => {
    expect(parseStreamJsonLine("not json")).toBeNull()
    expect(parseStreamJsonLine("{malformed")).toBeNull()

    const init = parseStreamJsonLine(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sid-123",
    }))
    expect(init).toEqual({ sessionId: "sid-123" })

    const editEv = parseStreamJsonLine(JSON.stringify({
      type: "assistant",
      session_id: "sid-123",
      message: {
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/repo/server/lib/foo.ts" } },
        ],
      },
    }))
    expect(editEv).toEqual({
      sessionId: "sid-123",
      step: "Editing foo.ts",
    })

    const bashEv = parseStreamJsonLine(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "bun test server/lib/foo.test.ts" } },
          { type: "text", text: "Opened https://github.com/jaubut/claude-companion/pull/305 for review." },
        ],
      },
    }))
    expect(bashEv).toEqual({
      step: "Running bun test server/lib/foo.test.ts",
      assistantText: "Opened https://github.com/jaubut/claude-companion/pull/305 for review.",
      prUrl: "https://github.com/jaubut/claude-companion/pull/305",
    })

    const resEv = parseStreamJsonLine(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "DONE https://github.com/jaubut/claude-companion/pull/305",
    }))
    expect(resEv).toEqual({
      done: true,
      isError: false,
      resultText: "DONE https://github.com/jaubut/claude-companion/pull/305",
      prUrl: "https://github.com/jaubut/claude-companion/pull/305",
    })
  })

  test("buildHeadlessClaudeArgs places -- before prompt (safe for prompts starting with -) and buildWorkerEnv strips tokens", () => {
    expect(buildHeadlessClaudeArgs({
      prompt: "--add-dir=/",
      sessionId: "uuid-1",
      resume: false,
      mode: "auto",
      agent: "builder",
    })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      "--session-id",
      "uuid-1",
      "--agent",
      "builder",
      "--",
      "--add-dir=/",
    ])

    expect(buildHeadlessClaudeArgs({
      prompt: "Fix review finding 1",
      sessionId: "uuid-1",
      resume: true,
      mode: "auto",
    })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      "--resume",
      "uuid-1",
      "--",
      "Fix review finding 1",
    ])

    const env = buildWorkerEnv({
      PATH: "/usr/bin",
      COMPANION_AUTH_TOKEN: "secret-auth-token",
      COMPANION_TOKEN: "secret-1",
      COMPANION_PEER_MAC_TOKEN: "secret-2",
      COMPANION_PEER_ZETTLAB_URL: "http://100.64.0.1:4245",
    }, "task-1", "builder-zettlab-cc-task-1")
    expect(env.COMPANION_AUTH_TOKEN).toBeUndefined()
    expect(env.COMPANION_TOKEN).toBeUndefined()
    expect(env.COMPANION_PEER_MAC_TOKEN).toBeUndefined()
    expect(env.COMPANION_PEER_ZETTLAB_URL).toBeUndefined()
    expect(env.DISPATCH_TASK_ID).toBe("task-1")
  })
})

describe("createWorkerSupervisor", () => {
  test("dispatches headless stream-json worker, streams progress to BuilderJobStore, wakes awaitTask, and resumes on turn 2", async () => {
    const home = join(tmpdir(), `worker-sup-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const repoDir = join(home, "claude-companion")
    mkdirSync(join(repoDir, ".git"), { recursive: true })

    const reports: BuilderReport[] = []
    const spawned: SpawnWorkerOpts[] = []
    const signals: NodeJS.Signals[] = []
    let dirtyWorktree = false
    let pushedWorktree = true

    const sup = createWorkerSupervisor({
      host: "zettlab",
      home,
      killGraceMs: 50,
      now: () => 1700000000000,
      uuid: () => "11111111-2222-4333-8444-555555555555",
      trust: () => {},
      reportJob: (r) => reports.push(r),
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) {
          const wtPath = args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!
          mkdirSync(wtPath, { recursive: true })
          return { ok: true, out: "", err: "", code: 0 }
        }
        if (args.includes("status") && args.includes("--porcelain")) {
          return { ok: true, out: dirtyWorktree ? " M server/a.ts\n" : "", err: "", code: 0 }
        }
        if (args.includes("branch") && args.includes("-r") && args.includes("--contains")) {
          return { ok: true, out: pushedWorktree ? "  origin/dispatch/task-1\n" : "", err: "", code: 0 }
        }
        if (args.includes("worktree") && args.includes("remove")) {
          const wtPath = args[args.length - 1]!
          rmSync(wtPath, { recursive: true, force: true })
          return { ok: true, out: "", err: "", code: 0 }
        }
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker(opts) {
        spawned.push(opts)
        return {
          pid: 4242,
          kill(sig) {
            signals.push(sig)
            queueMicrotask(() => opts.onExit(null, sig))
          },
        }
      },
    })

    try {
      // Rejects bypassPermissions mode and invalid agent/model flags
      expect(await sup.dispatchTask({
        taskId: "task-1",
        repo: "claude-companion",
        prompt: "Do work",
        mode: "bypassPermissions",
      })).toEqual({ ok: false, status: 400, error: "invalid_mode" })

      expect(await sup.dispatchTask({
        taskId: "task-1",
        repo: "claude-companion",
        prompt: "Do work",
        agent: "--bad-flag",
      })).toEqual({ ok: false, status: 400, error: "invalid_agent" })

      // Turn 1 dispatch
      const d1 = await sup.dispatchTask({
        taskId: "task-1",
        repo: "claude-companion",
        prompt: "Implement feature",
        title: "Implement feature",
      })
      expect(d1.ok).toBe(true)
      if (!d1.ok) return
      expect(d1.task.status).toBe("running")
      expect(d1.task.turnCount).toBe(1)
      expect(spawned[0]!.args).toContain("--session-id")

      // Rejects concurrent dispatch while turn 1 is still running
      const dup = await sup.dispatchTask({
        taskId: "task-1",
        repo: "claude-companion",
        prompt: "Concurrent turn",
      })
      expect(dup).toEqual({ ok: false, status: 409, error: "task_already_running" })

      // Start awaiting turn 1 before it finishes
      const awaitPromise = sup.awaitTask("task-1", 5_000)

      // Emit stream-json lines and exit
      spawned[0]!.onStdoutLine(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "server/a.ts" } }] },
      }))
      spawned[0]!.onStdoutLine(JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Shipped in https://github.com/jaubut/claude-companion/pull/310",
      }))
      spawned[0]!.onExit(0, null)

      const awaited = await awaitPromise
      expect(awaited.ok).toBe(true)
      if (!awaited.ok) return
      expect(awaited.timedOut).toBe(false)
      expect(awaited.task.status).toBe("completed")
      expect(awaited.task.prUrl).toBe("https://github.com/jaubut/claude-companion/pull/310")
      expect(reports.map((r) => `${r.id}:${r.event}`)).toEqual(["task-1:task", "task-1:progress", "task-1:done"])

      // Rejects reusing the same taskId with a different repo
      expect(await sup.dispatchTask({
        taskId: "task-1",
        repo: "other-repo",
        prompt: "Wrong repo",
      })).toEqual({ ok: false, status: 409, error: "task_repo_mismatch: task-1 belongs to claude-companion" })

      // Turn 2 on the same task uses --resume <sessionId> and distinct jobId `task-1:t2` (`:` cannot collide with any taskId)
      const d2 = await sup.dispatchTask({
        taskId: "task-1",
        repo: "claude-companion",
        prompt: "Fix review finding on server/a.ts",
      })
      expect(d2.ok).toBe(true)
      expect(spawned[1]!.args).toContain("--resume")
      expect(spawned[1]!.args).toContain("11111111-2222-4333-8444-555555555555")
      expect(reports.at(-1)?.id).toBe("task-1:t2")

      // Interrupt turn 2 with dirty worktree -> worktree kept, only 1 "aborted" event emitted
      dirtyWorktree = true
      const intDirty = await sup.interruptTask("task-1", { closeWorktree: true })
      expect(intDirty.ok).toBe(true)
      if (!intDirty.ok) return
      expect(intDirty.task.status).toBe("interrupted")
      expect(intDirty.worktreeRemoved).toBe(false)
      expect(intDirty.note).toContain("uncommitted")
      expect(signals).toContain("SIGTERM")
      expect(reports.filter((r) => r.id === "task-1:t2" && r.event === "aborted")).toHaveLength(1)

      // Once clean and pushed, closeWorktree removes the worktree
      dirtyWorktree = false
      pushedWorktree = true
      const intClean = await sup.interruptTask("task-1", { closeWorktree: true })
      expect(intClean.ok).toBe(true)
      if (!intClean.ok) return
      expect(intClean.worktreeRemoved).toBe(true)

      // Reloading state from disk preserves task history and sessionId across supervisor restarts
      const supReloaded = createWorkerSupervisor({
        host: "zettlab",
        home,
        now: () => 1700000005000,
        uuid: () => "99999999-9999-4999-8999-999999999999",
        trust: () => {},
        reportJob: () => {},
        sh: async () => ({ ok: true, out: "", err: "", code: 0 }),
      })
      const reloadedTask = supReloaded.getTask("task-1")
      expect(reloadedTask?.sessionId).toBe("11111111-2222-4333-8444-555555555555")
      expect(reloadedTask?.turnCount).toBe(2)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("prevents concurrent dispatch races, isolates late exits across turns, and recovers from synchronous spawn errors", async () => {
    const home = join(tmpdir(), `worker-sup-race-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const repoDir = join(home, "claude-companion")
    mkdirSync(join(repoDir, ".git"), { recursive: true })

    const spawned: SpawnWorkerOpts[] = []
    let throwOnSpawn = false

    const sup = createWorkerSupervisor({
      host: "zettlab",
      home,
      killGraceMs: 40,
      now: () => 1700000000000,
      uuid: () => "aaaa1111-2222-4333-8444-555555555555",
      trust: () => {},
      reportJob: () => {},
      sh: async (_cmd, args) => {
        await Bun.sleep(20)
        if (args.includes("worktree") && args.includes("add")) {
          const wtPath = args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!
          mkdirSync(wtPath, { recursive: true })
        }
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker(opts) {
        if (throwOnSpawn) throw new Error("ENOENT: claude binary missing")
        spawned.push(opts)
        return {
          pid: 5000 + spawned.length,
          kill() {
            // Deliberately delay exit to test late exit isolation
            setTimeout(() => opts.onExit(null, "SIGTERM"), 15)
          },
        }
      },
    })

    try {
      // 1. Two simultaneous dispatches of the same taskId -> exactly one succeeds, one gets 409
      const [r1, r2] = await Promise.all([
        sup.dispatchTask({ taskId: "race-1", repo: "claude-companion", prompt: "First" }),
        sup.dispatchTask({ taskId: "race-1", repo: "claude-companion", prompt: "Second" }),
      ])
      const oks = [r1, r2].filter((r) => r.ok)
      const errs = [r1, r2].filter((r) => !r.ok)
      expect(oks).toHaveLength(1)
      expect(errs).toEqual([{ ok: false, status: 409, error: "task_already_running" }])
      expect(spawned).toHaveLength(1)

      // 2. Interrupt turn 1 and immediately re-dispatch turn 2 -> turn 1's exit does not clobber turn 2
      await sup.interruptTask("race-1")
      const turn2 = await sup.dispatchTask({ taskId: "race-1", repo: "claude-companion", prompt: "Turn 2" })
      expect(turn2.ok).toBe(true)
      //Even if turn 1's onExit fires again late, turn 2 remains running
      spawned[0]!.onExit(1, "SIGTERM")
      expect(sup.getTask("race-1")?.status).toBe("running")
      expect(sup.getTask("race-1")?.turnCount).toBe(2)
      spawned[1]!.onExit(0, null)
      expect(sup.getTask("race-1")?.status).toBe("completed")

      // 3. Synchronous spawn failure marks task failed instead of leaving it permanently running,
      // and retry uses --session-id (not --resume) because no session was created on the failed attempt.
      throwOnSpawn = true
      const failDisp = await sup.dispatchTask({ taskId: "spawn-err", repo: "claude-companion", prompt: "Run" })
      expect(failDisp.ok).toBe(false)
      expect(sup.getTask("spawn-err")?.status).toBe("failed")

      throwOnSpawn = false
      const retryDisp = await sup.dispatchTask({ taskId: "spawn-err", repo: "claude-companion", prompt: "Retry" })
      expect(retryDisp.ok).toBe(true)
      expect(spawned.at(-1)?.args).toContain("--session-id")
      expect(spawned.at(-1)?.args).not.toContain("--resume")
      spawned.at(-1)?.onExit(0, null)

      // 4. Worktree paths for (repo="foo-bar", task="baz") and (repo="foo", task="bar-baz") do not collide
      mkdirSync(join(home, "foo-bar", ".git"), { recursive: true })
      mkdirSync(join(home, "foo", ".git"), { recursive: true })
      const w1 = await sup.dispatchTask({ taskId: "baz", repo: "foo-bar", prompt: "A" })
      const w2 = await sup.dispatchTask({ taskId: "bar-baz", repo: "foo", prompt: "B" })
      expect(w1.ok).toBe(true)
      expect(w2.ok).toBe(true)
      if (w1.ok && w2.ok) {
        expect(w1.task.worktree).not.toBe(w2.task.worktree)
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("persists sessionStarted on stream events, blocks cleanup while process group lives, and checks pidIdentity on restart", async () => {
    const home = join(tmpdir(), `worker-sup-pgid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const repoDir = join(home, "claude-companion")
    mkdirSync(join(repoDir, ".git"), { recursive: true })

    const spawned: SpawnWorkerOpts[] = []
    const killedPids: Array<{ pid: number; sig: NodeJS.Signals }> = []
    let groupAlive = true
    let currentPidIdentity: string | null = "boot1:7777:100"

    const makeSup = () =>
      createWorkerSupervisor({
        host: "zettlab",
        home,
        killGraceMs: 50,
        now: () => 1700000000000,
        uuid: () => "bbbb1111-2222-4333-8444-555555555555",
        trust: () => {},
        reportJob: () => {},
        isPidAlive: (pid) => pid === 7777 && groupAlive,
        killPid: (pid, sig) => { killedPids.push({ pid, sig }) },
        getPidIdentity: () => currentPidIdentity,
        sh: async (_cmd, args) => {
          if (args.includes("worktree") && args.includes("add")) {
            const wtPath = args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!
            mkdirSync(wtPath, { recursive: true })
          }
          return { ok: true, out: "origin/main\n", err: "", code: 0 }
        },
        spawnWorker(opts) {
          spawned.push(opts)
          return { pid: 7777, kill(sig) { killedPids.push({ pid: 7777, sig }) } }
        },
      })

    try {
      const sup1 = makeSup()
      const d1 = await sup1.dispatchTask({ taskId: "pg-1", repo: "claude-companion", prompt: "Turn 1" })
      expect(d1.ok).toBe(true)

      // Emit session_id on stdout (persists sessionStarted = true immediately before turn exit)
      spawned[0]!.onStdoutLine(JSON.stringify({ type: "system", subtype: "init", session_id: "sid-live" }))

      // Simulate server restart while PID 7777 is now a DIFFERENT unrelated process (PID reuse)
      currentPidIdentity = "boot1:7777:999-unrelated"
      killedPids.length = 0
      const supReusedPid = makeSup()
      // Unrelated process with reused PID 7777 must NOT be signaled on startup
      expect(killedPids).toHaveLength(0)

      // Resume after mid-turn restart uses --resume sid-live because sessionStarted was persisted on stdout
      groupAlive = false
      const d2 = await supReusedPid.dispatchTask({ taskId: "pg-1", repo: "claude-companion", prompt: "Resume turn" })
      expect(d2.ok).toBe(true)
      expect(spawned[1]!.args).toContain("--resume")
      expect(spawned[1]!.args).toContain("sid-live")

      // Leader exits (`onExit`), so leader identity is now null, while descendants in group 7777 remain alive (`groupAlive = true`)
      groupAlive = true
      currentPidIdentity = null
      spawned[1]!.onExit(0, null)

      // Cleanup / redispatch is blocked both in-memory and across a restart while descendants remain alive and leader identity is null
      const intWhileGroupAlive = await supReusedPid.interruptTask("pg-1", { closeWorktree: true })
      expect(intWhileGroupAlive.ok).toBe(true)
      if (intWhileGroupAlive.ok) {
        expect(intWhileGroupAlive.worktreeRemoved).toBe(false)
        expect(intWhileGroupAlive.note).toContain("not exited")
      }
      const dispWhileGroupAlive = await supReusedPid.dispatchTask({ taskId: "pg-1", repo: "claude-companion", prompt: "Blocked" })
      expect(dispWhileGroupAlive).toEqual({ ok: false, status: 409, error: "task_already_running" })

      const supRestartedWithOrphanGroup = makeSup()
      const intAfterRestart = await supRestartedWithOrphanGroup.interruptTask("pg-1", { closeWorktree: true })
      expect(intAfterRestart.ok).toBe(true)
      if (intAfterRestart.ok) {
        expect(intAfterRestart.worktreeRemoved).toBe(false)
      }

      // If the group later exits and PID 7777 is reused in-memory by an unrelated process, interrupt/dispatch does not signal it
      currentPidIdentity = "boot1:7777:unrelated-new-owner"
      killedPids.length = 0
      const dispAfterReuse = await supReusedPid.dispatchTask({ taskId: "pg-1", repo: "claude-companion", prompt: "Safe after reuse" })
      expect(dispAfterReuse.ok).toBe(true)
      expect(killedPids).toHaveLength(0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
