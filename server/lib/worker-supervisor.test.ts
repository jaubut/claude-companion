import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BuilderReport } from "./builder-jobs"
import {
  type SpawnWorkerOpts,
  buildHeadlessClaudeArgs,
  buildHeadlessCodexArgs,
  buildHeadlessGeminiArgs,
  buildHeadlessWorkerInvocation,
  buildWorkerEnv,
  createWorkerSupervisor,
  parseStreamJsonLine,
  resolveWorkerFamily,
} from "./worker-supervisor"
import { workerReceipt } from "./worker-pr-link"

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
    expect(env.CLAUDE_NO_AGENT_ENV).toBe("1")
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

      // Whole group gone: cleanup proceeds
      groupAlive = false
      const done = await sup2.interruptTask("noid-1", { closeWorktree: true })
      expect(done.ok && done.worktreeRemoved).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("supports headless Codex and Gemini agent families and parses their stream-json events", async () => {
    expect(resolveWorkerFamily({ family: "codex" })).toBe("codex")
    expect(resolveWorkerFamily({ family: "gemini" })).toBe("gemini")
    expect(resolveWorkerFamily({ model: "gpt-5.4" })).toBe("codex")
    expect(resolveWorkerFamily({ model: "gemini-3.1-pro-preview" })).toBe("gemini")
    expect(resolveWorkerFamily({ family: "unknown" })).toBeNull()

    const codexFresh = buildHeadlessCodexArgs({ prompt: "fix bug", sessionId: "sid-cx", resume: false, mode: "auto", model: "gpt-5.4" })
    expect(codexFresh).toEqual(["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.4", "--", "fix bug"])
    const codexResume = buildHeadlessCodexArgs({ prompt: "add test", sessionId: "sid-cx", resume: true, mode: "auto", model: "gpt-5.4" })
    expect(codexResume).toEqual(["exec", "resume", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", "gpt-5.4", "--", "sid-cx", "add test"])

    const geminiFresh = buildHeadlessGeminiArgs({ prompt: "build ui", sessionId: "sid-gm", resume: false, mode: "auto", model: "gemini-3.1-pro-preview" })
    expect(geminiFresh).toEqual(["--output-format", "stream-json", "--approval-mode", "yolo", "--session-id", "sid-gm", "--model", "gemini-3.1-pro-preview", "-p", "build ui"])
    const geminiinv = buildHeadlessWorkerInvocation({ family: "gemini", prompt: "build ui", sessionId: "sid-gm", resume: true, mode: "acceptEdits", model: "gemini-3.1-pro-preview" })
    expect(geminiinv.cmd).toBe("gemini")
    expect(geminiinv.args).toContain("--resume")

    // Codex stream events
    expect(parseStreamJsonLine(JSON.stringify({ type: "thread.started", thread_id: "cx-thread-1" }))).toEqual({ sessionId: "cx-thread-1" })
    expect(parseStreamJsonLine(JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "Opened https://github.com/jaubut/claude-companion/pull/500" },
    }))).toEqual({
      assistantText: "Opened https://github.com/jaubut/claude-companion/pull/500",
      prUrl: "https://github.com/jaubut/claude-companion/pull/500",
    })

    // Gemini stream events
    expect(parseStreamJsonLine(JSON.stringify({ type: "init", session_id: "gm-sid-1" }))).toEqual({ sessionId: "gm-sid-1" })
    expect(parseStreamJsonLine(JSON.stringify({ type: "tool_use", tool_name: "write_file", parameters: { path: "/tmp/index.ts" } }))).toEqual({ step: "Editing index.ts" })
    expect(parseStreamJsonLine(JSON.stringify({
      type: "message",
      role: "assistant",
      content: "PR ready at https://github.com/jaubut/claude-companion/pull/501",
    }))).toEqual({
      assistantText: "PR ready at https://github.com/jaubut/claude-companion/pull/501",
      prUrl: "https://github.com/jaubut/claude-companion/pull/501",
    })
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

  describe("PR link binding (tasks.dispatch_pr_url)", () => {
    const PR = "https://github.com/jaubut/claude-companion/pull/999"
    const CLAIM = "hc1.0123abcd.turn-1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    function harness(home: string, o: { bind?: boolean | null | (() => Promise<boolean | null>); link?: (t: { taskId: string; prUrl: string | null; status: string }) => Promise<string> } = {}) {
      const spawned: SpawnWorkerOpts[] = []
      const binds: Array<[string, string]> = []
      const bindClaims: string[] = []
      const links: Array<{ taskId: string; prUrl: string | null; status: string }> = []
      const linkClaims: string[] = []
      const terminal: string[] = []
      const seen: unknown[] = [] // every snapshot the supervisor hands out
      let uuidN = 0
      const sup = createWorkerSupervisor({
        host: "zettlab", home, now: () => 1700000000000, uuid: () => `eeee1111-2222-4333-8444-55555555555${uuidN++ % 10}`,
        trust: () => {}, reportJob: () => {},
        onTaskTerminal: (t) => { seen.push(t); terminal.push(`${t.status}:${t.step}`) },
        syncSession: (t) => { seen.push(t) },
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
      return { sup, spawned, binds, bindClaims, links, linkClaims, terminal, seen, finish }
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
      const h = harness(home, { bind: false })
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

    test("the binding survives a state reload: turn 2 after a restart still links, without binding again", async () => {
      const home = tmpHome()
      try {
        const a = harness(home)
        await a.sup.dispatchTask({ taskId: "bind-5", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        a.spawned[0]!.onExit(1, null)
        const unbound = harness(home, { bind: false })
        await unbound.sup.dispatchTask({ taskId: "bind-6", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        unbound.spawned[0]!.onExit(1, null)
        const file = join(home, ".claude", "state", "companion-worker-tasks.json")
        const saved = JSON.parse(readFileSync(file, "utf8")) as Array<{ taskId: string; prLinkBound?: boolean }>
        expect(saved.find((r) => r.taskId === "bind-6")?.prLinkBound).toBe(false)

        const b = harness(home)
        await b.sup.dispatchTask({ taskId: "bind-5", repo: "claude-companion", prompt: "Retry", claim: CLAIM })
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
        const answers: Array<boolean | null> = [null, true]
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
      const answers = [false, true]
      const h = harness(home, { bind: async () => answers.shift()! })
      try {
        await h.sup.dispatchTask({ taskId: "claim-2", repo: "claude-companion", prompt: "Ship PR" })
        h.spawned[0]!.onExit(1, null)
        const refused = await h.sup.dispatchTask({ taskId: "claim-2", repo: "claude-companion", prompt: "Retry", claim: "hc1.bad" })
        expect(refused.ok && refused.claim).toBe("refused")
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

    test("a claimless follow-up (a phone inject through routes/api.ts) keeps the stored claim and still links", async () => {
      const home = tmpHome()
      const h = harness(home)
      try {
        await h.sup.dispatchTask({ taskId: "claim-3", repo: "claude-companion", prompt: "Ship PR", claim: CLAIM })
        h.spawned[0]!.onExit(1, null)
        // routes/api.ts deliverInject: no claim field at all
        const inject = await h.sup.dispatchTask({ taskId: "claim-3", repo: "claude-companion", title: "T", prompt: "also fix the typo", mode: "auto", family: "claude" })
        expect(inject.ok && inject.claim).toBe("verified")
        expect(h.binds).toHaveLength(1)
        h.finish(1)
        await flush(); await flush()
        expect(h.linkClaims).toEqual([CLAIM])
        const saved = (JSON.parse(readFileSync(join(home, ".claude", "state", "companion-worker-tasks.json"), "utf8")) as Array<{ taskId: string; handoffClaim?: unknown }>)
        expect(saved.find((r) => r.taskId === "claim-3")?.handoffClaim).toBe(CLAIM)
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

    test("every family spawns with no Turso, db or Companion/broker secret, and the claude shim told not to load them", async () => {
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
})
