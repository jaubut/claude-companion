import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GhFn, GhResult } from "../lib/triage-pr"
import type { ExecFn, Row } from "../lib/turso"

// bin/pr-unpark gate (wiring/brain-pr-unpark.ts): every refusal and the ledger
// row, gh faked at the process boundary, Turso a real sqlite with the prod columns.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-prunpark-")), "test.db")
const { unparkAgentPr, UNPARK_CAP } = await import("./brain-pr-unpark")

const URL = "https://github.com/o/r/pull/7"
const SHA = "1111111111111111111111111111111111111111"
const TASK = `INSERT INTO tasks (id, origin, dispatch_pr_url) VALUES ('abcd1234-0000', 'jeremie', '${URL}');`
const row = (slug: string, action: string, meta: Record<string, unknown>) =>
  `INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, meta) VALUES ('${slug}', '${action}', 'task', 'abcd1234-0000', '${JSON.stringify(meta)}');`
const park = (reason = "review verdict CHANGES after 2 fix runs — see the reviewer summary") => row("pr-shepherd", "pr:needs-human", { url: URL, reason })
const brainUnpark = () => row("brain", "pr:unpark", { url: URL, reason: "r", guidance: "g", source: "brain" })

function pr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: "OPEN", headRefName: "dispatch/abcd1234", headRefOid: SHA, url: URL, title: "feed: wrap long titles", labels: [], ...over }
}

function world(view: Record<string, unknown>, seed: string) {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, origin TEXT, done INTEGER DEFAULT 0, dispatch_status TEXT, dispatch_pr_url TEXT);
    CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')));
    ${seed}
  `)
  const exec: ExecFn = async (sql, args) => /^\s*SELECT/i.test(sql)
    ? { rows: db.query(sql).all(...args) as Row[], affected: 0 }
    : { rows: [], affected: db.query(sql).run(...args).changes }
  const events: string[] = []
  const gh: GhFn = async (args): Promise<GhResult> =>
    args[0] === "pr" && args[1] === "view" ? { code: 0, stdout: JSON.stringify(view), stderr: "" } : { code: 1, stdout: "", stderr: "unexpected" }
  return { db, events, deps: { gh, exec, event: (t: string) => events.push(t) } }
}

const input = { repo: "o/r", pr: 7, reason: "the reviewer's finding is a one-line fix", guidance: "In server/lib/feed-format.ts:42, clamp the title to 120 chars before wrapping." }
const unparks = (db: Database) => db.query("SELECT * FROM agent_activity WHERE action = 'pr:unpark' AND agent_slug = 'brain' ORDER BY id").all() as Row[]

async function refused(view: Record<string, unknown>, seed: string) {
  const w = world(view, seed)
  const before = unparks(w.db).length
  const out = await unparkAgentPr(input, w.deps)
  expect(unparks(w.db)).toHaveLength(before)
  expect(w.events).toHaveLength(0)
  return [out.status, out.body.error]
}

describe("bin/pr-unpark gate: refusals", () => {
  for (const branch of ["deps/rolling", "agent/chores", "jeremie/feature", "main", "dispatch/../main"]) {
    test(`403 not_agent_branch on ${branch}`, async () => {
      expect(await refused(pr({ headRefName: branch }), `${TASK} ${park()}`)).toEqual([403, "not_agent_branch"])
    })
  }

  test("409 not_open on a merged PR", async () => {
    expect(await refused(pr({ state: "MERGED" }), `${TASK} ${park()}`)).toEqual([409, "not_open"])
  })

  const notParked: Array<[string, string]> = [
    ["never parked", TASK],
    ["parked, then unparked", `${TASK} ${park()} ${row("pr-shepherd", "pr:unpark", { url: URL, reason: "gates fixed", category: "dep-review" })}`],
    ["parked, then approved by Jeremie", `${TASK} ${park()} ${row("companion", "pr:approved-merge", { url: URL })}`],
    ["a park for another PR", `${TASK} ${row("pr-shepherd", "pr:needs-human", { url: "https://github.com/o/r/pull/8", reason: "x" })}`],
    ["only a cascade hold", `${TASK} ${row("pr-shepherd", "pr:hold", { url: URL })}`],
  ]
  for (const [what, seed] of notParked) {
    test(`409 not_parked: ${what}`, async () => {
      expect(await refused(pr(), seed)).toEqual([409, "not_parked"])
    })
  }

  test("409 label_park: a do-not-merge or wip label on a parked PR", async () => {
    expect(await refused(pr({ labels: [{ name: "do-not-merge" }] }), `${TASK} ${park()}`)).toEqual([409, "label_park"])
    expect(await refused(pr({ labels: [{ name: "WIP" }] }), `${TASK} ${park()}`)).toEqual([409, "label_park"])
  })

  test("409 label_park: the park reason names the label", async () => {
    expect(await refused(pr(), `${TASK} ${park("label do-not-merge")}`)).toEqual([409, "label_park"])
  })

  test(`429 unpark_cap after ${UNPARK_CAP} brain unparks of this PR`, async () => {
    const seed = `${TASK} ${park()} ${brainUnpark()} ${park()} ${brainUnpark()} ${park()}`
    expect(await refused(pr(), seed)).toEqual([429, "unpark_cap"])
  })
})

describe("bin/pr-unpark gate: the hand-back", () => {
  test("200 writes one pr:unpark row with source brain, the reason and the guidance; one brain-thread event", async () => {
    const w = world(pr(), `${TASK} ${park()}`)
    const out = await unparkAgentPr(input, w.deps)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, unparked: true, url: URL, unparks: 1, cap: UNPARK_CAP })
    const rows = unparks(w.db)
    expect(rows).toHaveLength(1)
    expect([rows[0]!.target_kind, rows[0]!.target_id]).toEqual(["task", "abcd1234-0000"])
    const meta = JSON.parse(String(rows[0]!.meta)) as Record<string, unknown>
    expect(meta).toMatchObject({ url: URL, source: "brain", reason: input.reason, guidance: input.guidance, head_sha: SHA, unpark_no: 1 })
    // No `by`/`category`: the shepherd's unparkResets() treats it as a hand unpark (fix budget resets).
    expect(meta.by).toBeUndefined()
    expect(meta.category).toBeUndefined()
    expect(w.events).toHaveLength(1)
    expect(w.events[0]).toContain("o/r#7")
    expect(w.events[0]).toContain(input.guidance)
  })

  test("a shepherd unpark does not count toward the brain's cap; the second brain unpark is allowed", async () => {
    const seed = `${TASK} ${park()} ${row("pr-shepherd", "pr:unpark", { url: URL, reason: "gates fixed", category: "no-checks" })} ${park()} ${brainUnpark()} ${park()}`
    const w = world(pr(), seed)
    const out = await unparkAgentPr(input, w.deps)
    expect([out.status, out.body.unparks]).toEqual([200, 2])
  })

  test("an orphan PR (no task) targets the PR url", async () => {
    const w = world(pr(), park())
    expect((await unparkAgentPr(input, w.deps)).status).toBe(200)
    expect([unparks(w.db)[0]!.target_kind, unparks(w.db)[0]!.target_id]).toEqual(["pr", URL])
  })

  test("SQL is parameterized: quotes in the guidance land verbatim", async () => {
    const w = world(pr(), `${TASK} ${park()}`)
    const guidance = `it's "fine'); DROP TABLE tasks; --`
    expect((await unparkAgentPr({ ...input, guidance }, w.deps)).status).toBe(200)
    expect((JSON.parse(String(unparks(w.db)[0]!.meta)) as Record<string, unknown>).guidance).toBe(guidance)
    expect(w.db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 })
  })
})
