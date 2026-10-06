import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installHranaStub } from "./hrana-stub.test-util"
import { createTasksAgent } from "./tasks-agent"
import { createTasksAgentStore } from "./tasks-agent-store"
import { parseAssignRules } from "./tasks-agent-rules"
import { testDb } from "./tasks-agent-testdb.test-util"
import { TursoUnreachable, tursoExec, tursoQuery, tursoTx } from "./turso"
import { Database } from "bun:sqlite"

// The production transaction path: turso.ts's real Hrana batch building (BEGIN / conditional steps / COMMIT / ROLLBACK)
// and response parsing, over a stubbed HTTP transport with real SQL underneath (hrana-stub.test-util.ts), plus the
// Tasks agent's guarded writes running on it (tursoQuery / tursoExec / tursoTx instead of the test-only txOver).

const savedToken = process.env.TURSO_AUTH_TOKEN
let restore: () => void = () => {}
beforeEach(() => { process.env.TURSO_AUTH_TOKEN = "test-token" })
afterEach(() => {
  restore()
  if (savedToken === undefined) delete process.env.TURSO_AUTH_TOKEN
  else process.env.TURSO_AUTH_TOKEN = savedToken
})

function kv(): Database {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)")
  return db
}
const rows = (db: Database) => db.query("SELECT k, v FROM kv ORDER BY k").all()
const ins = (k: string, v: string) => ({ sql: "INSERT INTO kv (k, v) VALUES (?, ?) RETURNING k", args: [k, v] })

describe("tursoTx over the Hrana pipeline", () => {
  test("request: BEGIN, each statement only if the previous one ran, COMMIT only after the last, ROLLBACK unless COMMIT ran", async () => {
    const db = kv()
    const stub = installHranaStub(db); restore = stub.restore
    await tursoTx([ins("a", "1"), ins("b", "2")])
    const steps = (stub.requests[0] as any).requests[0].batch.steps
    expect(steps.map((s: any) => [s.stmt.sql.split(" ")[0], s.condition])).toEqual([
      ["BEGIN", undefined],
      ["INSERT", { type: "ok", step: 0 }],
      ["INSERT", { type: "ok", step: 1 }],
      ["COMMIT", { type: "ok", step: 2 }],
      ["ROLLBACK", { type: "not", cond: { type: "ok", step: 3 } }],
    ])
  })

  test("success: every statement's rows and affected count come back, and both rows are committed", async () => {
    const db = kv()
    const stub = installHranaStub(db); restore = stub.restore
    const out = await tursoTx([ins("a", "1"), ins("b", "2"), { sql: "UPDATE kv SET v = ? WHERE k = ?", args: ["9", "a"] }])
    expect(out).toEqual([{ rows: [{ k: "a" }], affected: 1 }, { rows: [{ k: "b" }], affected: 1 }, { rows: [], affected: 1 }])
    expect(rows(db)).toEqual([{ k: "a", v: "9" }, { k: "b", v: "2" }])
    expect(stub.trace.at(-1)).toBe("COMMIT")
  })

  test("a statement failing mid-batch: later steps are skipped, ROLLBACK runs, nothing is committed, TursoUnreachable", async () => {
    const db = kv()
    db.query("INSERT INTO kv VALUES ('b', 'old')").run()
    const stub = installHranaStub(db); restore = stub.restore
    const err = await tursoTx([ins("a", "1"), ins("b", "dup"), ins("c", "3")]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TursoUnreachable)
    expect((err as Error).message).toBe("turso unreachable: transaction failed")
    expect(rows(db)).toEqual([{ k: "b", v: "old" }])
    // BEGIN, a ok, b failed, c and COMMIT skipped, ROLLBACK ran.
    expect(stub.trace.map((x) => x.split(" ")[0])).toEqual(["BEGIN", "INSERT", "!INSERT", "ROLLBACK"])
  })

  test("a COMMIT failure: ROLLBACK runs, nothing is committed, TursoUnreachable", async () => {
    const db = kv()
    const stub = installHranaStub(db, { failOn: (sql) => sql === "COMMIT" }); restore = stub.restore
    await expect(tursoTx([ins("a", "1"), ins("b", "2")])).rejects.toBeInstanceOf(TursoUnreachable)
    expect(rows(db)).toEqual([])
    expect(stub.trace.slice(-2)).toEqual(["!COMMIT", "ROLLBACK"])
  })

  test("a partial or skipped answer (null step results, even without step_errors) is never read as success", async () => {
    const db = kv()
    const stub = installHranaStub(db, {
      rewriteBatch: (b: any) => { b.results[0].response.result.step_results[2] = null; b.results[0].response.result.step_errors = []; return b },
    }); restore = stub.restore
    await expect(tursoTx([ins("a", "1"), ins("b", "2")])).rejects.toBeInstanceOf(TursoUnreachable)
    const empty = installHranaStub(db, { rewriteBatch: () => ({ results: [{ type: "error", error: { message: "x" } }] }) })
    restore = () => { empty.restore(); stub.restore() } // stubs nest: unwind both
    await expect(tursoTx([ins("c", "3")])).rejects.toBeInstanceOf(TursoUnreachable)
  })

  test("HTTP errors are TursoUnreachable with no SQL in the message", async () => {
    const stub = installHranaStub(kv(), { status: 502 }); restore = stub.restore
    const err = await tursoTx([ins("a", "1")]).catch((e: unknown) => e)
    expect((err as Error).message).toBe("turso unreachable: http 502")
  })
})

describe("Tasks agent guarded writes on the real transaction path", () => {
  const A = "aaaaaaaaaa"
  const RULES = parseAssignRules('ROUTES = [\n    (r"\\\\b(design|wireframe)\\\\b", "frontend-design"),\n]\n')
  const NOW = Date.parse("2026-10-06T15:00:00Z")

  function setup(o: Parameters<typeof installHranaStub>[1] = {}) {
    const t = testDb()
    const stub = installHranaStub(t.db, o); restore = stub.restore
    const agent = createTasksAgent({
      query: tursoQuery, exec: tursoExec, tx: tursoTx, store: createTasksAgentStore(new Database(":memory:")), rules: () => RULES, now: () => NOW,
      busy: async () => null, splitter: async () => null,
    })
    t.task({ id: A, due_date: "2026-10-01" })
    t.activity({ agent: "companion", action: "due_changed", target: A, meta: { from: "2026-09-10", to: "2026-09-20" } })
    t.activity({ agent: "companion", action: "due_changed", target: A, meta: { from: "2026-09-20", to: "2026-10-01" } })
    const ours = () => t.activities().filter((a) => a.agent_slug === "tasks-agent")
    return { t, stub, agent, ours }
  }

  test("commit: the task change and its activity row land together", async () => {
    const s = setup()
    expect(await s.agent.decide(`slip:${A}`, "accept", {})).toMatchObject({ ok: true })
    expect(s.t.get(A)!.due_date).toBe("2026-10-13")
    expect(s.ours().length).toBe(1)
    expect(s.stub.trace.filter((x) => /^(BEGIN|COMMIT|ROLLBACK)/.test(x))).toEqual(["BEGIN", "COMMIT"])
  })

  test("0 rows affected by the guarded UPDATE (a concurrent edit) → 409 changed_since, no activity row, task untouched", async () => {
    let fired = false
    const s = setup({ onRequest: (kind, sqls) => {
      // The concurrent edit lands just before our batch runs (after the agent's read).
      if (kind === "batch" && !fired) { fired = true; s.t.db.query("UPDATE tasks SET description = 'edited meanwhile' WHERE id = ?").run(A) }
      void sqls
    } })
    expect(await s.agent.decide(`slip:${A}`, "accept", {})).toEqual({ ok: false, status: 409, error: "changed_since" })
    expect(s.t.get(A)!.due_date).toBe("2026-10-01")
    expect(s.ours().length).toBe(0)
    expect(s.stub.trace.filter((x) => /^(BEGIN|COMMIT|ROLLBACK)/.test(x))).toEqual(["BEGIN", "COMMIT"]) // an empty, harmless commit
  })

  test("a client version that no longer matches the row → 409 stale before any write is sent", async () => {
    const s = setup()
    const batches = () => s.stub.requests.filter((r: any) => r.requests[0].type === "batch").length
    expect(await s.agent.decide(`slip:${A}`, "accept", { rowVersions: { [A]: "0000000000000000" } })).toMatchObject({ ok: false, status: 409, error: "stale" })
    expect(batches()).toBe(0)
    expect(s.t.get(A)!.due_date).toBe("2026-10-01")
  })

  test("the activity INSERT failing on the wire rolls the task change back (no log, no mutation)", async () => {
    const s = setup({ failOn: (sql) => sql.startsWith("INSERT INTO agent_activity") })
    await expect(s.agent.decide(`slip:${A}`, "accept", {})).rejects.toBeInstanceOf(TursoUnreachable)
    expect(s.t.get(A)!.due_date).toBe("2026-10-01")
    expect(s.ours().length).toBe(0)
    expect(s.stub.trace.at(-1)).toBe("ROLLBACK")
  })

  test("a COMMIT failure on the wire leaves the task untouched and the retry works", async () => {
    let fail = true
    const s = setup({ failOn: (sql) => { if (sql === "COMMIT" && fail) { fail = false; return true } return false } })
    await expect(s.agent.decide(`slip:${A}`, "accept", {})).rejects.toBeInstanceOf(TursoUnreachable)
    expect(s.t.get(A)!.due_date).toBe("2026-10-01")
    expect(s.ours().length).toBe(0)
    expect(await s.agent.decide(`slip:${A}`, "accept", {})).toMatchObject({ ok: true })
    expect(s.ours().length).toBe(1)
  })
})
