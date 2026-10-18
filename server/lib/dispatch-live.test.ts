import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { TAKEOVER_OWNER, claimTakeover, finishTakeover, takeoverOwner } from "./dispatch-live"
import type { WriteCtx } from "./dispatch-tasks"
import type { ExecFn, Row, SqlArg } from "./turso"

// Takeover claim / finish on a fake Turso: in-memory bun:sqlite with Turso's
// tasks + agent_activity columns behind the ExecFn seam (same harness as
// routes/orchestrator-live.test.ts).

const turso = new Database(":memory:")
turso.exec(`
  CREATE TABLE notes (id TEXT PRIMARY KEY, folder TEXT, title TEXT, ref_code TEXT, status TEXT, type TEXT, body TEXT, updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_id TEXT DEFAULT '', text TEXT NOT NULL, description TEXT DEFAULT '',
    done INTEGER DEFAULT 0, due_date TEXT DEFAULT '', position INTEGER DEFAULT 0, assignee TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    dispatch_status TEXT, dispatch_run_id TEXT, dispatch_started_at TEXT, dispatch_completed_at TEXT,
    dispatch_blocker TEXT, dispatch_owner TEXT, dispatch_result_ref TEXT, dispatch_pr_url TEXT, last_pm_review TEXT
  );
  CREATE TABLE agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT,
    target_id TEXT, summary TEXT, meta TEXT, ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  return { rows: [], affected: turso.query(sql).run(...args).changes }
}
const ctx: WriteCtx = { exec, cols: { prUrl: true, resultRef: true }, host: "zettlab", channel: null }
const row = (id: string) => turso.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>
const ledger = (id: string) => turso.query("SELECT action, meta FROM agent_activity WHERE target_id = ? ORDER BY id").all(id) as { action: string; meta: string }[]
const NAME = "tko-zettlab-abcd1234"
const SEEN = "2026-10-16 10:00:00"

beforeEach(() => {
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity")
  turso.query(
    "INSERT INTO tasks (id, note_id, text, assignee, dispatch_status, dispatch_blocker, dispatch_owner, updated_at) VALUES ('t1', 'projects/x', 'Fix it', 'agent:builder', 'blocked', 'Which repo? — how-to: RES-AB12', 'zettlab', ?)",
  ).run(SEEN)
})

describe("claimTakeover", () => {
  test("blocked at the seen updated_at → running, owned by the session, blocker cleared, one ledger row", async () => {
    const out = await claimTakeover(ctx, "t1", SEEN, NAME, "tko_run1")
    expect(out.ok).toBe(true)
    expect(row("t1")).toMatchObject({ dispatch_status: "running", dispatch_owner: `${TAKEOVER_OWNER}${NAME}`, dispatch_run_id: "tko_run1", dispatch_blocker: null })
    expect(row("t1").dispatch_started_at).toBeTruthy()
    const l = ledger("t1")
    expect(l.map((r) => r.action)).toEqual(["dispatch:running"])
    expect(JSON.parse(l[0]!.meta)).toMatchObject({ mode: "takeover", op: "claim", session: NAME, from: "blocked", host: "zettlab" })
  })

  test("a moved version (updated_at) or another claim first → refused, nothing written", async () => {
    expect(await claimTakeover(ctx, "t1", "2026-10-16 09:59:59", NAME, "r")).toMatchObject({ ok: false, error: "conflict" })
    expect(row("t1").dispatch_status).toBe("blocked")
    expect((await claimTakeover(ctx, "t1", SEEN, NAME, "r")).ok).toBe(true)
    expect(await claimTakeover(ctx, "t1", SEEN, "tko-mac-abcd1234", "r2")).toMatchObject({ ok: false, error: "running" })
    expect(row("t1").dispatch_owner).toBe(takeoverOwner(NAME))
    expect(ledger("t1")).toHaveLength(1)
    expect(await claimTakeover(ctx, "nope", SEEN, NAME, "r")).toEqual({ ok: false, error: "no_such_task" })
  })
})

describe("finishTakeover", () => {
  test("completed with a PR: once (a second finish is a no-op), owner kept for the audit", async () => {
    await claimTakeover(ctx, "t1", SEEN, NAME, "r")
    const pr = "https://github.com/jaubut/claude-companion/pull/170"
    expect((await finishTakeover(ctx, "t1", NAME, { status: "completed", prUrl: pr })).ok).toBe(true)
    expect(await finishTakeover(ctx, "t1", NAME, { status: "blocked", blocker: "late" })).toMatchObject({ ok: false, error: "conflict" })
    expect(row("t1")).toMatchObject({ dispatch_status: "completed", dispatch_pr_url: pr, dispatch_owner: takeoverOwner(NAME) })
    const l = ledger("t1")
    expect(l.map((r) => r.action)).toEqual(["dispatch:running", "dispatch:completed"])
    expect(JSON.parse(l[1]!.meta)).toMatchObject({ mode: "takeover", op: "finish", session: NAME, pr })
  })

  test("blocked again with the reason; a foreign owner's row is never finished", async () => {
    await claimTakeover(ctx, "t1", SEEN, NAME, "r")
    expect(await finishTakeover(ctx, "t1", "tko-mac-abcd1234", { status: "completed" })).toMatchObject({ ok: false, error: "conflict" })
    expect(row("t1").dispatch_status).toBe("running")
    expect((await finishTakeover(ctx, "t1", NAME, { status: "blocked", blocker: "Takeover ended without a PR — Which repo? — how-to: RES-AB12" })).ok).toBe(true)
    expect(row("t1")).toMatchObject({ dispatch_status: "blocked", dispatch_blocker: "Takeover ended without a PR — Which repo? — how-to: RES-AB12" })
  })
})
