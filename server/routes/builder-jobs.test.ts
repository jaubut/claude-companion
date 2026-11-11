import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { clients } from "../state"

// Route-level: /hooks/builder-progress through the real server (loopback gate),
// GET /api/builder-jobs behind the bearer, the `builder_jobs` WS frame, its place
// in the /ws open sequence (absent when idle: old builds see nothing new), and an
// end-to-end run: TASK, 3 PROGRESS, DONE → the job shows, then clears.

const dir = mkdtempSync(join(tmpdir(), "builder-jobs-route-"))
process.env.COMPANION_DB_PATH ??= join(dir, "test.db")
process.env.COMPANION_AUTH_TOKEN ||= "vault-test-token-0123456789"
const TOKEN = getAuthToken()

type Ws = Parameters<typeof clients.add>[0]
let builderJobs: typeof import("../wiring/builder-jobs").builderJobs
let websocket: typeof import("../ws").websocket
let dialogWatcher: typeof import("../wiring/dialogs").dialogWatcher
let server: { port: number; stop(force?: boolean): void }
const frames: Array<Record<string, unknown>> = []
const fake = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Ws

beforeAll(async () => {
  builderJobs = (await import("../wiring/builder-jobs")).builderJobs
  websocket = (await import("../ws")).websocket
  dialogWatcher = (await import("../wiring/dialogs")).dialogWatcher
  const { createCompanionServer } = await import("../companion-server")
  server = createCompanionServer(0) as unknown as { port: number; stop(force?: boolean): void }
  clients.add(fake)
})
beforeEach(() => {
  builderJobs.stop()
  frames.length = 0
})
afterAll(() => {
  clients.delete(fake)
  builderJobs.stop()
  dialogWatcher.stop()
  server.stop(true)
})

const jobFrames = () => frames.filter((f) => f.type === "builder_jobs") as Array<{ jobs: Array<Record<string, unknown>> }>

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/hooks/builder-progress`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function api(token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/builder-jobs`, token ? { headers: { authorization: `Bearer ${token}` } } : {})
}

describe("end to end: fake builder (relay mod's POSTs)", () => {
  test("TASK + 3 PROGRESS + DONE: frames show the job, then clear it", async () => {
    const id = "d094e0b4-1c2a-4f6e-9d3b-0a1b2c3d4e5f"
    expect((await post({ event: "task", id, title: "Share Granby 87 GB", builder: "builder-zettlab-x" })).status).toBe(200)
    for (const [pct, step] of [[12, "rsync 10/87 GB"], [39, "rsync 34/87 GB"], [null, "previews 80/161"]] as const)
      expect((await post({ event: "progress", id, pct, step })).status).toBe(200)
    const mid = await (await api(TOKEN)).json() as { ok: boolean; jobs: Array<Record<string, unknown>> }
    expect(mid.ok).toBe(true)
    expect(mid.jobs).toHaveLength(1)
    expect(mid.jobs[0]).toMatchObject({ id, title: "Share Granby 87 GB", builder: "builder-zettlab-x", pct: null, step: "previews 80/161", stale: false })
    expect((await post({ event: "done", id })).status).toBe(200)
    expect(jobFrames().map((f) => f.jobs.map((j) => [j.pct, j.step]))).toEqual([
      [[null, null]], [[12, "rsync 10/87 GB"]], [[39, "rsync 34/87 GB"]], [[null, "previews 80/161"]], [],
    ])
    expect((await (await api(TOKEN)).json() as { jobs: unknown[] }).jobs).toEqual([])
  })
})

describe("POST /hooks/builder-progress", () => {
  test("validation: bad JSON / bad event / bad id → 400", async () => {
    const bad = await post("{nope")
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ ok: false, error: "invalid_json" })
    for (const b of [{ event: "ack", id: "x" }, { event: "progress" }, { event: "progress", id: "has space" }]) {
      const r = await post(b)
      expect(r.status).toBe(400)
      expect(await r.json()).toEqual({ ok: false, error: "invalid_report" })
    }
    expect(jobFrames()).toEqual([])
  })

  test("browser origin refused by the hook gate", async () => {
    expect((await post({ event: "task", id: "x" }, { origin: "https://evil.example" })).status).toBe(403)
  })
})

describe("GET /api/builder-jobs", () => {
  test("bearer required", async () => {
    expect((await api()).status).toBe(401)
    expect((await api("wrong-token-wrong-token-xx")).status).toBe(401)
    expect((await api(TOKEN)).status).toBe(200)
  })
})

describe("/ws open (old-client compatibility)", () => {
  function phone(): { ws: Ws; got: Array<Record<string, unknown>> } {
    const got: Array<Record<string, unknown>> = []
    const ws = { send: (m: string) => { got.push(JSON.parse(m)) }, data: { id: "t", client: { remote: "100.64.0.9", ua: "CompanionTest/1", device: "test-phone" } } } as unknown as Ws
    return { ws, got }
  }

  test("no jobs: no builder_jobs frame, init unchanged (no new key)", () => {
    const p = phone()
    websocket.open!(p.ws as never)
    clients.delete(p.ws)
    expect(p.got.some((f) => f.type === "builder_jobs")).toBe(false)
    expect(Object.keys(p.got[0]!)).not.toContain("builderJobs")
  })

  test("with a live job: init first, builder_jobs after", async () => {
    await post({ event: "progress", id: "t-ws", pct: 5, step: "x" })
    const p = phone()
    websocket.open!(p.ws as never)
    clients.delete(p.ws)
    const types = p.got.map((f) => f.type)
    expect(types[0]).toBe("init")
    expect(types).toContain("builder_jobs")
  })
})

describe("contracts/builder-jobs/frame.json", () => {
  test("live frame and items carry exactly the fixture keys", async () => {
    await post({ event: "progress", id: "t-keys", pct: 1, step: "s" })
    const want = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "contracts", "builder-jobs", "frame.json"), "utf8")) as { jobs: object[] }
    const live = jobFrames().at(-1)!
    const keys = (o: object) => Object.keys(o).sort()
    expect(keys(live)).toEqual(keys(want))
    for (const item of want.jobs) expect(keys(live.jobs[0]!)).toEqual(keys(item))
  })
})
