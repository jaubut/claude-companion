import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pruneGoneSessions } from "./session-prune-gone"
import { type Session, getSessionByKey, onSessions, recordSession, removeSessionByKey } from "./sessions"
import { createWorkerSupervisor } from "./worker-supervisor"

const dirs: string[] = []
const keys: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const k of keys.splice(0)) removeSessionByKey(k)
})

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "prune-gone-"))
  dirs.push(d)
  return d
}

// Same shape as wiring/worker-mcp.ts syncSession: headless pane, server pid when the worker has exited.
function recordWorker(taskId: string, cwd: string, sid: string): Session {
  const s = recordSession({
    cwd, agent: "claude", sessionId: sid, label: `repo · ${taskId}`, taskId,
    herdrPane: `headless:worker:${taskId}`, agentStatus: "idle", pid: String(process.pid),
  }, { sessionIdConfirmed: true })!
  keys.push(s.key)
  return s
}

describe("pruneGoneSessions", () => {
  test("a finished worker leaves the live list even while its worktree stays; clients get the removal", () => {
    const wt = join(tmp(), "wt")
    mkdirSync(wt)
    const s = recordWorker("task-close", wt, "aaaaaaaa-0000-4000-8000-000000000001")
    pruneGoneSessions((id) => id === "task-close") // still running: stays
    expect(getSessionByKey(s.key)).not.toBeNull()

    const pushed: Session[][] = []
    const off = onSessions((list) => pushed.push(list))
    try {
      expect(pruneGoneSessions(() => false)).toBeGreaterThanOrEqual(1)
    } finally { off() }
    expect(getSessionByKey(s.key)).toBeNull()
    expect(pushed.length).toBeGreaterThan(0)
    expect(pushed.at(-1)!.some((x) => x.key === s.key)).toBe(false)
  })

  test("keeps a running worker and the brain even when their cwd is missing", () => {
    const gone = join(tmp(), "missing")
    const worker = recordWorker("task-run", gone, "aaaaaaaa-0000-4000-8000-000000000002")
    const brain = recordSession({
      cwd: join(gone, "brain"), agent: "claude", sessionId: "aaaaaaaa-0000-4000-8000-000000000003",
      label: "brain", taskId: "brain", herdrPane: "headless:brain", pid: String(process.pid),
    }, { sessionIdConfirmed: true })!
    keys.push(brain.key)
    pruneGoneSessions((id) => id === "task-run")
    expect(getSessionByKey(worker.key)).not.toBeNull()
    expect(getSessionByKey(brain.key)).not.toBeNull()
  })

  test("restart: finished workers the supervisor reloads (worktree removed or not), and rehydrated leftovers, are pruned", () => {
    const home = tmp()
    const stateFile = join(home, "tasks.json")
    const wtGone = join(home, "apps", "wt", "repo", "task-old")
    const wtLive = join(home, "apps", "wt", "repo", "task-live")
    mkdirSync(wtLive, { recursive: true })
    const rec = (taskId: string, worktree: string, sessionId: string) => ({
      taskId, repo: "repo", repoDir: join(home, "repo"), title: taskId, builder: "b", family: "claude", model: null,
      branch: `dispatch/${taskId}`, worktree, sessionId, status: "completed", turnCount: 1, step: null, pct: 100,
      result: "", prUrl: null, error: null, startedAt: 1, updatedAt: 1, completedAt: 1, pid: null, pidIdentity: null, sessionStarted: true,
    })
    writeFileSync(stateFile, JSON.stringify([
      rec("task-old", wtGone, "aaaaaaaa-0000-4000-8000-000000000004"),
      rec("task-live", wtLive, "aaaaaaaa-0000-4000-8000-000000000005"),
    ]))
    const sup = createWorkerSupervisor({
      host: "test", home, stateFile, now: () => 1, uuid: () => "u", trust: () => {}, reportJob: () => {},
      sh: async () => ({ ok: true, out: "", err: "", code: 0 }),
      syncSession: (t) => { recordWorker(t.taskId, t.worktree, t.sessionId) },
    })
    // Rehydrate re-adds a recent transcript of a finished worker: no pid, no pane.
    const rehydrated = recordSession({ cwd: join(home, "apps", "wt", "repo", "task-gone2"), sessionId: "aaaaaaaa-0000-4000-8000-000000000006" }, { provisional: true, sessionIdConfirmed: true })!
    keys.push(rehydrated.key)
    const old = keys[0]!, live = keys[1]!
    expect(getSessionByKey(old)).not.toBeNull()

    pruneGoneSessions((id) => sup.getTask(id)?.status === "running")
    expect(getSessionByKey(old)).toBeNull()
    expect(getSessionByKey(rehydrated.key)).toBeNull()
    expect(getSessionByKey(live)).toBeNull() // finished, worktree still on disk: out of the drawer all the same
  })
})
