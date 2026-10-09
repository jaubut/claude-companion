import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { recordSession } from "../lib/sessions"
import { recordPeer } from "../lib/vault-guard"
import { clients } from "../state"

// Route-level: /hooks/copy-progress (mod reports) through the hook chain,
// GET /api/copy-jobs through the real server's auth gate, the `copy_jobs` WS
// frame and its place in the /ws open sequence.

const dir = mkdtempSync(join(tmpdir(), "copy-jobs-route-"))
process.env.COMPANION_DB_PATH ??= join(dir, "test.db")
// getAuthToken() caches the first token any test file reads, so share the
// vault tests' value: whichever file runs first, the others still match.
process.env.COMPANION_AUTH_TOKEN ||= "vault-test-token-0123456789"
const TOKEN = getAuthToken()

type Route = (req: Request, url: URL) => Promise<Response | null>
type Ws = Parameters<typeof clients.add>[0]
let routes: Route[]
let copyJobs: typeof import("../wiring/copy-jobs").copyJobs
let websocket: typeof import("../ws").websocket
let dialogWatcher: typeof import("../wiring/dialogs").dialogWatcher
let server: { port: number; stop(force?: boolean): void }
const frames: Array<Record<string, unknown>> = []
const fake = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Ws

beforeAll(async () => {
  // Same order as the server's route chain.
  routes = [(await import("./hooks")).handleHookRoute, (await import("./copy-jobs")).handleCopyJobsRoute]
  copyJobs = (await import("../wiring/copy-jobs")).copyJobs
  websocket = (await import("../ws")).websocket
  dialogWatcher = (await import("../wiring/dialogs")).dialogWatcher
  const { createCompanionServer } = await import("../companion-server")
  server = createCompanionServer(0) as unknown as { port: number; stop(force?: boolean): void }
  clients.add(fake)
})
beforeEach(() => {
  copyJobs.stop()
  frames.length = 0
})
afterAll(() => {
  clients.delete(fake)
  // The store is a process-wide singleton: no job or timer may leak into
  // other test files (ws.test.ts asserts exact broadcast lists).
  copyJobs.stop()
  dialogWatcher.stop()
  server.stop(true)
})

function hook(path: string, body: unknown, peer = "127.0.0.1", headers: Record<string, string> = {}): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  recordPeer(req, peer)
  return (async () => {
    for (const r of routes) {
      const res = await r(req, new URL(req.url))
      if (res) return res
    }
    return null
  })()
}

const copyFrames = () => frames.filter((f) => f.type === "copy_jobs")

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  const at = Date.now()
  return {
    job_id: "2026-10-09-cam-a.ingest.log", label: "cam A", started_at: at - 90_000, copy_started_at: at - 60_000,
    total_files: 4, total_bytes: 4_000_000_000, done_files: 1, done_bytes: 1_000_000_000, current: "A001.MP4",
    failed: 0, finished: false, at, ...over,
  }
}

describe("POST /hooks/copy-progress", () => {
  test("loopback accepted (no x-companion-* headers needed); frame emitted with derived fields", async () => {
    const s = recordSession({ cwd: "/tmp/cp-a", sessionId: "cp-sid-a", tty: "/dev/ttys801" })!
    const res = await hook("/hooks/copy-progress", report({ session_id: "cp-sid-a" }))
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({ ok: true })
    const jobs = copyFrames().at(-1)!.jobs as Array<Record<string, unknown>>
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      jobId: "2026-10-09-cam-a.ingest.log", sessionKey: s.key, label: "cam A", state: "copying",
      totalFiles: 4, doneFiles: 1, current: "A001.MP4", bytesPerSec: 16_666_667, etaSec: 180,
    })
  })

  test("off-box without bearer → 403; with bearer → 200", async () => {
    expect((await hook("/hooks/copy-progress", report(), "192.168.1.50"))!.status).toBe(403)
    expect((await hook("/hooks/copy-progress", report(), "100.64.1.2"))!.status).toBe(403)
    expect((await hook("/hooks/copy-progress", report(), "192.168.1.50", { authorization: `Bearer ${TOKEN}` }))!.status).toBe(200)
  })

  test("validation: bad JSON / missing or over-long job_id → 400; partial body → 200", async () => {
    const bad = await hook("/hooks/copy-progress", "{nope")
    expect(bad!.status).toBe(400)
    expect(await bad!.json()).toEqual({ ok: false, error: "invalid_json" })
    const noId = await hook("/hooks/copy-progress", { label: "x" })
    expect(noId!.status).toBe(400)
    expect(await noId!.json()).toEqual({ ok: false, error: "job_id_required" })
    expect((await hook("/hooks/copy-progress", { job_id: "x".repeat(201) }))!.status).toBe(400)
    expect((await hook("/hooks/copy-progress", { job_id: "partial.log" }))!.status).toBe(200)
    expect(copyJobs.snapshot().jobs.find((j) => j.jobId === "partial.log"))
      .toMatchObject({ state: "hashing", sessionKey: null, label: "partial.log", totalFiles: 0, bytesPerSec: null })
  })
})

describe("GET /api/copy-jobs", () => {
  test("bearer required via the real server; shape", async () => {
    await hook("/hooks/copy-progress", report())
    const url = `http://127.0.0.1:${server.port}/api/copy-jobs`
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: { authorization: "Bearer wrong-token-wrong-token-xx" } })).status).toBe(401)
    const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; jobs: Array<Record<string, unknown>> }
    expect(body.ok).toBe(true)
    expect(body.jobs).toHaveLength(1)
    expect(body.jobs[0]).toMatchObject({ state: "copying", bytesPerSec: 16_666_667, etaSec: 180 })
  })

  test("POST through the real server: loopback needs no bearer", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/hooks/copy-progress`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report({ job_id: "real.log" })),
    })
    expect(res.status).toBe(200)
    expect(copyJobs.snapshot().jobs.map((j) => j.jobId)).toEqual(["real.log"])
  })
})

describe("/ws open", () => {
  function phone(): { ws: Ws; got: Array<Record<string, unknown>> } {
    const got: Array<Record<string, unknown>> = []
    const ws = { send: (m: string) => { got.push(JSON.parse(m)) }, data: { id: "t", client: { remote: "100.64.0.9", ua: "CompanionTest/1", device: "test-phone" } } } as unknown as Ws
    return { ws, got }
  }

  test("with a live job: init, then copy_jobs", async () => {
    await hook("/hooks/copy-progress", report())
    const p = phone()
    websocket.open!(p.ws as never)
    clients.delete(p.ws)
    expect(p.got.map((f) => f.type).slice(0, 2)).toEqual(["init", "copy_jobs"])
    expect((p.got[1]!.jobs as unknown[]).length).toBe(1)
  })

  test("no jobs: no copy_jobs frame", () => {
    const p = phone()
    websocket.open!(p.ws as never)
    clients.delete(p.ws)
    expect(p.got.some((f) => f.type === "copy_jobs")).toBe(false)
  })
})

describe("contracts/copy-jobs fixtures", () => {
  const fixture = (f: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "contracts", "copy-jobs", f), "utf8")) as Record<string, unknown>
  const keysOf = (o: unknown) => Object.keys(o as object).sort()

  test("live frame, empty frame and GET body carry the fixture keys", async () => {
    await hook("/hooks/copy-progress", report())
    const live = copyFrames().at(-1)!
    const want = fixture("frame.json")
    expect(keysOf(live)).toEqual(keysOf(want))
    for (const item of want.jobs as unknown[]) expect(keysOf((live.jobs as unknown[])[0])).toEqual(keysOf(item))

    const api = copyJobs.snapshot()
    const wantApi = fixture("api.json")
    expect(keysOf(api)).toEqual(keysOf(wantApi))
    expect(keysOf(api.jobs[0])).toEqual(keysOf((wantApi.jobs as unknown[])[0]))

    // The fixtures' derived numbers are the store's own math.
    for (const item of [...(want.jobs as Array<Record<string, number | null>>), ...(wantApi.jobs as Array<Record<string, number | null>>)]) {
      const { copyStartedAt, doneBytes, at, bytesPerSec } = item
      if (bytesPerSec !== null) expect(Math.round(doneBytes! / ((at! - copyStartedAt!) / 1000))).toBe(bytesPerSec!)
    }

    const empty = fixture("frame.empty.json")
    expect(empty.jobs).toEqual([])
    expect(keysOf(empty)).toEqual(keysOf(live))
  })
})
