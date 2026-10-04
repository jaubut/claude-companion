import { describe, expect, test } from "bun:test"
import {
  type DispatchTask,
  detectColumns,
  dispatchToDto,
  effectiveStatus,
  fromRow,
  getDispatchTask,
  getTaskResult,
  legacyStatus,
  listDispatchTasks,
  listProjects,
  parseTs,
  phaseOf,
  resolveAgent,
  toTaskDto,
  unblockMarker,
} from "./dispatch-tasks"
import type { Task } from "./orchestrator-chat"
import type { QueryFn, Row, SqlArg } from "./turso"

// Pure mapping + the read queries against a fake QueryFn (no network).

function recorder(rows: (sql: string, args: SqlArg[]) => Row[]) {
  const calls: { sql: string; args: SqlArg[] }[] = []
  const query: QueryFn = async (sql, args) => { calls.push({ sql, args }); return rows(sql, args) }
  return { calls, query }
}

const row = (over: Row = {}): Row => ({
  id: "a".repeat(32), note_id: "projects/2026-01-01-dash", text: "Fix the tax rounding", assignee: "agent:builder",
  done: 0, created_at: "2026-10-01 10:00:00", updated_at: "2026-10-03 12:00:00",
  dispatch_status: "queued", dispatch_blocker: null, dispatch_owner: null,
  note_title: "TLS Dashboard", note_ref: "PRJ-WCLS", ...over,
})

describe("status mapping", () => {
  test("legacy status per Turso state", () => {
    expect(legacyStatus("queued")).toBe("queued")
    expect(legacyStatus("running")).toBe("running")
    expect(legacyStatus("completed")).toBe("done")
    expect(legacyStatus("pr")).toBe("done")
    expect(legacyStatus("blocked")).toBe("error")
    expect(legacyStatus("failed")).toBe("error")
    expect(legacyStatus("cancelled")).toBe("cancelled")
    expect(legacyStatus(null)).toBe("queued")
  })

  test("pr = completed with a PR URL; unknown states read as null", () => {
    expect(effectiveStatus(fromRow(row({ dispatch_status: "completed", dispatch_pr_url: "https://github.com/x/y/pull/1" })))).toBe("pr")
    expect(effectiveStatus(fromRow(row({ dispatch_status: "completed" })))).toBe("completed")
    expect(fromRow(row({ dispatch_status: "weird" })).status).toBeNull()
  })

  test("phase: done outranks state, except cancelled", () => {
    expect(phaseOf(fromRow(row({ dispatch_status: "completed", done: 1 })))).toBe("done")
    expect(phaseOf(fromRow(row({ dispatch_status: "cancelled", done: 1 })))).toBe("cancelled")
    expect(phaseOf(fromRow(row({ dispatch_status: "blocked" })))).toBe("blocked")
  })

  test("Turso datetime text parses as UTC", () => {
    expect(parseTs("2026-10-03 12:00:00")).toBe(Date.UTC(2026, 9, 3, 12))
    expect(parseTs("2026-10-03T12:00:00.000Z")).toBe(Date.UTC(2026, 9, 3, 12))
    expect(parseTs(null)).toBe(0)
    expect(parseTs("garbage")).toBe(0)
  })
})

describe("DTO", () => {
  test("dispatch task → DTO with additive fields and display cwd", () => {
    const t = fromRow(row({
      dispatch_status: "completed", dispatch_blocker: "review: APPROVE", dispatch_owner: "zettlab",
      dispatch_pr_url: "https://github.com/x/y/pull/7", dispatch_result_ref: "RES-AB12",
    }))
    const dto = dispatchToDto(t, "tls-dashboard")
    expect(dto).toMatchObject({
      taskId: "a".repeat(32), threadId: "tls-dashboard", prompt: "Fix the tax rounding", cwd: "TLS Dashboard",
      status: "done", source: "dispatch", dispatchStatus: "pr", agent: "builder", noteId: "projects/2026-01-01-dash",
      projectTitle: "TLS Dashboard", prUrl: "https://github.com/x/y/pull/7", resultRef: "RES-AB12",
      logTail: "PR https://github.com/x/y/pull/7 · review: APPROVE", blocker: null, done: false, owner: "zettlab", mode: "headless",
      createdAt: Date.UTC(2026, 9, 1, 10), updatedAt: Date.UTC(2026, 9, 3, 12),
    })
  })

  test("blocker only for blocked/failed; companion owner = live", () => {
    const b = dispatchToDto(fromRow(row({ dispatch_status: "blocked", dispatch_blocker: "no repo mapped", dispatch_owner: "companion:mac" })), "general")
    expect(b).toMatchObject({ status: "error", blocker: "no repo mapped", mode: "live", logTail: null })
  })

  test("local task keeps every legacy field and adds source/mode", () => {
    const t: Task = {
      taskId: "abcd1234", threadId: "general", prompt: "p", cwd: "/x", sessionKey: null, tmuxSession: "cc-x",
      tmuxSocket: "/tmp/s", reasoning: "why", logTail: null, status: "proposed", createdAt: 1, updatedAt: 2,
    }
    expect(toTaskDto(t)).toMatchObject({ ...t, source: "proposal", dispatchStatus: null, done: false, mode: "live" })
    expect(toTaskDto({ ...t, status: "done" })).toMatchObject({ source: "local", done: true })
  })
})

describe("reads", () => {
  test("column detection reads pragma_table_info", async () => {
    const { query } = recorder(() => [{ name: "id" }, { name: "dispatch_pr_url" }])
    expect(await detectColumns(query)).toEqual({ prUrl: true, resultRef: false })
  })

  test("poll query selects the optional columns only when they exist, parameterized", async () => {
    const { calls, query } = recorder(() => [row()])
    const absent = await listDispatchTasks(query, { prUrl: false, resultRef: false })
    expect(absent[0]!.prUrl).toBeNull()
    expect(calls[0]!.sql).not.toContain("dispatch_pr_url")
    expect(calls[0]!.sql).not.toContain("dispatch_result_ref")
    expect(calls[0]!.args).toEqual(["-7 days", 300])
    await listDispatchTasks(query, { prUrl: true, resultRef: true })
    expect(calls[1]!.sql).toContain("t.dispatch_pr_url")
    expect(calls[1]!.sql).toContain("t.dispatch_result_ref")
  })

  test("getDispatchTask returns description, null when absent", async () => {
    const { query } = recorder((_sql, args) => (args[0] === "x" ? [] : [row({ description: "full spec" })]))
    expect(await getDispatchTask(query, { prUrl: false, resultRef: false }, "x")).toBeNull()
    const found = await getDispatchTask(query, { prUrl: false, resultRef: false }, "a".repeat(32))
    expect(found?.description).toBe("full spec")
  })

  test("result note by ref, else by the banner naming the task; excerpt capped", async () => {
    const { calls, query } = recorder(() => [{ ref_code: "RES-AB12", title: "[dispatch:pr] builder", body: "x".repeat(5000) }])
    const withRef: DispatchTask = { ...fromRow(row()), resultRef: "RES-AB12" }
    const r = await getTaskResult(query, withRef)
    expect(r).toMatchObject({ ref: "RES-AB12" })
    expect(r!.excerpt.length).toBe(4000)
    expect(calls[0]!.args).toEqual(["RES-AB12"])
    await getTaskResult(query, fromRow(row()))
    expect(calls[1]!.sql).toContain("type = 'dispatch-result'")
    expect(calls[1]!.args).toEqual([`%from task \`${"a".repeat(32)}\`%`])
  })

  test("projects carry their open agent-task count", async () => {
    const { query } = recorder(() => [{ id: "projects/x", ref_code: "PRJ-X", title: "X", open_tasks: 3 }])
    expect(await listProjects(query)).toEqual([{ noteId: "projects/x", ref: "PRJ-X", title: "X", openAgentTasks: 3 }])
  })
})

describe("write helpers (P2)", () => {
  const allow = new Set(["builder", "claude", "researcher"])
  test("resolveAgent strips agent: prefixes, de-aliases, and refuses anything off the allowlist", () => {
    expect(resolveAgent("agent:agent:Builder", allow)).toBe("builder")
    expect(resolveAgent("frontend-design", allow)).toBe("builder")
    expect(resolveAgent("seo-audit", allow)).toBe("claude")
    expect(resolveAgent("researcher", allow)).toBe("researcher")
    expect(resolveAgent("rm -rf", allow)).toBeNull()
    expect(resolveAgent("ghost", allow)).toBeNull()
    expect(resolveAgent("", allow)).toBeNull()
    expect(resolveAgent(null, allow)).toBeNull()
  })

  test("unblockMarker: blank line, dated UTC marker, trimmed answer", () => {
    expect(unblockMarker("  use repo X \n", Date.parse("2026-10-03T23:30:00Z"))).toBe("\n\n[unblock 2026-10-03] use repo X")
  })

  test("toTaskDto: a filed proposal keeps its Turso id, note and agent", () => {
    const t: Task = {
      taskId: "abcd1234", threadId: "general", prompt: "p", cwd: "", sessionKey: null, tmuxSession: null, reasoning: "why",
      logTail: null, status: "filed", createdAt: 1, updatedAt: 2, noteId: "projects/x", agent: "builder", dispatchTaskId: "f".repeat(32),
    }
    expect(toTaskDto(t)).toMatchObject({ source: "proposal", noteId: "projects/x", agent: "builder", dispatchTaskId: "f".repeat(32), done: false })
  })
})
