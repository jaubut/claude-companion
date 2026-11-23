import { describe, expect, jest, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BuilderReport } from "./builder-jobs"
import {
  type SpawnWorkerOpts,
  WORKER_SHIP_RULE,
  WORKER_TURN_RULE,
  buildHeadlessClaudeArgs,
  buildHeadlessCodexArgs,
  buildHeadlessGeminiArgs,
  buildHeadlessWorkerInvocation,
  buildWorkerEnv,
  createWorkerSupervisor,
  defaultSpawnWorker,
  parseStreamJsonLine,
  resolveWorkerFamily,
} from "./worker-supervisor"
import { DEFAULT_GEMINI_WORKER_MODEL, GEMINI_INLINE_PROMPT_MAX, WORKER_FOOTER, WORKER_SANDBOX_HOSTS, agyWorkerSettings, parseAgentEnv } from "./worker-invocation"
import { defaultResolveRepoDir } from "./worker-worktree"
import { workerReceipt } from "./worker-pr-link"
import { CHECKIN_MS, IDLE_KILL_MS } from "./worker-turn-watch"
import { listSessions, removeSessionByKey } from "./sessions"
import { recordWorkerSession, workerOwnsConvo } from "./worker-session"

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
      step: "Running tests",
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

  test("buildHeadlessClaudeArgs passes --mcp-config before the -- prompt separator", () => {
    expect(buildHeadlessClaudeArgs({ prompt: "hi", sessionId: "s", resume: false, mode: "auto", mcpConfig: "/h/.claude-companion/brain-mcp.json" }).slice(-4))
      .toEqual(["--mcp-config", "/h/.claude-companion/brain-mcp.json", "--", "hi"])
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
    expect(env.CLAUDE_NO_AGENT_ENV).toBe("1")
    expect(env.COMPANION_HEADLESS).toBe("1")
    expect(env.COMPANION_ORIGIN).toBe("worker")
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

      // Turn 1 dispatch (explicit Claude)
      const d1 = await sup.dispatchTask({
        taskId: "task-1",
        repo: "claude-companion",
        prompt: "Implement feature",
        title: "Implement feature",
        family: "claude",
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

      // Interrupt turn 2 with dirty worktree -> interrupted, but the close answers ok:false with why; only 1 "aborted" event emitted
      dirtyWorktree = true
      const intDirty = await sup.interruptTask("task-1", { closeWorktree: true })
      expect(intDirty.ok).toBe(false)
      if (intDirty.ok) return
      expect(intDirty.status).toBe(409)
      expect(intDirty.error).toContain("uncommitted")
      expect(sup.getTask("task-1")!.status).toBe("interrupted")
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
        sup.dispatchTask({ taskId: "race-1", repo: "claude-companion", prompt: "First", family: "claude" }),
        sup.dispatchTask({ taskId: "race-1", repo: "claude-companion", prompt: "Second", family: "claude" }),
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
      const failDisp = await sup.dispatchTask({ taskId: "spawn-err", repo: "claude-companion", prompt: "Run", family: "claude" })
      expect(failDisp.ok).toBe(false)
      expect(sup.getTask("spawn-err")?.status).toBe("failed")

      throwOnSpawn = false
      const retryDisp = await sup.dispatchTask({ taskId: "spawn-err", repo: "claude-companion", prompt: "Retry", family: "claude" })
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
      const d1 = await sup1.dispatchTask({ taskId: "pg-1", repo: "claude-companion", prompt: "Turn 1", family: "claude" })
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
      expect(intWhileGroupAlive).toEqual({ ok: false, status: 409, error: "worktree kept: worker process has not exited yet" })
      const intNoClose = await supReusedPid.interruptTask("pg-1")
      expect(intNoClose.ok && [intNoClose.worktreeRemoved, intNoClose.note]).toEqual([false, "worktree kept: worker process has not exited yet"])
      const dispWhileGroupAlive = await supReusedPid.dispatchTask({ taskId: "pg-1", repo: "claude-companion", prompt: "Blocked" })
      expect(dispWhileGroupAlive).toEqual({ ok: false, status: 409, error: "task_already_running" })

      const supRestartedWithOrphanGroup = makeSup()
      const intAfterRestart = await supRestartedWithOrphanGroup.interruptTask("pg-1", { closeWorktree: true })
      expect(intAfterRestart.ok).toBe(false)

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

  test("keeps the reservation while the group lives when the saved leader identity is missing, and cleans up once the group is gone", async () => {
    const home = join(tmpdir(), `worker-sup-noid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const shCalls: string[][] = []
    let groupAlive = true
    let identity: string | null = null // probe failed at spawn: saved identity is null
    const makeSup = () =>
      createWorkerSupervisor({
        host: "zettlab", home, killGraceMs: 50, now: () => 1700000000000, uuid: () => "cccc1111-2222-4333-8444-555555555555",
        trust: () => {}, reportJob: () => {},
        isPidAlive: (pid) => pid === 7778 && groupAlive,
        killPid: () => {},
        getPidIdentity: () => identity,
        sh: async (_cmd, args) => {
          shCalls.push(args)
          if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
          return { ok: true, out: args.includes("status") ? "" : "origin/main\n", err: "", code: 0 }
        },
        spawnWorker: () => ({ pid: 7778, kill() {} }),
      })
    try {
      const sup1 = makeSup()
      expect((await sup1.dispatchTask({ taskId: "noid-1", repo: "claude-companion", prompt: "t" })).ok).toBe(true)

      // Restart: leader pid now probes as some process, descendants still alive -> unknown, not exited
      identity = "boot1:7778:555"
      const sup2 = makeSup()
      shCalls.length = 0
      const kept = await sup2.interruptTask("noid-1", { closeWorktree: true })
      expect(kept.ok && kept.worktreeRemoved).toBe(false)
      expect(shCalls.some((a) => a.includes("remove"))).toBe(false)
      expect(await sup2.dispatchTask({ taskId: "noid-1", repo: "claude-companion", prompt: "again" })).toEqual({ ok: false, status: 409, error: "task_already_running" })

      //Whole group gone: cleanup proceeds
      groupAlive = false
      const done = await sup2.interruptTask("noid-1", { closeWorktree: true })
      expect(done.ok && done.worktreeRemoved).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("unlinks .out/.err for unattached records with logFile (reused PID mismatch or non-attached crash state) and guards foreign records via ownerPidIdentity after reparenting", async () => {
    const home = join(tmpdir(), `worker-sup-logs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const repoDir = join(home, "claude-companion")
    mkdirSync(join(repoDir, ".git"), { recursive: true })
    const logDir = join(home, ".claude", "state", "companion-worker-logs")
    mkdirSync(logDir, { recursive: true })
    const logReused = join(logDir, "reused-1.t1")
    const logCrashed = join(logDir, "crashed-1.t1")
    const logForeign = join(logDir, "foreign-1.t1")
    const logRestartDied = join(logDir, "restart-died.t1")
    const logPostAttachDied = join(logDir, "post-attach-died.t1")
    for (const f of [logReused, logCrashed, logForeign, logRestartDied, logPostAttachDied]) {
      writeFileSync(`${f}.out`, '{"type":"system","subtype":"init","session_id":"s"}\n')
      writeFileSync(`${f}.err`, "fatal crash on stderr\n")
    }
    const baseRec = (taskId: string) => ({
      taskId, repo: "claude-companion", repoDir, title: taskId, builder: `b-${taskId}`, family: "claude",
      model: "claude-sonnet-5-5", branch: `dispatch/${taskId}`, worktree: join(home, "apps", "wt", "claude-companion", taskId),
      sessionId: `sid-${taskId}`, status: "running", turnCount: 1, step: "Running", pct: 10,
      result: "", prUrl: null, error: null, startedAt: 1, updatedAt: 1, completedAt: null,
    })
    const statePath = join(home, ".claude", "state", "companion-worker-tasks.json")
    writeFileSync(statePath, JSON.stringify([
      // (1) Reused PID identity mismatch -> !attach, must unlink .out and .err
      { ...baseRec("reused-1"), pid: 8001, pidIdentity: "boot:8001:old", ownerPid: 9001, ownerPidIdentity: "boot:9001:dead", logFile: logReused, logOffset: 0 },
      // (2) Non-attached crash/interrupted record still carrying logFile -> !attach, must unlink .out and .err
      { ...baseRec("crashed-1"), status: "interrupted", pid: null, pidIdentity: null, ownerPid: 9001, ownerPidIdentity: "boot:9001:dead", logFile: logCrashed, logOffset: 0 },
      // (3) Reparented worker (getParentPid !== ownerPid) whose re-attached owner supervisor B (9002) is alive -> foreign, keeps log files
      { ...baseRec("foreign-1"), pid: 8002, pidIdentity: "boot:8002:live", ownerPid: 9002, ownerPidIdentity: "boot:9002:live-b", logFile: logForeign, logOffset: 0 },
      // (4) Worker that exited during restart window without a result event (pid=null at attach) -> includes stderrTail and "while Companion was restarting"
      { ...baseRec("restart-died"), pid: 8003, pidIdentity: "boot:8003:gone", ownerPid: 9001, ownerPidIdentity: "boot:9001:dead", logFile: logRestartDied, logOffset: 0 },
      // (5) Worker alive at attach time that later exits without a result event -> includes stderrTail and "after re-attaching"
      { ...baseRec("post-attach-died"), pid: 8004, pidIdentity: "boot:8004:live", ownerPid: 9001, ownerPidIdentity: "boot:9001:dead", logFile: logPostAttachDied, logOffset: 0 },
    ]))

    let postAttachAlive = true
    let selfPidIdentityCalls = 0
    try {
      const sup = createWorkerSupervisor({
        host: "zettlab", home, selfPid: 9003, now: () => 1700000000000, uuid: () => "u", trust: () => {}, reportJob: () => {},
        isPidAlive: (pid) => pid === 8001 || pid === 8002 || (pid === 8004 && postAttachAlive),
        getParentPid: () => 1, // reparented to init / systemd --user
        getPidIdentity: (pid) => {
          if (pid === 8001) return "boot:8001:reused-other"
          if (pid === 8002) return "boot:8002:live"
          if (pid === 8004) return postAttachAlive ? "boot:8004:live" : null
          if (pid === 9002) return "boot:9002:live-b"
          if (pid === 9003) { selfPidIdentityCalls++; return "boot:9003:self-c" }
          return null
        },
        sh: async () => ({ ok: true, out: "origin/main\n", err: "", code: 0 }),
      })

      expect(sup.getTask("reused-1")?.status).toBe("interrupted")
      expect(existsSync(`${logReused}.out`)).toBe(false)
      expect(existsSync(`${logReused}.err`)).toBe(false)

      expect(sup.getTask("crashed-1")?.status).toBe("interrupted")
      expect(existsSync(`${logCrashed}.out`)).toBe(false)
      expect(existsSync(`${logCrashed}.err`)).toBe(false)

      // Foreign record owned by live server B (9002) is untouched even though getParentPid(8002) === 1
      expect(sup.getTask("foreign-1")).toBeNull()
      expect(existsSync(`${logForeign}.out`)).toBe(true)
      expect(existsSync(`${logForeign}.err`)).toBe(true)

      const diedDuringRestart = await sup.awaitTask("restart-died", 2_000)
      expect(diedDuringRestart.ok && diedDuringRestart.task.status).toBe("failed")
      expect(diedDuringRestart.ok && diedDuringRestart.task.error).toBe("claude exited while Companion was restarting, before its turn reported: fatal crash on stderr")

      writeFileSync(`${logPostAttachDied}.err`, "fatal crash on stderr\npost-attach stderr boom\n")
      await Bun.sleep(250)
      postAttachAlive = false
      const diedAfterAttach = await sup.awaitTask("post-attach-died", 2_000)
      expect(diedAfterAttach.ok && diedAfterAttach.task.status).toBe("failed")
      expect(diedAfterAttach.ok && diedAfterAttach.task.error).toBe("claude exited after re-attaching, before its turn reported: post-attach stderr boom")

      // Cached once at supervisor creation, never re-probed per task or per savePersistedTasks() call
      expect(selfPidIdentityCalls).toBe(1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("supports headless Codex and Gemini agent families (Gemini default) and parses their stream-json events", async () => {
    expect(resolveWorkerFamily({})).toBe("gemini")
    expect(resolveWorkerFamily({ agent: "builder" })).toBe("claude")
    expect(resolveWorkerFamily({ agent: "reviewer" })).toBe("claude")
    expect(resolveWorkerFamily({ agent: "builder", model: "gpt-5.4" })).toBe("codex")
    expect(resolveWorkerFamily({ agent: "builder", model: "gemini-4-argon-high" })).toBe("gemini")
    expect(resolveWorkerFamily({ family: "claude" })).toBe("claude")
    expect(resolveWorkerFamily({ agent: "claude" })).toBe("claude")
    for (const m of ["claude-opus-5-5", "claude-sonnet-5-5", "opus", "sonnet", "haiku", "fable"]) {
      expect(resolveWorkerFamily({ model: m })).toBe("claude")
    }
    expect(resolveWorkerFamily({ family: "codex" })).toBe("codex")
    expect(resolveWorkerFamily({ agent: "codex" })).toBe("codex")
    expect(resolveWorkerFamily({ family: "gemini" })).toBe("gemini")
    expect(resolveWorkerFamily({ agent: "gemini" })).toBe("gemini")
    expect(resolveWorkerFamily({ model: "gpt-5.4" })).toBe("codex")
    expect(resolveWorkerFamily({ model: "gemini-3.1-pro-preview" })).toBe("gemini")
    expect(resolveWorkerFamily({ model: "gemini-4-argon-high" })).toBe("gemini")
    expect(resolveWorkerFamily({ family: "unknown" })).toBeNull()

    const codexFresh = buildHeadlessCodexArgs({ prompt: "fix bug", sessionId: "sid-cx", resume: false, mode: "auto", model: "gpt-5.4" })
    expect(codexFresh).toEqual(["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.4", "--", "fix bug"])
    const codexResume = buildHeadlessCodexArgs({ prompt: "add test", sessionId: "sid-cx", resume: true, mode: "auto", model: "gpt-5.4" })
    expect(codexResume).toEqual(["exec", "resume", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.4", "--", "sid-cx", "add test"])

    // buildHeadlessGeminiArgs itself never injects worker --settings (so Headless Brain keeps its MCP tools).
    const geminiFresh = buildHeadlessGeminiArgs({ prompt: "-build ui", sessionId: "sid-gm", resume: false, mode: "auto", model: "Gemini 4 Argon (High)" })
    expect(geminiFresh).toEqual([
      "--print=-build ui", "--output-format", "stream-json",
      "--model", "gemini-4-argon-high", "--dangerously-skip-permissions",
    ])
    expect(geminiFresh).not.toContain("--settings")

    let brainTempDir = ""
    const brainBigArgs = buildHeadlessGeminiArgs({
      prompt: "z".repeat(GEMINI_INLINE_PROMPT_MAX + 100),
      sessionId: "sid-brain",
      resume: false,
      mode: "auto",
      onTempDir: (d) => { brainTempDir = d },
    })
    expect(brainBigArgs).not.toContain("--settings")
    expect(brainTempDir).not.toBe("")
    expect(existsSync(join(brainTempDir, "prompt.txt"))).toBe(true)
    rmSync(brainTempDir, { recursive: true, force: true })

    // buildHeadlessWorkerInvocation attaches worker --settings denying mcp(*) and host secret roots.
    const geminiinv = buildHeadlessWorkerInvocation({ family: "gemini", prompt: "build ui", sessionId: "agy-cid", resume: true, mode: "acceptEdits", home: "/h/test" })
    expect(geminiinv.cmd).toMatch(/(^|\/)agy$/)
    expect(geminiinv.args).toEqual(["--print=build ui", "--output-format", "stream-json", "--conversation", "agy-cid", "--mode", "accept-edits", "--settings", agyWorkerSettings("/h/test")])
    const parsedSettings = JSON.parse(geminiinv.args[geminiinv.args.indexOf("--settings") + 1]!) as { permissions: { deny: string[] } }
    expect(parsedSettings.permissions.deny).toContain("mcp(*)")
    for (const secretRoot of [
      "/h/test/.claude-companion", "/h/test/.config/tls-agent", "/h/test/.config/gh",
      "/h/test/.ssh", "/h/test/.aws", "/h/test/.gnupg",
      "/h/test/.claude/.credentials.json", "/h/test/.codex", "/proc",
    ]) {
      expect(parsedSettings.permissions.deny).toContain(`read_file(${secretRoot})`)
    }
    expect(geminiinv.cleanup).toBeUndefined()
    expect(resolveWorkerFamily({ model: "Gemini 4 Argon (Medium)" })).toBe("gemini")

    // Oversized (>90 KB) prompt uses 0600 file inside 0700 temp dir + --add-dir to avoid Linux E2BIG, cleaned up via cleanup().
    const bigPrompt = "x".repeat(GEMINI_INLINE_PROMPT_MAX + 500)
    const bigInv = buildHeadlessWorkerInvocation({ family: "gemini", prompt: bigPrompt, sessionId: "agy-big", resume: false, mode: "auto" })
    expect(bigInv.args[0]!.length).toBeLessThan(1024)
    const addDirIdx = bigInv.args.indexOf("--add-dir")
    expect(addDirIdx).toBeGreaterThan(-1)
    const promptDir = bigInv.args[addDirIdx + 1]!
    const promptFile = join(promptDir, "prompt.txt")
    expect(statSync(promptDir).mode & 0o777).toBe(0o700)
    expect(statSync(promptFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(promptFile, "utf8")).toBe(bigPrompt)
    expect(bigInv.args[0]).toContain(promptFile)
    bigInv.cleanup?.()
    expect(existsSync(promptDir)).toBe(false)

    // Codex stream events
    expect(parseStreamJsonLine(JSON.stringify({ type: "thread.started", thread_id: "cx-thread-1" }))).toEqual({ sessionId: "cx-thread-1" })
    expect(parseStreamJsonLine(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Opened https://github.com/jaubut/claude-companion/pull/500" },
    }))).toEqual({
      assistantText: "Opened https://github.com/jaubut/claude-companion/pull/500",
      prUrl: "https://github.com/jaubut/claude-companion/pull/500",
    })

    // Antigravity (agy) stream events
    expect(parseStreamJsonLine(JSON.stringify({ event: "init", conversation_id: "agy-1", init: { cwd: "/w" } }))).toEqual({ sessionId: "agy-1" })
    expect(parseStreamJsonLine(JSON.stringify({ event: "step_update", step_update: { conversation_id: "agy-1", state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "bun test" } } } })))
      .toEqual({ sessionId: "agy-1", step: "Running tests" })
    expect(parseStreamJsonLine(JSON.stringify({ event: "step_update", step_update: { conversation_id: "agy-1", state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/w/index.ts" } } } })))
      .toEqual({ sessionId: "agy-1", step: "Editing index.ts" })
    expect(parseStreamJsonLine(JSON.stringify({ event: "result", result: { conversation_id: "agy-1", status: "SUCCESS", response: "PR ready at https://github.com/jaubut/claude-companion/pull/501\n" } }))).toEqual({
      sessionId: "agy-1", done: true, isError: false,
      resultText: "PR ready at https://github.com/jaubut/claude-companion/pull/501",
      prUrl: "https://github.com/jaubut/claude-companion/pull/501",
    })
    expect(parseStreamJsonLine(JSON.stringify({ event: "result", result: { conversation_id: "agy-1", status: "ERROR", error: { message: "quota" } } })))
      .toEqual({ sessionId: "agy-1", done: true, isError: true, resultText: "quota" })
  })

  test("gemini: another Companion instance loading the state file leaves a live agy alone; a timeout reads as one, not agy's 'interrupted'", async () => {
    const home = join(tmpdir(), `worker-sup-agy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    // Real agy 1.5.x: idles while a background task runs; on SIGTERM prints an ERROR result "interrupted" and exits 1.
    const fakeAgy = join(home, "agy")
    writeFileSync(fakeAgy, `#!/bin/sh
trap 'printf "%s\\n" "{\\"event\\":\\"result\\",\\"result\\":{\\"conversation_id\\":\\"agy-conv-1\\",\\"status\\":\\"ERROR\\",\\"response\\":\\"\\",\\"error\\":\\"interrupted\\"}}"; echo "error: interrupted" >&2; exit 1' TERM
printf "%s\\n" "{\\"event\\":\\"init\\",\\"conversation_id\\":\\"agy-conv-1\\",\\"init\\":{}}"
echo "root agent idle; waiting for 1 background task(s) to finish" >&2
sleep 30 & wait $!
`)
    chmodSync(fakeAgy, 0o755)
    const makeSup = (selfPid?: number) => createWorkerSupervisor({
      host: "zettlab", home, selfPid, now: () => Date.now(), uuid: () => "dddd1111-2222-4333-8444-555555555555", trust: () => {}, reportJob: () => {},
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: (opts) => defaultSpawnWorker({ ...opts, cmd: fakeAgy }),
    })
    try {
      const sup = makeSup()
      expect((await sup.dispatchTask({ taskId: "gm-1", repo: "claude-companion", prompt: "inventory", family: "gemini", timeoutS: 3 })).ok).toBe(true)
      for (let i = 0; i < 100 && sup.getTask("gm-1")?.sessionId !== "agy-conv-1"; i++) await Bun.sleep(20)
      const pid = JSON.parse(readFileSync(join(home, ".claude", "state", "companion-worker-tasks.json"), "utf8"))[0].pid as number

      // A `bun test` or dev server importing wiring/worker-mcp on the same host: it must not reap the live server's worker.
      const other = makeSup(process.pid + 100_000)
      expect(other.getTask("gm-1")).toBeNull()
      expect(() => process.kill(pid, 0)).not.toThrow()

      const done = await sup.awaitTask("gm-1", 10_000)
      expect(done.ok && done.task.status).toBe("failed")
      expect(done.ok && done.task.error).toBe("timed out after 3s: root agent idle; waiting for 1 background task(s) to finish")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("injects FIELD_GUIDE.md on turn 1 for every family, never on a resume", async () => {
    const home = join(tmpdir(), `worker-sup-fg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const spawned: SpawnWorkerOpts[] = []
    const sup = createWorkerSupervisor({
      host: "zettlab", home, now: () => 1700000000000, uuid: () => "eeee1111-2222-4333-8444-555555555556",
      trust: () => {}, reportJob: () => {}, loadAgentSecrets: async () => ({}),
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) {
          const wt = args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!
          mkdirSync(wt, { recursive: true })
          writeFileSync(join(wt, "FIELD_GUIDE.md"), "- never edit brain/CLAUDE.md\n")
        }
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: (opts) => { spawned.push(opts); return { pid: 7778, kill() {} } },
    })
    try {
      for (const family of ["claude", "codex", "gemini"]) {
        await sup.dispatchTask({ taskId: `fg-${family}`, repo: "claude-companion", prompt: "Do it", family })
        const prompt = spawned.at(-1)!.args.join("\n")
        expect(prompt).toContain("## Repo Field Guide (FIELD_GUIDE.md - operational traps)\n- never edit brain/CLAUDE.md")
        expect(prompt.indexOf("Do it")).toBeLessThan(prompt.indexOf("Repo Field Guide"))
        expect(prompt).toContain(WORKER_FOOTER)
      }
      spawned[0]!.onStdoutLine(JSON.stringify({ type: "system", subtype: "init", session_id: "sid-fg" }))
      spawned[0]!.onExit(0, null)
      await sup.dispatchTask({ taskId: "fg-claude", repo: "claude-companion", prompt: "Follow up" })
      expect(spawned.at(-1)!.args.join("\n")).not.toContain("Repo Field Guide")
      await sup.dispatchTask({ taskId: "fg-slash", repo: "claude-companion", prompt: "/review" })
      expect(spawned.at(-1)!.args.join("\n")).not.toContain("Repo Field Guide")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("targetBranch: PR bound from the start, that PR's footer, no field guide, and never re-dispatched", async () => {
    const home = join(tmpdir(), `worker-sup-tb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const spawned: SpawnWorkerOpts[] = []
    const sup = createWorkerSupervisor({
      host: "zettlab", home, now: () => 1700000000000, uuid: () => "eeee1111-2222-4333-8444-555555555557",
      trust: () => {}, reportJob: () => {}, loadAgentSecrets: async () => ({}),
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) {
          const wt = args[args.indexOf("add") + 4]!
          mkdirSync(wt, { recursive: true })
          writeFileSync(join(wt, "FIELD_GUIDE.md"), "- planted by the PR\n")
        }
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: (opts) => { spawned.push(opts); return { pid: 7779, kill() {} } },
    })
    const pr = "https://github.com/jaubut/claude-companion/pull/9"
    const input = { taskId: "conflict-claude-companion-pr9-abcd1234", repo: "claude-companion", prompt: "Resolve", targetBranch: "dispatch/b1", targetPrUrl: pr }
    try {
      expect(await sup.dispatchTask({ ...input, targetPrUrl: "https://github.com/evil/claude-companion/pull/9" })).toEqual({ ok: false, status: 400, error: "invalid_target_pr" })
      const r = await sup.dispatchTask(input)
      expect(r.ok && [r.task.prUrl, r.task.branch]).toEqual([pr, "dispatch/conflict-claude-companion-pr9-abcd1234"])
      const prompt = spawned.at(-1)!.args.join("\n")
      expect(prompt).not.toContain("planted by the PR")
      expect(prompt).not.toContain(WORKER_SHIP_RULE)
      expect(prompt).toContain("git push origin HEAD:refs/heads/dispatch/b1")
      spawned[0]!.onExit(0, null)
      expect(await sup.dispatchTask(input)).toEqual({ ok: false, status: 409, error: "target_task_exists" })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("codex: no default model flag, never a claude-* id, and a resume keeps the task's family + model", async () => {
    const home = join(tmpdir(), `worker-sup-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const spawned: SpawnWorkerOpts[] = []
    const sup = createWorkerSupervisor({
      host: "zettlab", home, now: () => 1700000000000, uuid: () => "eeee1111-2222-4333-8444-555555555555",
      trust: () => {}, reportJob: () => {},
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: (opts) => { spawned.push(opts); return { pid: 7777, kill() {} } },
    })
    const finish = (i: number) => {
      spawned[i]!.onStdoutLine(JSON.stringify({ type: "thread.started", thread_id: "cx-thread" }))
      spawned[i]!.onExit(0, null)
    }
    try {
      // First dispatch, no model: codex picks its own config default.
      const fresh = await sup.dispatchTask({ taskId: "cx-default", repo: "claude-companion", prompt: "Fix it", family: "codex" })
      expect(fresh.ok && fresh.task.model).toBeNull()
      expect(spawned[0]!.cmd).toBe("codex")
      expect(spawned[0]!.args).not.toContain("-m")
      finish(0)
      // Follow-up with nothing named stays codex (a null model must not fall back to claude).
      await sup.dispatchTask({ taskId: "cx-default", repo: "claude-companion", prompt: "Again" })
      expect(spawned[1]!.cmd).toBe("codex")
      expect(spawned[1]!.args.slice(0, 2)).toEqual(["exec", "resume"])
      expect(spawned[1]!.args).not.toContain("-m")
      finish(1)

      // A claude id on a codex dispatch is dropped, never passed to codex.
      await sup.dispatchTask({ taskId: "cx-astra", repo: "claude-companion", prompt: "Build", family: "codex", model: "claude-opus-5-5" })
      expect(spawned[2]!.args.join(" ")).not.toContain("claude")
      finish(2)
      sup.setTaskModel("cx-astra", "gpt-6-astra")

      // Turn after completion: nothing named → recorded family + model.
      const t2 = await sup.dispatchTask({ taskId: "cx-astra", repo: "claude-companion", prompt: "Follow up" })
      expect(t2.ok && [t2.task.family, t2.task.model]).toEqual(["codex", "gpt-6-astra"])
      expect(spawned[3]!.args).toEqual(["exec", "resume", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-6-astra", "--", "cx-thread", `Follow up\n\n${WORKER_FOOTER}`])
      finish(3)
      // The turn-8 shape: family codex + a stale claude model → still the task's codex model.
      const t3 = await sup.dispatchTask({ taskId: "cx-astra", repo: "claude-companion", prompt: "Turn 8", family: "codex", model: "claude-opus-5-5" })
      expect(t3.ok && [t3.task.family, t3.task.model]).toEqual(["codex", "gpt-6-astra"])
      expect(spawned[4]!.args).toContain("gpt-6-astra")
      expect(spawned[4]!.args.join(" ")).not.toContain("claude")
      finish(4)

      // Switching family on resume (codex → gemini/agy) drops the stored codex model and defaults to DEFAULT_GEMINI_WORKER_MODEL.
      const t4 = await sup.dispatchTask({ taskId: "cx-astra", repo: "claude-companion", prompt: "Switch to agy", family: "gemini" })
      expect(t4.ok && [t4.task.family, t4.task.model]).toEqual(["gemini", DEFAULT_GEMINI_WORKER_MODEL])
      expect(spawned[5]!.cmd).toMatch(/(^|\/)agy$/)
      expect(spawned[5]!.args).toEqual([`--print=Switch to agy\n\n${WORKER_FOOTER}`, "--output-format", "stream-json", "--model", DEFAULT_GEMINI_WORKER_MODEL, "--dangerously-skip-permissions", "--settings", agyWorkerSettings()])
      spawned[5]!.onStdoutLine(JSON.stringify({ event: "init", conversation_id: "agy-conv-1", init: { cwd: "/w" } }))
      spawned[5]!.onExit(0, null)

      // Even an unprefixed custom codex model (where modelFitsFamily cannot infer codex) is dropped on family change to agy or claude.
      await sup.dispatchTask({ taskId: "cx-custom", repo: "claude-companion", prompt: "Custom codex", family: "codex", model: "spark-1" })
      expect(spawned[6]!.args).toContain("spark-1")
      finish(6)
      const tCustomAgy = await sup.dispatchTask({ taskId: "cx-custom", repo: "claude-companion", prompt: "Now agy", family: "gemini", model: "gpt-5.4" })
      expect(tCustomAgy.ok && [tCustomAgy.task.family, tCustomAgy.task.model]).toEqual(["gemini", DEFAULT_GEMINI_WORKER_MODEL])
      expect(spawned[7]!.cmd).toMatch(/(^|\/)agy$/)
      expect(spawned[7]!.args[spawned[7]!.args.indexOf("--model") + 1]).toBe(DEFAULT_GEMINI_WORKER_MODEL)
      expect(spawned[7]!.args.join(" ")).not.toContain("spark-1")
      expect(spawned[7]!.args.join(" ")).not.toContain("gpt-5.4")
      spawned[7]!.onExit(0, null)

      await sup.dispatchTask({ taskId: "cx-to-claude", repo: "claude-companion", prompt: "Codex first", family: "codex", model: "gpt-6-astra" })
      finish(8)
      const tClaude = await sup.dispatchTask({ taskId: "cx-to-claude", repo: "claude-companion", prompt: "Now claude", family: "claude" })
      expect(tClaude.ok && tClaude.task.family).toBe("claude")
      expect(tClaude.ok && tClaude.task.model).toMatch(/^claude-/)
      expect(spawned[9]!.args.join(" ")).not.toContain("gpt-6-astra")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("claude: a picked model survives turn 3+ (no retry escalation); a routed one still escalates; the pin survives a reload", async () => {
    const home = join(tmpdir(), `worker-sup-pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const spawned: SpawnWorkerOpts[] = []
    const make = () => createWorkerSupervisor({
      host: "zettlab", home, now: () => 1700000000000, uuid: () => "ffff1111-2222-4333-8444-555555555555",
      trust: () => {}, reportJob: () => {}, loadAgentSecrets: async () => ({}),
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: (opts) => { spawned.push(opts); return { pid: 7778, kill() {} } },
    })
    const finish = () => { const s = spawned.at(-1)!; s.onStdoutLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s" })); s.onExit(0, null) }
    // The phone-inject shape (routes/api.ts): a known task's follow-up names no family or model.
    const inject = (sup: ReturnType<typeof make>, taskId: string, prompt: string) => sup.dispatchTask({ taskId, repo: "claude-companion", prompt, mode: "auto", inheritClaim: true })
    const HAIKU = "claude-haiku-4-5-20251001"
    try {
      let sup = make()
      await sup.dispatchTask({ taskId: "pin-1", repo: "claude-companion", prompt: "Build", family: "claude" }); finish()
      sup.setTaskModel("pin-1", HAIKU)
      for (const turn of [2, 3]) {
        const t = await inject(sup, "pin-1", `Turn ${turn}`)
        expect(t.ok && t.task.model).toBe(HAIKU)
        expect(spawned.at(-1)!.args).toContain(HAIKU)
        expect(spawned.at(-1)!.args.join(" ")).not.toContain("claude-opus-5-5")
        finish()
      }
      sup = make()
      const t4 = await inject(sup, "pin-1", "Turn 4 after restart")
      expect(t4.ok && [t4.task.turnCount, t4.task.model]).toEqual([4, HAIKU])
      finish()

      // Never picked: the router re-routes turns 2-3 (Sonnet when localized) and escalates to Opus from turn 4.
      await sup.dispatchTask({ taskId: "routed-1", repo: "claude-companion", prompt: "Build", family: "claude" }); finish()
      for (const turn of [2, 3]) {
        const r = await inject(sup, "routed-1", `Turn ${turn}`); finish()
        expect(r.ok && r.task.model).toBe("claude-sonnet-5-5")
      }
      const r4 = await inject(sup, "routed-1", "Turn 4"); finish()
      expect(r4.ok && r4.task.model).toBe("claude-opus-5-5")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("invokes onTaskTerminal when a turn completes or fails so the Brain wakes immediately", async () => {
    const home = join(tmpdir(), `worker-sup-term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const spawned: SpawnWorkerOpts[] = []
    const terminalEvents: Array<{ taskId: string; status: string; prUrl: string | null }> = []
    const sup = createWorkerSupervisor({
      host: "zettlab", home, now: () => 1700000000000, uuid: () => "dddd1111-2222-4333-8444-555555555555",
      trust: () => {}, reportJob: () => {},
      onTaskTerminal: (t) => { terminalEvents.push({ taskId: t.taskId, status: t.status, prUrl: t.prUrl }) },
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: (opts) => { spawned.push(opts); return { pid: 8888, kill() {} } },
    })
    try {
      await sup.dispatchTask({ taskId: "wake-1", repo: "claude-companion", prompt: "Ship PR" })
      spawned[0]!.onStdoutLine(JSON.stringify({ type: "result", result: "Done https://github.com/jaubut/claude-companion/pull/999" }))
      spawned[0]!.onExit(0, null)
      expect(terminalEvents).toEqual([{ taskId: "wake-1", status: "completed", prUrl: "https://github.com/jaubut/claude-companion/pull/999" }])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a Claude worker gets the agent secrets minus the scrubbed ones; codex / gemini get neither", async () => {
    expect(parseAgentEnv([
      "export CLOUDFLARE_API_TOKEN=cf-abc",
      "export RESEND_API_KEY='re_1 2'",
      `export QUOTED='a'"'"'b'`,
      "export WEIRD=a\\ b",
      "garbage",
    ].join("\n"))).toEqual({ CLOUDFLARE_API_TOKEN: "cf-abc", RESEND_API_KEY: "re_1 2", QUOTED: "a'b" })

    const home = join(tmpdir(), `worker-sup-secrets-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const spawned: SpawnWorkerOpts[] = []
    let loads = 0
    let uuidN = 0
    const sup = createWorkerSupervisor({
      host: "zettlab", home, now: () => 1700000000000, uuid: () => `ffff1111-2222-4333-8444-55555555555${uuidN++}`,
      trust: () => {}, reportJob: () => {},
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: (opts) => { spawned.push(opts); return { pid: 8889, kill() {} } },
      loadAgentSecrets: async () => {
        loads++
        return {
          RESEND_API_KEY: "re_secret", CLOUDFLARE_API_TOKEN: "cf_secret",
          TURSO_AUTH_TOKEN: "turso", TURSO_DATABASE_URL: "libsql://x", COMPANION_AUTH_TOKEN: "comp",
          GITHUB_WEBHOOK_SECRET: "whsec", PHASE_SERVICE_TOKEN: "phase", OP_SERVICE_ACCOUNT_TOKEN: "op", BROKER_TOKEN: "broker",
        }
      },
    })
    try {
      await sup.dispatchTask({ taskId: "sec-claude", repo: "claude-companion", prompt: "Deploy", family: "claude" })
      const env = spawned[0]!.env
      expect(env.RESEND_API_KEY).toBe("re_secret")
      expect(env.CLOUDFLARE_API_TOKEN).toBe("cf_secret")
      for (const k of ["TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL", "COMPANION_AUTH_TOKEN", "GITHUB_WEBHOOK_SECRET", "PHASE_SERVICE_TOKEN", "OP_SERVICE_ACCOUNT_TOKEN", "BROKER_TOKEN"]) {
        expect(env[k]).toBeUndefined()
      }
      expect(env.CLAUDE_NO_AGENT_ENV).toBe("1")
      expect(spawned[0]!.cmd).toBe("claude")
      expect(spawned[0]!.args.slice(0, 2)).toEqual(["--settings", JSON.stringify({ sandbox: { network: { allowedDomains: WORKER_SANDBOX_HOSTS } } })])

      await sup.dispatchTask({ taskId: "sec-codex", repo: "claude-companion", prompt: "Deploy", family: "codex" })
      await sup.dispatchTask({ taskId: "sec-gemini", repo: "claude-companion", prompt: "Deploy", family: "gemini" })
      expect(loads).toBe(1)
      for (const s of spawned.slice(1)) expect(s.env.RESEND_API_KEY).toBeUndefined()
      expect(spawned[1]!.args).not.toContain("--settings")
      expect(spawned[2]!.args).toContain("--settings")
      expect(spawned[2]!.args[spawned[2]!.args.indexOf("--settings") + 1]).toContain("mcp(*)")
      expect(spawned[1]!.args).toEqual(buildHeadlessCodexArgs({ prompt: `Deploy\n\n${WORKER_FOOTER}`, sessionId: "ffff1111-2222-4333-8444-555555555551", resume: false, mode: "auto" }))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  describe("PR link binding (tasks.dispatch_pr_url)", () => {
    const PR = "https://github.com/jaubut/claude-companion/pull/999"
    const CLAIM = "hc1.0123abcd.turn-1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    function harness(home: string, o: { bind?: true | null | string | (() => Promise<true | null | string>); link?: (t: { taskId: string; prUrl: string | null; status: string }) => Promise<string> } = {}) {
      const spawned: SpawnWorkerOpts[] = []
      const binds: Array<[string, string]> = []
      const bindClaims: string[] = []
      const links: Array<{ taskId: string; prUrl: string | null; status: string }> = []
      const linkClaims: string[] = []
      const terminal: string[] = []
      const seen: unknown[] = [] // every snapshot the supervisor hands out
      const boundArgs: string[] = [] // what each callback was told about the claim binding
      let uuidN = 0
      const sup = createWorkerSupervisor({
        host: "zettlab", home, now: () => 1700000000000, uuid: () => `eeee1111-2222-4333-8444-55555555555${uuidN++ % 10}`,
        trust: () => {}, reportJob: () => {},
        onTaskTerminal: (t, bound) => { seen.push(t); boundArgs.push(`terminal:${bound}`); terminal.push(`${t.status}:${t.step}`) },
        syncSession: (t, _pid, bound) => { seen.push(t); boundArgs.push(`sync:${bound}`) },
        bindTask: async (taskId, repo, claim) => { binds.push([taskId, repo]); bindClaims.push(claim); return typeof o.bind === "function" ? o.bind() : o.bind === undefined ? true : o.bind },
        linkPr: async (t, claim) => { seen.push(t); links.push({ taskId: t.taskId, prUrl: t.prUrl, status: t.status }); linkClaims.push(claim); return o.link ? o.link(t) : "linked" },
        sh: async (_cmd, args) => {
          if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
          return { ok: true, out: "origin/main\n", err: "", code: 0 }
        },
        spawnWorker: (opts) => { spawned.push(opts); return { pid: 0, kill() {} } },
      })
      const finish = (i: number) => {
        spawned[i]!.onStdoutLine(JSON.stringify({ type: "result", result: `Done ${PR}` }))
        spawned[i]!.onExit(0, null)
      }
      return { sup, spawned, binds, bindClaims, links, linkClaims, terminal, seen, boundArgs, finish }
    }
    const tmpHome = () => {
      const home = join(tmpdir(), `worker-sup-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
      mkdirSync(join(home, "claude-config", ".git"), { recursive: true })
      return home
    }
    const flush = () => new Promise((r) => setTimeout(r, 0))

    test("binds once at dispatch; links before the turn is completed and before await_task wakes", async () => {
      const home = tmpHome()
      let release!: (v: string) => void
      const h = harness(home, { link: () => new Promise<string>((r) => { release = r }) })
      try {
        await h.sup.dispatchTask({ taskId: "bind-1", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        expect(h.binds).toEqual([["bind-1", "claude-companion"]])
        let woke = false
        const waiting = h.sup.awaitTask("bind-1", 10_000).then((r) => { woke = true; return r })
        h.finish(0)
        await flush()
        expect(h.links).toEqual([{ taskId: "bind-1", prUrl: PR, status: "running" }])
        expect(woke).toBe(false)
        expect(h.terminal).toEqual([])
        release("linked")
        const r = await waiting
        expect(r.ok && r.task.status).toBe("completed")
        expect(r.ok && r.task.step).toBe(`PR ready: ${PR}`)
        expect(h.terminal).toEqual([`completed:PR ready: ${PR}`])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("a link still pending past its bound says so in the step; a refusal is named; neither fails the turn", async () => {
      const home = tmpHome()
      const outcomes = ["timeout", "branch_mismatch"]
      const h = harness(home, { link: async () => outcomes.shift()! })
      try {
        await h.sup.dispatchTask({ taskId: "bind-2", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        await flush(); await flush()
        expect(h.terminal).toEqual([`completed:PR ready: ${PR} (PR link still pending)`])
        await h.sup.dispatchTask({ taskId: "bind-2", repo: "claude-companion", prompt: "Fix round", claim: CLAIM })
        h.finish(1)
        await flush(); await flush()
        expect(h.terminal[1]).toBe(`completed:PR ready: ${PR} (not linked: branch_mismatch)`)
        expect(h.binds).toHaveLength(1)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("an id with no eligible row at dispatch never links", async () => {
      const home = tmpHome()
      const h = harness(home, { bind: "not_ownable" })
      try {
        await h.sup.dispatchTask({ taskId: "bind-3", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        expect(h.links).toEqual([])
        expect(h.terminal).toEqual([`completed:PR ready: ${PR}`])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("reusing an id under another repo is refused and binds nothing", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        await h.sup.dispatchTask({ taskId: "bind-4", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        await flush(); await flush()
        expect(await h.sup.dispatchTask({ taskId: "bind-4", repo: "claude-config", prompt: "Borrow it", claim: CLAIM })).toEqual({ ok: false, status: 409, error: "task_repo_mismatch: bind-4 belongs to claude-companion" })
        expect(h.binds).toEqual([["bind-4", "claude-companion"]])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("the binding survives a state reload (the supervisor's own restart): a claimed fix round after it still links, without binding again", async () => {
      const home = tmpHome()
      try {
        const a = harness(home)
        await a.sup.dispatchTask({ taskId: "bind-5", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        a.finish(0)
        await flush(); await flush()
        const unbound = harness(home, { bind: "not_ownable" })
        await unbound.sup.dispatchTask({ taskId: "bind-6", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        unbound.spawned[0]!.onExit(1, null)
        const file = join(home, ".claude", "state", "companion-worker-tasks.json")
        const saved = JSON.parse(readFileSync(file, "utf8")) as Array<{ taskId: string; prLinkBound?: boolean }>
        expect(saved.find((r) => r.taskId === "bind-6")?.prLinkBound).toBe(false)

        const b = harness(home)
        await b.sup.dispatchTask({ taskId: "bind-5", repo: "claude-companion", prompt: "Fix review findings", claim: CLAIM })
        expect(b.binds).toEqual([])
        b.finish(0)
        await flush(); await flush()
        expect(b.links.map((l) => l.taskId)).toEqual(["bind-5"])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("a failed bind lookup persists no answer and is retried on the next turn", async () => {
      const home = tmpHome()
      try {
        const answers: Array<true | null> = [null, true]
        const a = harness(home, { bind: async () => answers.shift()! })
        await a.sup.dispatchTask({ taskId: "bind-7", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        a.finish(0)
        await flush(); await flush()
        expect(a.links).toEqual([])
        const file = join(home, ".claude", "state", "companion-worker-tasks.json")
        const saved = (JSON.parse(readFileSync(file, "utf8")) as Array<{ taskId: string; prLinkBound?: unknown }>).find((r) => r.taskId === "bind-7")!
        expect(saved.prLinkBound ?? null).toBeNull()

        const b = harness(home, { bind: async () => answers.shift()! })
        await b.sup.dispatchTask({ taskId: "bind-7", repo: "claude-companion", prompt: "Fix round", claim: CLAIM })
        expect(b.binds).toEqual([["bind-7", "claude-companion"]])
        b.finish(0)
        await flush(); await flush()
        expect(b.links.map((l) => l.taskId)).toEqual(["bind-7"])
        const again = (JSON.parse(readFileSync(file, "utf8")) as Array<{ taskId: string; prLinkBound?: unknown }>).find((r) => r.taskId === "bind-7")!
        expect(again.prLinkBound).toBe(true)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("no claim: nothing to bind, never links, and the dispatch says the claim is absent", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        const d = await h.sup.dispatchTask({ taskId: "claim-1", repo: "claude-companion", prompt: "Ship PR" })
        expect(d.ok && d.claim).toBe("absent")
        expect(h.binds).toEqual([])
        h.finish(0)
        await flush(); await flush()
        expect(h.links).toEqual([])
        expect(h.terminal).toEqual([`completed:PR ready: ${PR}`])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("a later turn that brings the claim binds a task dispatched without one; a refused claim says so", async () => {
      const home = tmpHome()
      const answers: Array<true | string> = ["bad_mac", true]
      const h = harness(home, { bind: async () => answers.shift()! })
      try {
        await h.sup.dispatchTask({ taskId: "claim-2", repo: "claude-companion", prompt: "Ship PR" })
        h.spawned[0]!.onExit(1, null)
        const refused = await h.sup.dispatchTask({ taskId: "claim-2", repo: "claude-companion", prompt: "Retry", claim: "hc1.bad" })
        expect(refused.ok && refused.claim).toBe("claim_refused:bad_mac")
        h.spawned[1]!.onExit(1, null)
        const ok = await h.sup.dispatchTask({ taskId: "claim-2", repo: "claude-companion", prompt: "Retry", claim: CLAIM })
        expect(ok.ok && ok.claim).toBe("verified")
        expect(h.bindClaims).toEqual(["hc1.bad", CLAIM])
        h.finish(2)
        await flush(); await flush()
        expect(h.linkClaims).toEqual([CLAIM])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("a bound task refuses a claimless redispatch after a completed turn (anyone holding the task id): 409 claim_required, nothing spawned, binding intact", async () => {
      const home = tmpHome()
      const h = harness(home)
      const saved = () => (JSON.parse(readFileSync(join(home, ".claude", "state", "companion-worker-tasks.json"), "utf8")) as Array<{ taskId: string; handoffClaim?: unknown; prLinkBound?: unknown; turnCount?: unknown }>)
      try {
        await h.sup.dispatchTask({ taskId: "claim-3", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        await flush(); await flush()
        const before = JSON.stringify(saved())
        // a lead or bearer peer that only read the id off list_tasks
        const borrowed = await h.sup.dispatchTask({ taskId: "claim-3", repo: "claude-companion", title: "T", prompt: "ship something unrelated", mode: "auto", family: "claude" })
        expect(borrowed).toEqual({ ok: false, status: 409, error: "claim_required" })
        expect(h.spawned).toHaveLength(1)
        expect(h.binds).toHaveLength(1)
        expect(JSON.stringify(saved())).toBe(before)
        expect(saved().find((r) => r.taskId === "claim-3")).toMatchObject({ handoffClaim: CLAIM, prLinkBound: true })
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("claimed -> claimless (refused) -> claimed again: verified, still bound, links", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        await h.sup.dispatchTask({ taskId: "claim-10", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        await flush(); await flush()
        expect(await h.sup.dispatchTask({ taskId: "claim-10", repo: "claude-companion", prompt: "Fix round" })).toEqual({ ok: false, status: 409, error: "claim_required" })
        const again = await h.sup.dispatchTask({ taskId: "claim-10", repo: "claude-companion", prompt: "Fix round", claim: CLAIM })
        expect(again.ok && again.claim).toBe("verified")
        expect(h.binds).toHaveLength(1)
        h.finish(1)
        await flush(); await flush()
        expect(h.linkClaims).toEqual([CLAIM, CLAIM])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("Jeremie's phone inject (routes/api.ts, inheritClaim) on a bound task resumes with the stored claim and still links", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        await h.sup.dispatchTask({ taskId: "claim-11", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        await flush(); await flush()
        // routes/api.ts deliverInject's shape: no claim field, the server asks for the stored one
        const inject = await h.sup.dispatchTask({ taskId: "claim-11", repo: "claude-companion", title: "T", prompt: "also fix the typo", mode: "auto", family: "claude", inheritClaim: true })
        expect(inject.ok && inject.claim).toBe("verified")
        expect(h.binds).toHaveLength(1)
        h.finish(1)
        await flush(); await flush()
        expect(h.linkClaims).toEqual([CLAIM, CLAIM])
        expect(JSON.stringify(inject)).not.toContain("hc1.")
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("a fix round that passes the valid claim again links, without re-binding a row its first PR already took", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        await h.sup.dispatchTask({ taskId: "claim-9", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        await flush(); await flush()
        const fix = await h.sup.dispatchTask({ taskId: "claim-9", repo: "claude-companion", prompt: "Fix review findings", claim: CLAIM })
        expect(fix.ok && fix.claim).toBe("verified")
        expect(h.binds).toHaveLength(1)
        h.finish(1)
        await flush(); await flush()
        expect(h.linkClaims).toEqual([CLAIM, CLAIM])
        expect(h.terminal[1]).toBe(`completed:PR ready: ${PR}`)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("the session sync and terminal callbacks are told whether the task is claim-bound (gates the notes DB status sync)", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        await h.sup.dispatchTask({ taskId: "sync-1", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        await flush(); await flush()
        expect(h.boundArgs.length).toBeGreaterThan(1)
        expect(new Set(h.boundArgs.map((a) => a.split(":")[1]))).toEqual(new Set(["true"]))
        h.boundArgs.length = 0
        await h.sup.dispatchTask({ taskId: "sync-2", repo: "claude-companion", prompt: "Ship PR" })
        h.finish(1)
        await flush(); await flush()
        expect(new Set(h.boundArgs.map((a) => a.split(":")[1]))).toEqual(new Set(["false"]))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("a bound task that failed refuses a claimless redispatch (409, binding intact); a fresh valid claim resumes it", async () => {
      const home = tmpHome()
      const h = harness(home)
      const saved = () => (JSON.parse(readFileSync(join(home, ".claude", "state", "companion-worker-tasks.json"), "utf8")) as Array<{ taskId: string; handoffClaim?: unknown; prLinkBound?: unknown; turnCount?: unknown }>)
      try {
        await h.sup.dispatchTask({ taskId: "claim-6", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.spawned[0]!.onExit(1, null) // failed before any PR was linked
        const borrowed = await h.sup.dispatchTask({ taskId: "claim-6", repo: "claude-companion", prompt: "something else entirely" })
        expect(borrowed).toEqual({ ok: false, status: 409, error: "claim_required" })
        expect(h.spawned).toHaveLength(1)
        expect(saved().find((r) => r.taskId === "claim-6")).toMatchObject({ handoffClaim: CLAIM, prLinkBound: true, turnCount: 1 })
        const again = await h.sup.dispatchTask({ taskId: "claim-6", repo: "claude-companion", prompt: "Retry", claim: CLAIM })
        expect(again.ok && again.claim).toBe("verified")
        expect(h.binds).toHaveLength(1)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("a bound worker reset to a new session (family change) still refuses a claimless dispatch", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        await h.sup.dispatchTask({ taskId: "claim-7", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        await flush(); await flush()
        h.sup.setTaskModel("claim-7", "gpt-5.4")
        expect(await h.sup.dispatchTask({ taskId: "claim-7", repo: "claude-companion", prompt: "Start over" })).toEqual({ ok: false, status: 409, error: "claim_required" })
        expect(h.spawned).toHaveLength(1)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("a wrong claim on a bound task is refused before anything runs, and never replaces the stored one", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        await h.sup.dispatchTask({ taskId: "claim-8", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.finish(0)
        await flush(); await flush()
        expect(await h.sup.dispatchTask({ taskId: "claim-8", repo: "claude-companion", prompt: "Fix round", claim: "hc1.forged" })).toEqual({ ok: false, status: 409, error: "claim_required" })
        expect(h.bindClaims).toEqual([CLAIM])
        expect(h.spawned).toHaveLength(1)
        const ok = await h.sup.dispatchTask({ taskId: "claim-8", repo: "claude-companion", prompt: "Fix round", claim: CLAIM })
        expect(ok.ok && ok.claim).toBe("verified")
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("an unbound task's invalid claim is refused with its reason and runs unbound", async () => {
      const home = tmpHome()
      const h = harness(home, { bind: async () => "bad_mac" })
      try {
        const bad = await h.sup.dispatchTask({ taskId: "claim-12", repo: "claude-companion", prompt: "Ship PR", claim: "hc1.forged" })
        expect(bad.ok && bad.claim).toBe("claim_refused:bad_mac")
        h.finish(0)
        await flush(); await flush()
        expect(h.links).toEqual([])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("a record bound before claims existed (#309 state) never links until a turn brings a claim", async () => {
      const home = tmpHome()
      try {
        const a = harness(home)
        await a.sup.dispatchTask({ taskId: "claim-4", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        a.spawned[0]!.onExit(1, null)
        const file = join(home, ".claude", "state", "companion-worker-tasks.json")
        const records = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>
        for (const r of records) delete r.handoffClaim // prLinkBound: true, no claim
        writeFileSync(file, JSON.stringify(records))

        const b = harness(home)
        await b.sup.dispatchTask({ taskId: "claim-4", repo: "claude-companion", prompt: "Fix round" })
        b.finish(0)
        await flush(); await flush()
        expect(b.links).toEqual([])
        await b.sup.dispatchTask({ taskId: "claim-4", repo: "claude-companion", prompt: "Fix round", claim: CLAIM })
        b.finish(1)
        await flush(); await flush()
        expect(b.linkClaims).toEqual([CLAIM])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("the claim never leaves the supervisor: no result, snapshot or callback carries it; the state file is 0600", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        const out: unknown[] = []
        out.push(await h.sup.dispatchTask({ taskId: "claim-5", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM }))
        const waiting = h.sup.awaitTask("claim-5", 5_000)
        h.finish(0)
        out.push(await waiting)
        await flush(); await flush()
        out.push(h.sup.listTasks(), h.sup.getTask("claim-5"), h.sup.setTaskModel("claim-5", "claude-sonnet-5-5"), await h.sup.interruptTask("claim-5"))
        const all = JSON.stringify([out, h.seen])
        expect(h.seen.length).toBeGreaterThan(2)
        expect(all).not.toContain("hc1.")
        expect(all).not.toContain("handoffClaim")
        expect(statSync(join(home, ".claude", "state", "companion-worker-tasks.json")).mode & 0o777).toBe(0o600)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("every family spawns with no notes DB, db or Companion/broker secret, and the claude shim told not to load them", async () => {
      const home = tmpHome()
      const h = harness(home)
      const seeded = {
        TURSO_AUTH_TOKEN: "t", TURSO_DATABASE_URL: "libsql://x", TURSO_TEST_AUTH_TOKEN: "t", LIBSQL_AUTH_TOKEN: "l", DATABASE_URL: "d",
        COMPANION_BODY_PEER_TOKEN: "p", COMPANION_GCAL_TOKEN_FILE: "/f", BROKER_TOKEN: "b", CLAUDE_CODE_OAUTH_TOKEN: "keep-oauth",
      }
      const saved = Object.fromEntries(Object.keys(seeded).map((k) => [k, process.env[k]]))
      Object.assign(process.env, seeded)
      try {
        for (const [i, family] of (["claude", "codex", "gemini"] as const).entries()) {
          await h.sup.dispatchTask({ taskId: `env-${family}`, repo: "claude-companion", prompt: "Ship PR", family })
          const env = h.spawned[i]!.env
          for (const k of ["TURSO_AUTH_TOKEN", "TURSO_DATABASE_URL", "TURSO_TEST_AUTH_TOKEN", "LIBSQL_AUTH_TOKEN", "DATABASE_URL", "COMPANION_BODY_PEER_TOKEN", "COMPANION_GCAL_TOKEN_FILE", "BROKER_TOKEN"]) {
            expect(env[k]).toBeUndefined()
          }
          expect(Object.keys(env).filter((k) => /^(TURSO|LIBSQL)_/i.test(k))).toEqual([])
          expect(env.CLAUDE_NO_AGENT_ENV).toBe("1")
          expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("keep-oauth")
          expect(env.PATH).toBe(process.env.PATH)
        }
      } finally {
        for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
        rmSync(home, { recursive: true, force: true })
      }
    })

    test("the brain's PR-ready receipt says when the link is still pending or was refused", () => {
      const base = { taskId: "t1", repo: "claude-companion", title: "T", status: "completed" as const, prUrl: PR, result: "", error: null }
      expect(workerReceipt({ ...base, step: `PR ready: ${PR}` })).toBe(`PR ready [t1] claude-companion — ${PR}`)
      const pending = workerReceipt({ ...base, step: `PR ready: ${PR} (PR link still pending)` })
      expect(pending).toBe(`PR ready [t1] claude-companion — ${PR} (PR link still pending)`)
      expect(pending).toMatch(/^PR ready\s+\[/)
      expect(workerReceipt({ ...base, step: `PR ready: ${PR} (not linked: branch_mismatch)` })).toEndWith("(not linked: branch_mismatch)")
      expect(workerReceipt({ ...base, prUrl: null, step: "Turn completed", result: "ok" })).toBe("completed [t1] claude-companion — T\nResult: ok")
      expect(workerReceipt({ ...base, status: "failed", prUrl: null, step: "Failed", error: "boom" })).toBe("blocked [t1] claude-companion — T\nError: boom")
    })
  })

  test("a repo with no checkout resolves to the dispatch-repos cache, else is cloned into ~/apps on demand", async () => {
    const home = join(tmpdir(), `worker-sup-clone-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const cache = join(home, ".cache", "dispatch-repos", "cached-site")
    mkdirSync(join(cache, ".git"), { recursive: true })
    const clones: string[][] = []
    const sup = createWorkerSupervisor({
      host: "zettlab", home, killGraceMs: 50, now: () => 1700000000000, uuid: () => "11111111-2222-4333-8444-555555555555",
      trust: () => {}, reportJob: () => {},
      sh: async (_cmd, args) => {
        if (args[0] === "clone") { clones.push(args); mkdirSync(join(args[args.length - 1]!, ".git"), { recursive: true }) }
        if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: () => ({ pid: 4243, kill() {} }),
    })
    try {
      expect(defaultResolveRepoDir("cached-site", home)).toBe(cache)
      expect(defaultResolveRepoDir("no-checkout", home)).toBeNull()

      const d = await sup.dispatchTask({ taskId: "task-clone", repo: "no-checkout", prompt: "Do work" })
      expect(d.ok).toBe(true)
      expect(clones).toEqual([["clone", "-q", "https://github.com/jaubut/no-checkout.git", join(home, "apps", "no-checkout")]])
      expect(defaultResolveRepoDir("no-checkout", home)).toBe(join(home, "apps", "no-checkout"))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("resuming a task whose worktree is on another branch is accepted: conversation resumed, branch recorded, prompt names it", async () => {
    const home = join(tmpdir(), `worker-sup-branch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const spawned: SpawnWorkerOpts[] = []
    const gitCalls: string[][] = []
    let onBranch = "dispatch/task-b"
    const sup = createWorkerSupervisor({
      host: "mac", home, now: () => 1700000000000, uuid: () => "cccc1111-2222-4333-8444-555555555555", trust: () => {}, reportJob: () => {},
      sh: async (_cmd, args) => {
        gitCalls.push(args)
        if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
        return { ok: true, out: args.includes("symbolic-ref") && args.includes("HEAD") ? `${onBranch}\n` : "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: (opts) => { spawned.push(opts); return { pid: 0, kill() {} } },
    })
    try {
      await sup.dispatchTask({ taskId: "task-b", repo: "claude-companion", prompt: "Start", family: "claude" })
      spawned[0]!.onStdoutLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }))
      spawned[0]!.onExit(0, null)
      onBranch = "dispatch/task-b-c"
      gitCalls.length = 0
      const r = await sup.dispatchTask({ taskId: "task-b", repo: "claude-companion", prompt: "Continue" })
      expect(r.ok).toBe(true)
      expect(spawned[1]!.args).toContain("--resume")
      expect(spawned[1]!.args.at(-1)).toContain("worktree is on branch dispatch/task-b-c, not dispatch/task-b")
      expect(sup.getTask("task-b")!.branch).toBe("dispatch/task-b-c")
      // Nothing mutating ran against the worktree: no checkout, switch, stash, reset or worktree add/remove.
      expect(gitCalls.filter((a) => a.some((x) => ["checkout", "switch", "stash", "reset", "add", "remove", "clean"].includes(x)))).toEqual([])

      // Lost state file (existing === undefined) with an existing worktree on a non-default branch still warns in prompt.
      mkdirSync(join(home, "apps", "wt", "claude-companion", "task-lost", ".git"), { recursive: true })
      onBranch = "dispatch/task-lost-c"
      const lost = await sup.dispatchTask({ taskId: "task-lost", repo: "claude-companion", prompt: "Recover", family: "claude" })
      expect(lost.ok).toBe(true)
      expect(spawned[2]!.args.at(-1)).toContain("worktree is on branch dispatch/task-lost-c, not dispatch/task-lost")
      expect(sup.getTask("task-lost")!.branch).toBe("dispatch/task-lost-c")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("a background-notification turn after the report never replaces it; every turn stays in full history (fd0fea0d)", async () => {
    const home = join(tmpdir(), `worker-sup-turns-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const spawned: SpawnWorkerOpts[] = []
    let clock = 1700000000000
    const mk = () => createWorkerSupervisor({
      host: "mac", home, now: () => ++clock, uuid: () => "eeee1111-2222-4333-8444-555555555555", trust: () => {}, reportJob: () => {},
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      spawnWorker: (opts) => { spawned.push(opts); return { pid: 0, kill() {} } },
    })
    const sup = mk()
    const report = `v8 ready: https://frame.io/v8-granby\nMusic: "Northern Lights" (Artlist), cut to the drop at 0:42.\nQA: ${"checked ".repeat(800)}all green.`
    const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text })
    try {
      await sup.dispatchTask({ taskId: "fd0fea0d", repo: "claude-companion", prompt: "Granby v8 edit", family: "claude" })
      expect(spawned[0]!.args.at(-1)).toContain(WORKER_TURN_RULE)
      // Turn 1: the real report. Turn 2, same process: the harness wakes it for a background job.
      spawned[0]!.onStdoutLine(result(report))
      spawned[0]!.onStdoutLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Checking the background job." }] } }))
      spawned[0]!.onStdoutLine(result("The background job hit its time limit; nothing else to do."))
      spawned[0]!.onExit(0, null)
      await Bun.sleep(5) // a no-PR receipt waits for the worktree's git status

      const got = sup.getTaskTurns("fd0fea0d")!
      expect(got.task.status).toBe("completed")
      expect(got.task.result).toBe(report) // never truncated, never replaced
      expect(got.turns.map((t) => [t.turn, t.status, t.result.length])).toEqual([[1, "completed", report.length], [2, "completed", 58]])
      // One receipt for the dispatch turn: the report, with the late turn shown beside it.
      const [receipt, ...rest] = sup.pendingReceipts()
      expect(rest).toEqual([])
      expect(receipt!.task.result).toBe(report)
      expect(receipt!.latest).toBe("The background job hit its time limit; nothing else to do.")
      const text = workerReceipt(receipt!.task, { host: "mac", latest: receipt!.latest })
      expect(text).toContain("Music: \"Northern Lights\"")
      expect(text).toContain("Later turn (kept in history): The background job hit its time limit")
      expect(text).toContain("bin/worker get --task fd0fea0d --host mac")

      // await returns every turn since the last read, once.
      const a1 = await sup.awaitTask("fd0fea0d", 0)
      expect(a1.ok && a1.turns.map((t) => t.turn)).toEqual([1, 2])
      const a2 = await sup.awaitTask("fd0fea0d", 0)
      expect(a2.ok && a2.turns).toEqual([])

      // A resumed turn that brings a new link is the new report; the history survives a restart.
      await sup.dispatchTask({ taskId: "fd0fea0d", repo: "claude-companion", prompt: "Try v9" })
      spawned[1]!.onStdoutLine(result("v9: https://frame.io/v9-granby"))
      spawned[1]!.onExit(0, null)
      const reloaded = mk().getTaskTurns("fd0fea0d")!
      expect(reloaded.task.result).toBe("v9: https://frame.io/v9-granby")
      expect(reloaded.turns.map((t) => t.turn)).toEqual([1, 2, 3])
      expect(reloaded.turns[0]!.result).toBe(report)

      // A later dispatch's short, link-free answer is its report: an earlier dispatch's longer report never wins.
      await sup.dispatchTask({ taskId: "fd0fea0d", repo: "claude-companion", prompt: "Fix CI" })
      spawned[2]!.onStdoutLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking at CI." }] } }))
      expect(sup.getTaskTurns("fd0fea0d")!.task.result).toBe("Looking at CI.") // the live card follows the open turn
      spawned[2]!.onStdoutLine(result("Couldn't fix CI, blocked by X."))
      spawned[2]!.onExit(0, null)
      await Bun.sleep(5)
      expect(sup.getTaskTurns("fd0fea0d")!.task.result).toBe("Couldn't fix CI, blocked by X.")
      expect(sup.pendingReceipts().at(-1)!.task.result).toBe("Couldn't fix CI, blocked by X.")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  describe("exit when done, own PR, receipts (2026-11-17)", () => {
    const result = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text })
    const assistant = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })
    // `gate`: a git / gh call (matched on its args) waits for the returned promise; `killOutput`: a line the worker prints on SIGTERM.
    function harness(opts: { dirty?: string; pr?: { state: string; head: string }; gate?: (args: string[]) => Promise<void> | undefined; killOutput?: string } = {}) {
      const home = join(tmpdir(), `worker-sup-exit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
      const spawned: SpawnWorkerOpts[] = []
      const signals: NodeJS.Signals[] = []
      const removed: string[] = []
      const state = { dirty: opts.dirty ?? "", pr: opts.pr ?? null, pushed: false }
      const sup = createWorkerSupervisor({
        host: "mac", home, killGraceMs: 50, reapGraceMs: 30, now: () => Date.now(), uuid: () => "dddd1111-2222-4333-8444-555555555555", trust: () => {}, reportJob: () => {},
        sh: async (cmd, args) => {
          const ok = (out: string) => ({ ok: true, out, err: "", code: 0 })
          await opts.gate?.(args)
          if (args.includes("worktree") && args.includes("add")) { mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true }); return ok("") }
          if (args.includes("status") && args.includes("--porcelain")) return ok(state.dirty)
          if (args.includes("--contains")) return ok(state.pushed ? "  origin/main\n" : "") // unpushed: only a merged / closed PR's head lets it go
          if (args.includes("rev-parse") && args.includes("HEAD")) return ok("abc123\n")
          if (cmd === "gh") return state.pr ? ok(JSON.stringify({ state: state.pr.state, headRefOid: state.pr.head })) : { ok: false, out: "", err: "no pr", code: 1 }
          if (args.includes("worktree") && args.includes("remove")) { removed.push(args.at(-1)!); rmSync(args.at(-1)!, { recursive: true, force: true }); return ok("") }
          return ok("origin/main\n")
        },
        spawnWorker(o) { spawned.push(o); return { pid: 0, kill(sig) { signals.push(sig); if (opts.killOutput) o.onStdoutLine(opts.killOutput); queueMicrotask(() => o.onExit(null, sig)) } } },
      })
      return { home, sup, spawned, signals, removed, state }
    }

    test("a worker idle after its turn (background work still running) exits, reads completed, and the receipt says it was stopped (ee0a87d5, 256a637a)", async () => {
      const h = harness()
      try {
        await h.sup.dispatchTask({ taskId: "ee0a87d5", repo: "claude-companion", prompt: "Render the cut" })
        // Output after a result is a new turn: it holds the reaper off until that turn ends too.
        h.spawned[0]!.onStdoutLine(result("Rendering in the background, done at 18:09."))
        h.spawned[0]!.onStdoutLine(assistant("Still checking the render."))
        await Bun.sleep(60)
        expect(h.signals).toEqual([])
        h.spawned[0]!.onStdoutLine(result("Last cold rounds running, I'll report back."))
        await Bun.sleep(60) // the reap grace, then SIGTERM; no exit from the worker itself
        expect(h.signals).toEqual(["SIGTERM"])
        const t = h.sup.getTask("ee0a87d5")!
        expect([t.status, t.error]).toEqual(["completed", null]) // our signal, not a failure
        const [r, ...rest] = h.sup.pendingReceipts()
        expect(rest).toEqual([]) // exactly one receipt
        expect(r!.note).toContain("background work still running")
        expect(workerReceipt(r!.task, { host: "mac", note: r!.note })).toContain("nothing it says is still running will finish")
      } finally { rmSync(h.home, { recursive: true, force: true }) }
    })

    test("agy's \"interrupted\" error on the reaper's SIGTERM never turns the finished turn into a failure (PR #332 review)", async () => {
      const h = harness({ killOutput: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "interrupted" }) })
      try {
        await h.sup.dispatchTask({ taskId: "reap-agy", repo: "claude-companion", prompt: "Render the cut" })
        h.spawned[0]!.onStdoutLine(result("Rendered: https://frame.io/v8"))
        await Bun.sleep(60)
        expect(h.signals).toEqual(["SIGTERM"])
        const got = h.sup.getTaskTurns("reap-agy")!
        expect([got.task.status, got.task.error, got.task.result]).toEqual(["completed", null, "Rendered: https://frame.io/v8"])
        expect(got.turns.map((t) => t.status)).toEqual(["completed"])
        const [r, ...rest] = h.sup.pendingReceipts()
        expect(rest).toEqual([])
        expect(r!.task.status).toBe("completed")
      } finally { rmSync(h.home, { recursive: true, force: true }) }
    })

    test("a restart while the no-PR receipt waits on git status still queues it (PR #332 review)", async () => {
      let release!: () => void
      const held = new Promise<void>((r) => { release = r })
      const h = harness({ gate: (args) => args.includes("status") ? held : undefined })
      try {
        await h.sup.dispatchTask({ taskId: "restart-gap", repo: "claude-companion", prompt: "Answer a question" })
        h.spawned[0]!.onStdoutLine(result("The answer is 42."))
        h.spawned[0]!.onExit(0, null)
        await Bun.sleep(5)
        expect(h.sup.pendingReceipts()).toEqual([]) // still waiting on git status
        // The server restarts here: the reloaded supervisor queues the receipt from the persisted state.
        const reloaded = createWorkerSupervisor({ host: "mac", home: h.home, now: () => Date.now(), uuid: () => "x", sh: async () => ({ ok: false, out: "", err: "", code: 1 }), trust: () => {}, reportJob: () => {} })
        expect(reloaded.pendingReceipts().map((r) => [r.task.taskId, r.task.result])).toEqual([["restart-gap", "The answer is 42."]])
        release(); await Bun.sleep(5)
        expect(h.sup.pendingReceipts()).toHaveLength(1) // the live one still queues exactly one, same id
        expect(h.sup.pendingReceipts()[0]!.id).toBe(reloaded.pendingReceipts()[0]!.id)
      } finally { release(); rmSync(h.home, { recursive: true, force: true }) }
    })

    test("a follow-up dispatch waits for an in-flight worktree close instead of a 409; a slow gh never holds it (PR #332 review)", async () => {
      let releaseFetch!: () => void
      const fetchHeld = new Promise<void>((r) => { releaseFetch = r })
      let releaseGh!: () => void
      const ghHeld = new Promise<void>((r) => { releaseGh = r })
      let holdFetch = false
      const h = harness({ pr: { state: "MERGED", head: "abc123" }, gate: (args) => args.includes("--json") ? ghHeld : holdFetch && args.includes("fetch") ? fetchHeld : undefined })
      try {
        await h.sup.dispatchTask({ taskId: "pr-close", repo: "claude-companion", prompt: "Fix it" })
        h.spawned[0]!.onStdoutLine(result("Done: https://github.com/jaubut/claude-companion/pull/402"))
        h.spawned[0]!.onExit(0, null)
        // gh is slow: a follow-up dispatched meanwhile starts at once, and the sweep then leaves its worktree alone.
        const sweep1 = h.sup.sweepWorktrees()
        await Bun.sleep(5)
        const d1 = await h.sup.dispatchTask({ taskId: "pr-close", repo: "claude-companion", prompt: "One more fix" })
        expect(d1.ok).toBe(true)
        releaseGh()
        expect(await sweep1).toEqual([])
        h.spawned[1]!.onStdoutLine(result("Done: https://github.com/jaubut/claude-companion/pull/402"))
        h.spawned[1]!.onExit(0, null)
        // The close itself holds the reservation (fetch held): a dispatch now waits for it, then recreates the worktree.
        holdFetch = true
        const sweep2 = h.sup.sweepWorktrees()
        await Bun.sleep(5)
        const d2 = h.sup.dispatchTask({ taskId: "pr-close", repo: "claude-companion", prompt: "Reopen" })
        await Bun.sleep(5)
        releaseFetch()
        expect(await sweep2).toEqual(["pr-close"])
        expect((await d2).ok).toBe(true)
      } finally { releaseGh(); releaseFetch(); rmSync(h.home, { recursive: true, force: true }) }
    })

    test("unspecified headless worker dispatches default to gemini (agy + gemini-4-argon-high); explicit claude, >90KB prompt cleanup, and legacy reload stay claude", async () => {
      const h = harness()
      try {
        const dGem = await h.sup.dispatchTask({ taskId: "def-gm", repo: "claude-companion", prompt: "Build default" })
        expect(dGem.ok && [dGem.task.family, dGem.task.model]).toEqual(["gemini", DEFAULT_GEMINI_WORKER_MODEL])
        expect(h.spawned[0]!.cmd).toMatch(/(^|\/)agy$/)
        expect(h.spawned[0]!.args[0]).toContain("Build default")
        expect(h.spawned[0]!.args).toContain("--output-format")
        expect(h.spawned[0]!.args).toContain("stream-json")
        expect(h.spawned[0]!.args[h.spawned[0]!.args.indexOf("--model") + 1]).toBe(DEFAULT_GEMINI_WORKER_MODEL)
        h.spawned[0]!.onExit(0, null)

        const dCl = await h.sup.dispatchTask({ taskId: "exp-cl", repo: "claude-companion", prompt: "Build claude", family: "claude" })
        expect(dCl.ok && dCl.task.family).toBe("claude")
        expect(h.spawned[1]!.cmd).toBe("claude")
        h.spawned[1]!.onExit(0, null)

        // >90 KB prompt writes a temp file + --add-dir and cleans up when the worker exits.
        const bigRes = await h.sup.dispatchTask({ taskId: "big-gm", repo: "claude-companion", prompt: "y".repeat(GEMINI_INLINE_PROMPT_MAX + 500) })
        expect(bigRes.ok).toBe(true)
        const bigArgs = h.spawned[2]!.args
        const dir = bigArgs[bigArgs.indexOf("--add-dir") + 1]!
        expect(existsSync(join(dir, "prompt.txt"))).toBe(true)
        h.spawned[2]!.onExit(0, null)
        expect(existsSync(dir)).toBe(false)

        // Legacy persisted record with neither family nor model reloads as claude (never sent to agy --conversation).
        const statePath = join(h.home, ".claude", "state", "companion-worker-tasks.json")
        const recs = JSON.parse(readFileSync(statePath, "utf8")) as Array<Record<string, unknown>>
        const legacyId = "legacy-claude-1"
        const legacyWt = join(h.home, "apps", "wt", "claude-companion", legacyId)
        mkdirSync(legacyWt, { recursive: true })
        recs.push({
          taskId: legacyId, repo: "claude-companion", repoDir: join(h.home, "claude-companion"),
          title: "Legacy", builder: "b", model: null, branch: `dispatch/${legacyId}`,
          worktree: legacyWt, sessionId: "legacy-claude-sid", status: "completed", turnCount: 1,
          step: "Turn completed", pct: 100, result: "ok", prUrl: null, error: null,
          startedAt: 1, updatedAt: 1, completedAt: 1, sessionStarted: true,
        })
        writeFileSync(statePath, JSON.stringify(recs))
        const reloaded = createWorkerSupervisor({
          host: "mac", home: h.home, now: () => Date.now(), uuid: () => "u", trust: () => {}, reportJob: () => {},
          sh: async () => ({ ok: true, out: "origin/main\n", err: "", code: 0 }),
          spawnWorker: (o) => { h.spawned.push(o); return { pid: 0, kill() {} } },
        })
        expect(reloaded.getTask(legacyId)?.family).toBe("claude")
      } finally { rmSync(h.home, { recursive: true, force: true }) }
    })

    test("an agy model label ('Gemini 4 Hydrogen (High)') maps to its slug; unknown or shell-shaped labels stay invalid_model", async () => {
      const h = harness()
      try {
        const d = await h.sup.dispatchTask({ taskId: "agy-label", repo: "claude-companion", prompt: "Build", model: "Gemini 4 Hydrogen (High)" })
        expect(d.ok && [d.task.family, d.task.model]).toEqual(["gemini", "gemini-4-hydrogen-high"])
        const args = h.spawned[0]!.args
        expect(args[args.indexOf("--model") + 1]).toBe("gemini-4-hydrogen-high")
        h.spawned[0]!.onExit(0, null)
        for (const bad of ["Gemini 4 Hydrogen (High); rm -rf ~", "$(id)", "Gemini 9 Unknown (High)", "gemini-4-hydrogen-high `id`"]) {
          const r = await h.sup.dispatchTask({ taskId: "agy-bad", repo: "claude-companion", prompt: "Build", model: bad })
          expect(r).toEqual({ ok: false, status: 400, error: "invalid_model" })
        }
        expect(h.spawned).toHaveLength(1)
      } finally { rmSync(h.home, { recursive: true, force: true }) }
    })

    test("every brief tells the worker to commit, push and open its own PR, and not to end on background work (a88c7bd9)", async () => {
      const h = harness()
      try {
        await h.sup.dispatchTask({ taskId: "a88c7bd9", repo: "claude-companion", prompt: "NDI TX enclosure CAD", family: "claude" })
        const prompt = h.spawned[0]!.args.at(-1)!
        expect(prompt).toContain(WORKER_SHIP_RULE)
        expect(prompt).toContain(WORKER_TURN_RULE)
        expect(WORKER_SHIP_RULE).toMatch(/commit them yourself.*push.*open ONE pull request.*PR link in your final report/)
        expect(WORKER_SHIP_RULE).toContain("the runner commits the diff and opens the PR\" (headless DISPATCH_HEADLESS jobs) does not apply")
        // A brief near the cap is refused, never silently cut to fit the footer.
        expect(await h.sup.dispatchTask({ taskId: "too-long", repo: "claude-companion", prompt: "x".repeat(100_000 - 10) })).toEqual({ ok: false, status: 400, error: "invalid_prompt" })
      } finally { rmSync(h.home, { recursive: true, force: true }) }
    })

    test("finished with no PR: a dirty worktree is kept and the receipt says so; interrupt --close-worktree refuses it; a clean one closes (a88c7bd9)", async () => {
      const h = harness({ dirty: "A  cad/enclosure.step\nA  cad/lid.step\nM  README.md\n" })
      try {
        await h.sup.dispatchTask({ taskId: "a88c7bd9", repo: "claude-companion", prompt: "NDI TX enclosure CAD" })
        h.spawned[0]!.onStdoutLine(result("Enclosure modelled; everything staged, the runner commits."))
        h.spawned[0]!.onExit(0, null)
        await Bun.sleep(5)
        const wt = h.sup.getTask("a88c7bd9")!.worktree
        const [r] = h.sup.pendingReceipts()
        expect(r!.note).toBe(`No PR, and 3 uncommitted or ignored file(s) left in ${wt}: worktree kept. Resume the task to commit and open the PR.`)
        expect(workerReceipt(r!.task, { host: "mac", note: r!.note })).toContain("worktree kept")
        expect(h.removed).toEqual([])
        expect(await h.sup.interruptTask("a88c7bd9", { closeWorktree: true })).toEqual({ ok: false, status: 409, error: `worktree kept: 3 uncommitted or ignored file(s) in ${wt}` })
        expect(await h.sup.sweepWorktrees()).toEqual([])
        expect(h.removed).toEqual([])

        // Clean but HEAD on no remote branch: kept, nothing lost. Clean and on origin: closes on its own.
        h.state.dirty = ""
        for (const [i, id, pushed] of [[1, "b1", false], [2, "b2", true]] as const) {
          h.state.pushed = pushed
          await h.sup.dispatchTask({ taskId: id, repo: "claude-companion", prompt: "Answer a question" })
          h.spawned[i]!.onStdoutLine(result("The answer is 42."))
          h.spawned[i]!.onExit(0, null)
          await Bun.sleep(5)
        }
        expect(h.removed).toEqual([h.sup.getTask("b2")!.worktree])
        expect(h.sup.pendingReceipts().find((r) => r.task.taskId === "b2")!.note).toBeNull()
      } finally { rmSync(h.home, { recursive: true, force: true }) }
    })

    test("the short and long form of a task id (0bb587b3 / 0bb587b3d29b…) land on the same task and worktree; an ambiguous prefix on none", async () => {
      const h = harness({ dirty: " M a.ts\n" })
      const long = "0bb587b3d29b40658c7709be77d3c5d8"
      try {
        await h.sup.dispatchTask({ taskId: long, repo: "claude-companion", prompt: "Fix it" })
        h.spawned[0]!.onStdoutLine(result("Half done."))
        h.spawned[0]!.onExit(0, null)
        await Bun.sleep(5)
        expect(h.sup.getTask("0bb587b3")!.taskId).toBe(long)
        const again = await h.sup.dispatchTask({ taskId: "0bb587b3", repo: "claude-companion", prompt: "Finish it" })
        expect(again.ok && [again.task.taskId, again.task.turnCount, again.task.worktree]).toEqual([long, 2, join(h.home, "apps", "wt", "claude-companion", long)])
        expect(h.sup.listTasks()).toHaveLength(1)
        expect((await h.sup.interruptTask("0bb587b3")).ok).toBe(true)

        await h.sup.dispatchTask({ taskId: "1234abcd", repo: "claude-companion", prompt: "Short" })
        h.spawned[2]!.onExit(0, null)
        expect(h.sup.getTask("1234abcd9999")!.taskId).toBe("1234abcd")
        const longToShort = await h.sup.dispatchTask({ taskId: "1234abcd9999", repo: "claude-companion", prompt: "Resume via long" })
        expect(longToShort.ok && [longToShort.task.taskId, longToShort.task.turnCount]).toEqual(["1234abcd", 2])
        h.spawned[3]!.onExit(0, null)

        // Non-hex, slug, and suffixed 8+ char IDs never prefix-match across dispatch, get, or interrupt --close-worktree.
        expect(h.sup.getTask("0bb587b3-resolve")).toBeNull()
        const resTask = await h.sup.dispatchTask({ taskId: "0bb587b3-resolve", repo: "claude-companion", prompt: "Resolve conflicts" })
        expect(resTask.ok && [resTask.task.taskId, resTask.task.turnCount]).toEqual(["0bb587b3-resolve", 1])
        h.spawned[4]!.onExit(0, null)
        // Pure hex short ID still resolves uniquely to the pure hex long task even alongside 0bb587b3-resolve.
        expect(h.sup.getTask("0bb587b3")!.taskId).toBe(long)

        await h.sup.dispatchTask({ taskId: "fix-auth-123", repo: "claude-companion", prompt: "Auth 1" })
        expect(h.sup.getTask("fix-auth-123-2")).toBeNull()
        expect(await h.sup.interruptTask("fix-auth-123-2", { closeWorktree: true })).toEqual({ ok: false, status: 404, error: "task_not_found" })
        expect(h.sup.getTask("fix-auth-123")!.status).toBe("running")
        const slug2 = await h.sup.dispatchTask({ taskId: "fix-auth-123-2", repo: "claude-companion", prompt: "Auth 2" })
        expect(slug2.ok && [slug2.task.taskId, slug2.task.turnCount]).toEqual(["fix-auth-123-2", 1])
        h.state.dirty = ""; h.state.pushed = true
        const closedSlug2 = await h.sup.interruptTask("fix-auth-123-2", { closeWorktree: true })
        expect(closedSlug2.ok && [closedSlug2.task.taskId, closedSlug2.worktreeRemoved]).toEqual(["fix-auth-123-2", true])
        expect(h.sup.getTask("fix-auth-123")!.status).toBe("running")
        expect(existsSync(h.sup.getTask("fix-auth-123")!.worktree)).toBe(true)

        await h.sup.dispatchTask({ taskId: "0bb587b3ffff", repo: "claude-companion", prompt: "Other" })
        expect(h.sup.getTask("0bb587b3")).toBeNull()
        expect(h.sup.getTask("0bb587b")).toBeNull() // under 8 chars: exact only
      } finally { rmSync(h.home, { recursive: true, force: true }) }
    })

    test("a PR task's worktree closes once the PR is merged or closed, never while open or dirty", async () => {
      const PR = "https://github.com/jaubut/claude-companion/pull/400"
      const h = harness({ pr: { state: "OPEN", head: "abc123" } })
      try {
        await h.sup.dispatchTask({ taskId: "pr-task", repo: "claude-companion", prompt: "Fix it" })
        h.spawned[0]!.onStdoutLine(result(`Done: ${PR}`))
        h.spawned[0]!.onExit(0, null)
        expect(h.sup.pendingReceipts()).toHaveLength(1) // a PR receipt never waits on git
        expect(await h.sup.sweepWorktrees()).toEqual([])
        h.state.pr = { state: "MERGED", head: "abc123" }
        h.state.dirty = " M x.ts\n"
        expect(await h.sup.sweepWorktrees()).toEqual([])
        h.state.dirty = ""
        expect(await h.sup.sweepWorktrees()).toEqual(["pr-task"])
        expect(h.removed).toEqual([h.sup.getTask("pr-task")!.worktree])
      } finally { rmSync(h.home, { recursive: true, force: true }) }
    })

    test("the receipt carries the report (first 1500 chars) and every link past the cut, so the brain needs no follow-up call (742990dd)", () => {
      const PR = "https://github.com/jaubut/claude-companion/pull/401"
      const review = "https://frame.io/reviews/v9-granby"
      const report = `v9 ready: ${review}\nMusic: Artlist "Northern Lights".\n${"QA line ok. ".repeat(200)}\nPR: ${PR}`
      const text = workerReceipt({ taskId: "54f3b9d9", repo: "claude-companion", title: "Granby v9", status: "completed", step: "Turn completed", prUrl: null, result: report, error: null }, { host: "mac" })
      expect(text).toContain(report.slice(0, 1500))
      expect(text).toContain(`…\nLinks: ${PR}`) // the PR sat past the cut
      expect(text.match(/frame\.io/g)).toHaveLength(1) // a link already shown isn't repeated
      expect(text).toEndWith("Full report, every turn: bin/worker get --task 54f3b9d9 --host mac")
    })
  })

  test("one worker task = one live session: the placeholder id is retired when agy / codex mint the real one", async () => {
    const home = join(tmpdir(), `worker-sup-ghost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    // Fake agy: announces its own conversation id, then works for a while.
    const fakeAgy = join(home, "agy")
    writeFileSync(fakeAgy, `#!/bin/sh
printf "%s\\n" "{\\"event\\":\\"init\\",\\"conversation_id\\":\\"agy-real-1\\",\\"init\\":{}}"
sleep 30
`)
    chmodSync(fakeAgy, 0o755)
    const fakes: SpawnWorkerOpts[] = []
    const ids = ["ghost-gm", "ghost-cx", "ghost-cl"]
    let n = 0
    const sup = createWorkerSupervisor({
      host: "zettlab", home, now: () => Date.now(), uuid: () => `placeholder-${++n}`, trust: () => {}, reportJob: () => {},
      sh: async (_cmd, args) => {
        if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
        return { ok: true, out: "origin/main\n", err: "", code: 0 }
      },
      syncSession: (t, pid) => { recordWorkerSession(t, pid, "") },
      spawnWorker: (opts) => opts.cmd.endsWith("agy") ? defaultSpawnWorker({ ...opts, cmd: fakeAgy }) : (fakes.push(opts), { pid: process.pid, kill() {} }),
    })
    const live = (taskId: string) => listSessions().filter((s) => s.taskId === taskId).map((s) => s.sessionId)
    try {
      expect((await sup.dispatchTask({ taskId: ids[0]!, repo: "claude-companion", prompt: "build", family: "gemini" })).ok).toBe(true)
      expect(live(ids[0]!)).toEqual(["placeholder-1"])
      for (let i = 0; i < 100 && sup.getTask(ids[0]!)?.sessionId !== "agy-real-1"; i++) await Bun.sleep(20)
      expect(live(ids[0]!)).toEqual(["agy-real-1"])

      await sup.dispatchTask({ taskId: ids[1]!, repo: "claude-companion", prompt: "build", family: "codex" })
      fakes[0]!.onStdoutLine(JSON.stringify({ type: "thread.started", thread_id: "cx-real-1" }))
      expect(live(ids[1]!)).toEqual(["cx-real-1"])
      // Claude takes the supervisor's id as --session-id, so it never changes.

      await sup.dispatchTask({ taskId: ids[2]!, repo: "claude-companion", prompt: "build", family: "claude" })
      fakes[1]!.onStdoutLine(JSON.stringify({ type: "system", subtype: "init", session_id: "placeholder-3" }))
      expect(live(ids[2]!)).toEqual(["placeholder-3"])

      // Discovery / the agy poller must not re-card a worker's conversation as headless:agy, even a retired id.
      expect(workerOwnsConvo("agy-real-1", "/elsewhere", listSessions(), "/nohome")).toBe(true)
      expect(workerOwnsConvo("placeholder-1", sup.getTask(ids[0]!)!.worktree, listSessions(), "/nohome")).toBe(true)
      expect(workerOwnsConvo("pruned", join(home, "apps", "wt", "claude-companion", "gone"), [], home)).toBe(true)
      expect(workerOwnsConvo("mine", "/elsewhere", listSessions(), "/nohome")).toBe(false)
    } finally {
      await sup.interruptTask(ids[0]!)
      for (const s of listSessions()) if (ids.includes(s.taskId)) removeSessionByKey(s.key)
      rmSync(home, { recursive: true, force: true })
    }
  })

  describe("turn watchdog: hourly check-in, idle kill, explicit timeout (no 1 h hard stop)", () => {
    const MIN = 60_000
    const step = (cmd: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: cmd } }] } })
    async function harness() {
      const home = join(tmpdir(), `worker-sup-watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
      const spawned: SpawnWorkerOpts[] = []
      const kills: string[] = []
      let clock = 1700000000000
      const sup = createWorkerSupervisor({
        host: "zettlab", home, now: () => clock, uuid: () => "aaaa1111-2222-4333-8444-555555555555", trust: () => {}, reportJob: () => {},
        sh: async (_cmd, args) => {
          if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
          return { ok: true, out: "origin/main\n", err: "", code: 0 }
        },
        spawnWorker: (opts) => { spawned.push(opts); return { pid: 0, kill(sig) { kills.push(sig ?? "SIGTERM") } } },
      })
      /** Minute by minute; `out` = worker prints a step every N minutes (0: silent). */
      const advance = (minutes: number, out = 0) => {
        for (let i = 1; i <= minutes; i++) {
          clock += MIN
          if (out && i % out === 0) spawned.at(-1)!.onStdoutLine(step(`bun test ${i}`))
          jest.advanceTimersByTime(MIN)
        }
      }
      return { home, sup, spawned, kills, advance }
    }

    test("a long turn is never killed: one check-in receipt per hour, then the real receipt", async () => {
      jest.useFakeTimers()
      const h = await harness()
      try {
        await h.sup.dispatchTask({ taskId: "pelchat1", repo: "claude-companion", prompt: "big refactor", title: "Pelchat refactor" })
        h.advance(CHECKIN_MS / MIN - 1, 5)
        expect(h.sup.pendingReceipts()).toEqual([])
        h.advance(1)
        expect(h.kills).toEqual([])
        const [r1, ...rest] = h.sup.pendingReceipts()
        expect(rest).toEqual([])
        expect(r1!.task.status).toBe("running")
        expect(workerReceipt(r1!.task, { host: "zettlab", note: r1!.note })).toBe(
          "still running [pelchat1] Pelchat refactor — 1 h 0 min, step: Running tests, last output 5 min ago\nFull report, every turn: bin/worker get --task pelchat1 --host zettlab")
        h.advance(CHECKIN_MS / MIN, 7) // re-armed: one more an hour later, still no kill
        expect(h.kills).toEqual([])
        expect(h.sup.pendingReceipts().map((r) => r.note)).toEqual([r1!.note, "2 h 0 min, step: Running tests, last output 4 min ago"])
        expect(h.sup.getTask("pelchat1")!.status).toBe("running")

        h.spawned[0]!.onStdoutLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done: https://github.com/jaubut/claude-companion/pull/9" }))
        h.spawned[0]!.onExit(0, null)
        const all = h.sup.pendingReceipts()
        expect(all).toHaveLength(3) // the final receipt never collides with a check-in's id
        expect(new Set(all.map((r) => r.id)).size).toBe(3)
        expect(all[2]!.task.status).toBe("completed")
      } finally {
        jest.useRealTimers(); rmSync(h.home, { recursive: true, force: true })
      }
    })

    test("a worker silent for IDLE_KILL_MS is stopped; the receipt says so and keeps the worktree", async () => {
      jest.useFakeTimers()
      const h = await harness()
      try {
        await h.sup.dispatchTask({ taskId: "stuck1", repo: "claude-companion", prompt: "x", title: "Stuck" })
        h.advance(10, 1)
        h.advance(IDLE_KILL_MS / MIN - 1)
        expect(h.kills).toEqual([])
        h.advance(1)
        expect(h.kills).toEqual(["SIGTERM"])
        h.spawned[0]!.onExit(null, "SIGTERM")
        const task = h.sup.getTask("stuck1")!
        expect(task.status).toBe("failed")
        expect(task.error).toBe(`stopped: no output for 30 min; worktree kept at ${task.worktree}`)
        const [r] = h.sup.pendingReceipts()
        expect(workerReceipt(r!.task, { host: "zettlab", note: r!.note })).toContain(`blocked [stuck1] claude-companion — Stuck\nError: stopped: no output for 30 min; worktree kept at ${task.worktree}`)
      } finally {
        jest.useRealTimers(); rmSync(h.home, { recursive: true, force: true })
      }
    })

    test("an explicit timeout_s is still a hard limit, output or not", async () => {
      jest.useFakeTimers()
      const h = await harness()
      try {
        await h.sup.dispatchTask({ taskId: "hard1", repo: "claude-companion", prompt: "x", timeoutS: 120 })
        h.advance(1, 1)
        expect(h.kills).toEqual([])
        h.advance(1, 1)
        expect(h.kills).toEqual(["SIGTERM"])
        h.spawned[0]!.onExit(null, "SIGTERM")
        expect(h.sup.getTask("hard1")!.error).toBe("timed out after 120s")
      } finally {
        jest.useRealTimers(); rmSync(h.home, { recursive: true, force: true })
      }
    })
  })
})
