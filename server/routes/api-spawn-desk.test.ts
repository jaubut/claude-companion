import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpawnWorkerOpts } from "../lib/worker-invocation"
import { listSessions } from "../lib/sessions"

// POST /api/spawn-session with COMPANION_DESK_HEADLESS=1: a claude spawn is a
// desk row (no terminal, no herdr), its seed the first headless turn with
// --session-id; `seed:"pending"` stays for iOS build 59. Resume of an unknown
// ended key stays 410. Spawn is faked: no claude runs.

const dir = mkdtempSync(join(tmpdir(), "spawn-desk-"))
let handleApiRoute: (req: Request, url: URL) => Promise<Response | null>
const spawned: SpawnWorkerOpts[] = []
let prevFlag: string | undefined
const prevHome = process.env.HOME

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(dir, "test.db")
  // ensureFolderTrusted writes $HOME/.claude.json: never the real one.
  process.env.HOME = dir
  prevFlag = process.env.COMPANION_DESK_HEADLESS
  process.env.COMPANION_DESK_HEADLESS = "1"
  ;({ handleApiRoute } = await import("./api"))
  const { deskRunner } = await import("../wiring/desk-deliver")
  deskRunner.override({
    stateFile: join(dir, "desk.json"),
    env: async () => ({}),
    spawn: (opts) => { spawned.push(opts); return { pid: 0, kill: () => {} } },
    identity: () => null,
    transcriptExists: () => false,
    terminalHolds: () => false,
  })
})
afterAll(() => {
  process.env.HOME = prevHome
  if (prevFlag === undefined) delete process.env.COMPANION_DESK_HEADLESS
  else process.env.COMPANION_DESK_HEADLESS = prevFlag
})

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`http://localhost:4245${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const res = (await handleApiRoute(req, new URL(req.url)))!
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

test("spawn claude with a seed → desk row + one headless turn (--session-id), seed pending", async () => {
  const r = await post("/api/spawn-session", { cwd: dir, agent: "claude", seed: "look at the README" })
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ ok: true, app: "headless", agent: "claude", seed: "pending" })
  const key = r.body.key as string
  const row = listSessions().find((s) => s.key === key)!
  expect(row.herdrPane).toBe(`headless:desk:${row.sessionId}`)
  expect(spawned).toHaveLength(1)
  const args = spawned[0]!.args
  expect(args[args.indexOf("--session-id") + 1]).toBe(row.sessionId)
  expect(args).not.toContain("--resume")
  expect(args.at(-1)).toContain("look at the README")
})

test("spawn claude without a seed → idle desk row, nothing runs; bad cwd → 400", async () => {
  const r = await post("/api/spawn-session", { cwd: dir, agent: "claude" })
  expect(r.body).toMatchObject({ ok: true, app: "headless" })
  expect(r.body.seed).toBeUndefined()
  expect(listSessions().find((s) => s.key === r.body.key)?.agentStatus).toBe("idle")
  expect(spawned).toHaveLength(1)
  expect((await post("/api/spawn-session", { cwd: "relative/path", agent: "claude" })).status).toBe(400)
})

test("resume: an ended key the server does not hold → 410 target_gone", async () => {
  expect(await post("/api/sessions/resume", { key: "ended:51794d7b-cf0f-4f63-9eaf-7b06cab5047e" })).toEqual({ status: 410, body: { ok: false, error: "target_gone" } })
})
