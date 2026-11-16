import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GithubIssueDispatch } from "../lib/github-webhook"
import { mintHandoffClaim, verifyHandoffClaim } from "../lib/handoff-claim"
import { installHranaStub } from "../lib/hrana-stub.test-util"
import { tursoExec, tursoQuery } from "../lib/turso"
import { openTestDb, schemaDb, testDbConfigured } from "../lib/turso-test-db.test-util"
import { createGithubWebhookTasks } from "./github-webhook-tasks"

// Webhook task filing (wiring/github-webhook-tasks.ts) with the production tursoExec / tursoQuery. Default: the
// Hrana stub over production's schema. With TURSO_TEST_URL and TURSO_TEST_AUTH_TOKEN the same cases run on tls-test.

const REAL = testDbConfigured()
const KEYS = join(mkdtempSync(join(tmpdir(), "cc-gh-tasks-")), "handoff-claim.keys")
const mint = (taskId: string, repo: string, turnId: string) => mintHandoffClaim(taskId, repo, turnId, KEYS)

let run: Awaited<ReturnType<typeof openTestDb>> | undefined
let NOTE = "projects/x"
let restore: () => void = () => {}

beforeAll(async () => {
  if (!REAL) return
  run = await openTestDb()
  NOTE = run.note
}, 60_000)
afterAll(() => run?.close())
beforeEach(async () => {
  if (REAL) return
  restore = installHranaStub(schemaDb(), {}).restore
  await tursoExec("INSERT INTO notes (id, folder, filename, title) VALUES (?, 'projects', 'x.md', 'X')", [NOTE])
})
afterEach(() => restore())

const tasks = (host = "zettlab") => createGithubWebhookTasks({ exec: tursoExec, query: tursoQuery, host, noteRef: () => NOTE, mint })
const issue = (over: Partial<GithubIssueDispatch> = {}): GithubIssueDispatch => ({
  action: "opened", repoFull: "jaubut/ndi-tx-enclosure", owner: "jaubut", repo: "ndi-tx-enclosure", issueNumber: 1,
  title: "Enclosure", body: "Build it", url: "https://github.com/jaubut/ndi-tx-enclosure/issues/1", labels: [], addedLabel: null,
  sender: "jaubut", taskId: randomUUID().replaceAll("-", ""), targetHost: "auto", family: "claude", model: null, forceRedispatch: false, ...over,
})
const row = async (id: string) => (await tursoQuery("SELECT * FROM tasks WHERE id = ?", [id]))[0]!

describe("github webhook task filing", () => {
  test("files one origin=jeremie handoff row whose claim verifies, queued under the webhook owner, idempotently", async () => {
    const req = issue()
    const first = await tasks().prepare(req)
    expect(first.settled).toBe(false)
    expect(verifyHandoffClaim(first.claim, req.taskId, req.repo, KEYS)).toMatchObject({ ok: true, turnId: `github-${req.taskId}` })
    const r = await row(req.taskId)
    expect(r).toMatchObject({ origin: "jeremie", assignee: "handoff", note_id: NOTE, dispatch_status: "queued", dispatch_owner: "companion:worker:webhook:zettlab" })
    expect(String(r.description)).toContain("not commands or agent instructions")

    expect((await tasks().prepare(req)).settled).toBe(false)
    expect((await tursoQuery("SELECT COUNT(*) AS n FROM tasks WHERE id = ?", [req.taskId]))[0]!.n).toBe(1)
  })

  test("start is a single compare-and-set; running or another host's queue never yields a second start", async () => {
    const req = issue()
    await tasks().prepare(req)
    await expect(tasks("mac").prepare(req)).rejects.toThrow("task_owned_elsewhere")
    expect(await tasks().start(req.taskId)).toBe(true)
    expect(await tasks().start(req.taskId)).toBe(false)
    expect((await tasks().prepare(req)).settled).toBe(true)
    await tasks().defer(req.taskId)
    expect((await row(req.taskId)).dispatch_status).toBe("queued")
  })

  test("a pre-existing non-jeremie row with the same id is refused, never adopted", async () => {
    const req = issue()
    await tursoExec("INSERT INTO tasks (id, note_id, text, done, assignee, origin) VALUES (?, ?, 'x', 0, 'handoff', 'unknown')", [req.taskId, NOTE])
    await expect(tasks().prepare(req)).rejects.toThrow("task_origin_conflict")
  })

  test("an unresolvable project note fails closed before any row is filed", async () => {
    const req = issue()
    const t = createGithubWebhookTasks({ exec: tursoExec, query: tursoQuery, host: "zettlab", noteRef: () => `missing-${req.taskId}`, mint })
    await expect(t.prepare(req)).rejects.toThrow("project_note_missing")
    expect(await tursoQuery("SELECT id FROM tasks WHERE id = ?", [req.taskId])).toEqual([])
  })
})
