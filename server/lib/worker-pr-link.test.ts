import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backfill } from "../../scripts/backfill-worker-pr-links"
import { installHranaStub } from "./hrana-stub.test-util"
import type { GhFn } from "./triage-pr"
import { type SqlArg, tursoExec } from "./turso"
import { openTestDb, schemaDb, testDbConfigured } from "./turso-test-db.test-util"
import { linkWorkerPr } from "./worker-pr-link"

// linkWorkerPr (worker PR ready → tasks.dispatch_pr_url) and the backfill script, with the production tursoExec.
// Default: the Hrana stub over bun:sqlite on production's schema; with TURSO_TEST_URL + TURSO_TEST_AUTH_TOKEN, tls-test.

const REAL = testDbConfigured()
let run: Awaited<ReturnType<typeof openTestDb>> | undefined
let restore: () => void = () => {}
let NOTE = "projects/x"
let ID = ""

beforeAll(async () => {
  if (!REAL) return
  run = await openTestDb()
  NOTE = run.note
}, 60_000)
afterAll(() => run?.close())
beforeEach(async () => {
  ID = randomUUID().replace(/-/g, "")
  if (REAL) return
  restore = installHranaStub(schemaDb()).restore
  await sql("INSERT INTO notes (id, folder, filename, title) VALUES (?, 'projects', 'x.md', 'X')", [NOTE])
})
afterEach(() => restore())

const sql = (s: string, args: SqlArg[] = []) => tursoExec(s, args)
const seed = (id: string, pr: string | null = null) =>
  sql("INSERT INTO tasks (id, note_id, text, assignee, dispatch_status, dispatch_pr_url) VALUES (?, ?, 't', 'agent:builder', 'running', ?)", [id, NOTE, pr])
const prOf = async (id: string) => (await sql("SELECT dispatch_pr_url FROM tasks WHERE id = ?", [id])).rows[0]?.dispatch_pr_url
const URL = (repo = "tls-dashboard-v2", n = 423) => `https://github.com/jaubut/${repo}/pull/${n}`

function fakeGh(head: (n: string) => string, opts: { cross?: boolean; open?: string[] } = {}) {
  const calls: string[][] = []
  const gh: GhFn = async (args) => {
    calls.push(args)
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify((opts.open ?? []).map((url) => ({ url }))), stderr: "" }
    return { code: 0, stdout: JSON.stringify({ headRefName: head(args[2]!), isCrossRepository: opts.cross ?? false }), stderr: "" }
  }
  return { gh, calls }
}

describe("linkWorkerPr", () => {
  test("links on PR ready", async () => {
    await seed(ID)
    const { gh, calls } = fakeGh(() => `dispatch/${ID}`)
    expect(await linkWorkerPr({ gh, exec: tursoExec }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("linked")
    expect(await prOf(ID)).toBe(URL())
    expect(calls[0]).toEqual(["pr", "view", "423", "--repo", "jaubut/tls-dashboard-v2", "--json", "headRefName,isCrossRepository"])
  })

  test("refuses a mismatched repo without asking GitHub", async () => {
    await seed(ID)
    const { gh, calls } = fakeGh(() => `dispatch/${ID}`)
    expect(await linkWorkerPr({ gh, exec: tursoExec }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL("claude-config") })).toBe("repo_mismatch")
    expect(await linkWorkerPr({ gh, exec: tursoExec }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: "https://github.com/someone/tls-dashboard-v2/pull/1" })).toBe("bad_url")
    expect(calls).toEqual([])
    expect(await prOf(ID)).toBeNull()
  })

  test("refuses a mismatched branch or a fork head", async () => {
    await seed(ID)
    expect(await linkWorkerPr({ gh: fakeGh(() => "dispatch/other").gh, exec: tursoExec }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("branch_mismatch")
    expect(await linkWorkerPr({ gh: fakeGh(() => `dispatch/${ID}`, { cross: true }).gh, exec: tursoExec }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("branch_mismatch")
    expect(await prOf(ID)).toBeNull()
  })

  test("never overwrites an existing link", async () => {
    await seed(ID, URL("tls-dashboard-v2", 1))
    const { gh } = fakeGh(() => `dispatch/${ID}`)
    expect(await linkWorkerPr({ gh, exec: tursoExec }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("not_linked")
    expect(await prOf(ID)).toBe(URL("tls-dashboard-v2", 1))
  })

  test("a gh failure is an outcome, not a throw", async () => {
    await seed(ID)
    const gh: GhFn = async () => { throw new Error("gh down") }
    expect(await linkWorkerPr({ gh, exec: tursoExec }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("gh_failed")
    expect(await prOf(ID)).toBeNull()
  })
})

describe("backfill script", () => {
  function stateFile(records: unknown[]): string {
    const f = join(mkdtempSync(join(tmpdir(), "cc-prlink-")), "tasks.json")
    writeFileSync(f, JSON.stringify(records))
    return f
  }

  test("dry-run writes nothing, --apply links through the same check", async () => {
    await seed(ID)
    const linked = `${ID.slice(0, 31)}x`
    await seed(linked, URL("tls-dashboard-v2", 1))
    const file = stateFile([{ taskId: ID, repo: "tls-dashboard-v2" }, { taskId: linked, repo: "tls-dashboard-v2" }])
    const { gh, calls } = fakeGh(() => `dispatch/${ID}`, { open: [URL()] })
    const lines: string[] = []

    expect(await backfill({ gh, exec: tursoExec, log: (l) => lines.push(l) }, file, false)).toEqual([{ taskId: ID, repo: "tls-dashboard-v2", prUrl: URL(), outcome: "would_link" }])
    expect(await prOf(ID)).toBeNull()
    expect(calls.filter((c) => c[1] === "list")).toHaveLength(1)

    expect((await backfill({ gh, exec: tursoExec, log: (l) => lines.push(l) }, file, true))[0]!.outcome).toBe("linked")
    expect(await prOf(ID)).toBe(URL())
    expect(await prOf(linked)).toBe(URL("tls-dashboard-v2", 1))
  })
})
