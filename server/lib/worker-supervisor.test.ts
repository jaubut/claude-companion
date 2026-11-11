import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BuilderReport } from "./builder-jobs"
import {
  type SpawnWorkerOpts,
  buildHeadlessClaudeArgs,
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

  test("buildHeadlessClaudeArgs uses --session-id on turn 1 and --resume on follow-up turns", () => {
    expect(buildHeadlessClaudeArgs({
      prompt: "Build feature X",
      sessionId: "uuid-1",
      resume: false,
      mode: "auto",
      agent: "builder",
    })).toEqual([
      "-p",
      "Build feature X",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      "--session-id",
      "uuid-1",
      "--agent",
      "builder",
    ])

    expect(buildHeadlessClaudeArgs({
      prompt: "Fix review finding 1",
      sessionId: "uuid-1",
      resume: true,
      mode: "auto",
    })).toEqual([
      "-p",
      "Fix review finding 1",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "auto",
      "--resume",
      "uuid-1",
    ])
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
          },
        }
      },
    })

    try {
      // Rejects bypassPermissions mode
      const badMode = await sup.dispatchTask({
        taskId: "task-1",
        repo: "claude-companion",
        prompt: "Do work",
        mode: "bypassPermissions",
      })
      expect(badMode).toEqual({ ok: false, status: 400, error: "invalid_mode" })

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
      expect(reports.map((r) => r.event)).toEqual(["task", "progress", "done"])

      // Turn 2 on the same task uses --resume <sessionId>
      const d2 = await sup.dispatchTask({
        taskId: "task-1",
        repo: "claude-companion",
        prompt: "Fix review finding on server/a.ts",
      })
      expect(d2.ok).toBe(true)
      expect(spawned[1]!.args).toContain("--resume")
      expect(spawned[1]!.args).toContain("11111111-2222-4333-8444-555555555555")

      // Interrupt turn 2 with dirty worktree -> worktree kept
      dirtyWorktree = true
      const intDirty = await sup.interruptTask("task-1", { closeWorktree: true })
      expect(intDirty.ok).toBe(true)
      if (!intDirty.ok) return
      expect(intDirty.task.status).toBe("interrupted")
      expect(intDirty.worktreeRemoved).toBe(false)
      expect(intDirty.note).toContain("uncommitted")
      expect(signals).toContain("SIGTERM")

      // Once clean and pushed, closeWorktree removes the worktree
      dirtyWorktree = false
      pushedWorktree = true
      const intClean = await sup.interruptTask("task-1", { closeWorktree: true })
      expect(intClean.ok).toBe(true)
      if (!intClean.ok) return
      expect(intClean.worktreeRemoved).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
