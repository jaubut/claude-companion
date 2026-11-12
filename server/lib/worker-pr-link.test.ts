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
// A bin/worker row as the brain files it (fileHandoff): handoff assignee, no dispatch state, not done.
interface Row { pr?: string | null; assignee?: string; status?: string | null; owner?: string | null; done?: number }
const seed = (id: string, r: Row | string | null = {}) => {
  const o: Row = typeof r === "object" && r !== null ? r : { pr: r }
  return sql("INSERT INTO tasks (id, note_id, text, done, assignee, dispatch_status, dispatch_owner, dispatch_pr_url, origin) VALUES (?, ?, 't', ?, ?, ?, ?, ?, 'jeremie')",
    [id, NOTE, o.done ?? 0, o.assignee ?? "handoff", o.status ?? null, o.owner ?? null, o.pr ?? null])
}
const prOf = async (id: string) => (await sql("SELECT dispatch_pr_url FROM tasks WHERE id = ?", [id])).rows[0]?.dispatch_pr_url
const URL = (repo = "tls-dashboard-v2", n = 423) => `https://github.com/jaubut/${repo}/pull/${n}`

const noSleep = async () => {}
function fakeGh(head: (n: string) => string, opts: { cross?: boolean; open?: string[]; url?: string; fail?: number } = {}) {
  let fails = opts.fail ?? 0
  const calls: string[][] = []
  const gh: GhFn = async (args) => {
    calls.push(args)
    if (fails > 0) { fails--; return { code: 1, stdout: "", stderr: "HTTP 502" } }
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify((opts.open ?? []).map((url) => ({ url }))), stderr: "" }
    return { code: 0, stdout: JSON.stringify({ headRefName: head(args[2]!), isCrossRepository: opts.cross ?? false, url: opts.url ?? URL("tls-dashboard-v2", Number(args[2])) }), stderr: "" }
  }
  return { gh, calls }
}

describe("linkWorkerPr", () => {
  test("links on PR ready", async () => {
    await seed(ID)
    const { gh, calls } = fakeGh(() => `dispatch/${ID}`)
    expect(await linkWorkerPr({ gh, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("linked")
    expect(await prOf(ID)).toBe(URL())
    expect(calls[0]).toEqual(["pr", "view", "423", "--repo", "jaubut/tls-dashboard-v2", "--json", "headRefName,isCrossRepository,url"])
  })

  test("refuses a mismatched repo without asking GitHub", async () => {
    await seed(ID)
    const { gh, calls } = fakeGh(() => `dispatch/${ID}`)
    expect(await linkWorkerPr({ gh, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL("claude-config") })).toBe("repo_mismatch")
    expect(await linkWorkerPr({ gh, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: "https://github.com/someone/tls-dashboard-v2/pull/1" })).toBe("bad_url")
    expect(calls).toEqual([])
    expect(await prOf(ID)).toBeNull()
  })

  test("refuses a mismatched branch or a fork head", async () => {
    await seed(ID)
    expect(await linkWorkerPr({ gh: fakeGh(() => "dispatch/other").gh, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("branch_mismatch")
    expect(await linkWorkerPr({ gh: fakeGh(() => `dispatch/${ID}`, { cross: true }).gh, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("branch_mismatch")
    expect(await prOf(ID)).toBeNull()
  })

  test("never overwrites an existing link", async () => {
    await seed(ID, URL("tls-dashboard-v2", 1))
    const { gh } = fakeGh(() => `dispatch/${ID}`)
    expect(await linkWorkerPr({ gh, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("not_linked")
    expect(await prOf(ID)).toBe(URL("tls-dashboard-v2", 1))
  })

  test("refuses a done task, a dispatch-run row and a row owned by another agent", async () => {
    const ids = [`${ID.slice(0, 30)}d1`, `${ID.slice(0, 30)}d2`, `${ID.slice(0, 30)}d3`, `${ID.slice(0, 30)}d4`]
    await seed(ids[0]!, { done: 1 })
    await seed(ids[1]!, { assignee: "agent:builder", status: "running", owner: "zettlab" })
    await seed(ids[2]!, { owner: "companion:relay:tls-dashboard-v2-x" })
    await seed(ids[3]!, { status: "running" })
    for (const id of ids) {
      const { gh } = fakeGh(() => `dispatch/${id}`)
      expect(await linkWorkerPr({ gh, exec: tursoExec, sleep: noSleep }, { taskId: id, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("not_linked")
      expect(await linkWorkerPr({ gh, exec: tursoExec, sleep: noSleep }, { taskId: id, repo: "tls-dashboard-v2", prUrl: URL() }, { write: false })).toBe("not_linked")
      expect(await prOf(id)).toBeNull()
    }
    // never filed at all
    expect(await linkWorkerPr({ gh: fakeGh(() => `dispatch/${ID}`).gh, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("not_linked")
  })

  test("writes GitHub's canonical url, not the one the worker printed", async () => {
    await seed(ID)
    const { gh } = fakeGh(() => `dispatch/${ID}`)
    expect(await linkWorkerPr({ gh, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: "https://github.com/jaubut/TLS-Dashboard-V2/pull/423" })).toBe("linked")
    expect(await prOf(ID)).toBe(URL())
  })

  test("a canonical url for another repo is refused", async () => {
    await seed(ID)
    const { gh } = fakeGh(() => `dispatch/${ID}`, { url: URL("claude-config") })
    expect(await linkWorkerPr({ gh, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("repo_mismatch")
    expect(await prOf(ID)).toBeNull()
  })

  test("retries a transient gh failure twice, then gives up as an outcome, never a throw", async () => {
    await seed(ID)
    const slept: number[] = []
    const sleep = async (ms: number) => { slept.push(ms) }
    const flaky = fakeGh(() => `dispatch/${ID}`, { fail: 2 })
    expect(await linkWorkerPr({ gh: flaky.gh, exec: tursoExec, sleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("linked")
    expect(flaky.calls).toHaveLength(3)
    expect(slept).toHaveLength(2)

    const id2 = `${ID.slice(0, 31)}y`
    await seed(id2)
    let n = 0
    const down: GhFn = async () => { n++; throw new Error("gh down") }
    expect(await linkWorkerPr({ gh: down, exec: tursoExec, sleep: noSleep }, { taskId: id2, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("gh_failed")
    expect(n).toBe(3)
    expect(await prOf(id2)).toBeNull()
  })

  test("retries a failed write", async () => {
    await seed(ID)
    let fails = 1
    const exec: typeof tursoExec = async (s, a) => {
      if (s.startsWith("UPDATE") && fails-- > 0) throw new Error("turso unreachable")
      return tursoExec(s, a)
    }
    expect(await linkWorkerPr({ gh: fakeGh(() => `dispatch/${ID}`).gh, exec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() })).toBe("linked")
    expect(await prOf(ID)).toBe(URL())
  })

  test("deadline: answers timeout instead of hanging the turn; the link still lands", async () => {
    await seed(ID)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const inner = fakeGh(() => `dispatch/${ID}`)
    const slow: GhFn = async (args) => { await gate; return inner.gh(args) }
    const t0 = Date.now()
    expect(await linkWorkerPr({ gh: slow, exec: tursoExec, sleep: noSleep }, { taskId: ID, repo: "tls-dashboard-v2", prUrl: URL() }, { deadlineMs: 50 })).toBe("timeout")
    expect(Date.now() - t0).toBeLessThan(1_000)
    release()
    for (let i = 0; i < 50 && !(await prOf(ID)); i++) await Bun.sleep(10)
    expect(await prOf(ID)).toBe(URL())
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

    expect(await backfill({ gh, exec: tursoExec, sleep: noSleep, log: (l) => lines.push(l) }, file, false)).toEqual([{ taskId: ID, repo: "tls-dashboard-v2", prUrl: URL(), outcome: "would_link" }])
    expect(await prOf(ID)).toBeNull()
    expect(calls.filter((c) => c[1] === "list")).toHaveLength(1)

    expect((await backfill({ gh, exec: tursoExec, sleep: noSleep, log: (l) => lines.push(l) }, file, true))[0]!.outcome).toBe("linked")
    expect(await prOf(ID)).toBe(URL())
    expect(await prOf(linked)).toBe(URL("tls-dashboard-v2", 1))
  })
})
