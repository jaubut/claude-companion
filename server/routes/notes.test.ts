import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"

// /api/notes* through the real server's bearer gate, against a fake
// tls-dashboard-v2. Nothing here reaches Turso or a real dashboard.

const home = mkdtempSync(join(tmpdir(), "notes-route-"))
process.env.COMPANION_DB_PATH ??= join(home, "test.db")
process.env.COMPANION_AUTH_TOKEN ??= "notes-test-token-0123456789abcdef"
const TOKEN = getAuthToken()
const DASH_KEY = "dash-SECRET-key-notes-42"
const savedEnv = { ...process.env }

const NOTES = [
  { id: "resources/2026-10-01-old", ref_code: "RES-OLD1", title: "Old resource", folder: "resources", status: "draft", date: "2026-10-01", updated_at: "2026-10-01 09:00:00", tags: ["a"], body: "nothing" },
  { id: "projects/2026-09-01-fresh", ref_code: "PRJ-FRSH", title: "Fresh project", folder: "projects", status: "active", date: "2026-09-01", updated_at: "2026-10-23T18:00:00.000Z", tags: [], body: "kickoff" },
  { id: "ideas/2026-10-10-mid", ref_code: "IDE-MID2", title: "Middle idea about resources", folder: "ideas", status: "draft", date: "2026-10-10", updated_at: "2026-10-12 10:00:00", tags: ["x", "y"], body: "body text" },
  { id: "journal/2026-10-24-diary", ref_code: "JRN-DIA1", title: "Dear diary", folder: "journal", status: "draft", date: "2026-10-24", updated_at: "2026-10-24 23:00:00", tags: [], body: "private" },
]

interface Hit { method: string; path: string; key: string | null; body: string }
let hits: Hit[] = []
let reply: (h: Hit) => Response
let dash: ReturnType<typeof Bun.serve>
let server: { port: number; stop(force?: boolean): void }

function fakeDashboard(h: Hit): Response {
  const u = new URL(h.path, "http://x")
  if (h.method === "GET" && u.pathname === "/api/notes") return Response.json(NOTES.map(({ body, ...n }) => ({ ...n, body: body.slice(0, 280) })))
  if (h.method === "GET" && u.pathname === "/api/note") {
    const ref = (u.searchParams.get("ref") ?? "").toUpperCase()
    const n = NOTES.find(x => x.ref_code === ref)
    return n ? Response.json({ ...n, meta: {}, filename: "f.md" }) : new Response("404 Not Found", { status: 404 })
  }
  if (h.method === "POST" && u.pathname === "/api/search") return Response.json({ results: [{ kind: "note", id: "resources/2026-10-01-old", title: "Old resource" }, { kind: "note", id: "journal/2026-10-24-diary", title: "Dear diary" }, { kind: "client", id: "acme", title: "Acme" }] })
  if (h.method === "POST" && u.pathname === "/api/note") return Response.json({ ok: true, id: "ideas/2026-10-24-new", ref_code: "IDE-NEW9", filename: "2026-10-24-new.md" })
  if (h.method === "PUT" && u.pathname === "/api/note") return Response.json({ ok: true, updated_at: "2026-10-24 12:34:56" })
  return new Response("nope", { status: 404 })
}

beforeAll(async () => {
  dash = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url)
      const h: Hit = { method: req.method, path: u.pathname + u.search, key: req.headers.get("x-api-key"), body: await req.text() }
      hits.push(h)
      return reply(h)
    },
  })
  process.env.TLS_SECRETS_FILE = join(home, "secrets.env")
  process.env.COMPANION_DASHBOARD_URL = `http://127.0.0.1:${dash.port}`
  delete process.env.COMPANION_VAULT_UPSTREAM
  const { createCompanionServer } = await import("../companion-server")
  server = createCompanionServer(0) as unknown as { port: number; stop(force?: boolean): void }
})
afterAll(() => {
  server.stop(true)
  dash.stop(true)
  rmSync(home, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
  Object.assign(process.env, savedEnv)
})
beforeEach(() => {
  writeFileSync(process.env.TLS_SECRETS_FILE!, `TLS_DASHBOARD_API_KEY='${DASH_KEY}'\n`)
  hits = []
  reply = fakeDashboard
})

const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })

interface ListBody { notes: Array<Record<string, unknown>> }
const refs = async (r: Response): Promise<unknown[]> => ((await r.json()) as ListBody).notes.map(n => n.ref_code)
const errorOf = async (r: Response): Promise<string> => ((await r.json()) as { error: string }).error

describe("auth", () => {
  test("every route needs the Companion bearer; nothing reaches the dashboard", async () => {
    for (const [m, p] of [["GET", "/api/notes"], ["POST", "/api/notes"], ["GET", "/api/notes/RES-OLD1"], ["PUT", "/api/notes/RES-OLD1"]] as const) {
      expect((await call(m, p, m === "GET" ? undefined : { title: "x" }, null)).status).toBe(401)
    }
    expect(hits).toEqual([])
  })
})

describe("GET /api/notes", () => {
  test("no q → most recently updated first, journal excluded, contract shape, key sent", async () => {
    const r = await call("GET", "/api/notes")
    expect(r.status).toBe(200)
    const { notes } = (await r.json()) as ListBody
    expect(notes.map(n => n.ref_code)).toEqual(["PRJ-FRSH", "IDE-MID2", "RES-OLD1"])
    expect(notes[1]).toEqual({ id: "ideas/2026-10-10-mid", ref_code: "IDE-MID2", title: "Middle idea about resources", folder: "ideas", status: "draft", date: "2026-10-10", updated_at: "2026-10-12 10:00:00", tags: ["x", "y"] })
    expect(hits).toEqual([{ method: "GET", path: "/api/notes", key: DASH_KEY, body: "" }])
  })
  test("limit caps the list", async () => {
    expect(await refs(await call("GET", "/api/notes?limit=1"))).toEqual(["PRJ-FRSH"])
  })
  test("folder filters; folder=journal → empty", async () => {
    expect(await refs(await call("GET", "/api/notes?folder=ideas"))).toEqual(["IDE-MID2"])
    expect(await refs(await call("GET", "/api/notes?folder=journal"))).toEqual([])
  })
  test("q by ref (case-insensitive) comes first, then title, then body search hits; journal never", async () => {
    const r = await call("GET", "/api/notes?q=res-old1")
    expect(await refs(r)).toEqual(["RES-OLD1"])
    const search = hits.find(h => h.path === "/api/search")!
    expect(JSON.parse(search.body)).toEqual({ query: "res-old1", limit: 200 })
    // "resources": title match on IDE-MID2, body hit RES-OLD1 from search, journal hit dropped
    expect(await refs(await call("GET", "/api/notes?q=resources"))).toEqual(["IDE-MID2", "RES-OLD1"])
  })
  test("q + folder: search hits outside the folder are dropped", async () => {
    expect(await refs(await call("GET", "/api/notes?q=resources&folder=resources"))).toEqual(["RES-OLD1"])
  })
  test("bad folder / limit → 400 before the dashboard", async () => {
    for (const [p, err] of [["/api/notes?folder=a%2Fb", "bad_folder"], ["/api/notes?limit=0", "bad_limit"], ["/api/notes?limit=201", "bad_limit"], ["/api/notes?limit=abc", "bad_limit"]] as const) {
      const r = await call("GET", p)
      expect(r.status).toBe(400)
      expect(await errorOf(r)).toBe(err)
    }
    expect(hits).toEqual([])
  })
})

describe("GET /api/notes/:ref", () => {
  test("returns the note with body", async () => {
    const r = await call("GET", "/api/notes/IDE-MID2")
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ note: { id: "ideas/2026-10-10-mid", ref_code: "IDE-MID2", title: "Middle idea about resources", folder: "ideas", status: "draft", date: "2026-10-10", updated_at: "2026-10-12 10:00:00", tags: ["x", "y"], body: "body text" } })
    expect(hits[0]!.path).toBe("/api/note?ref=IDE-MID2")
  })
  test("unknown ref → 404 not_found", async () => {
    const r = await call("GET", "/api/notes/RES-NONE")
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ ok: false, error: "not_found" })
  })
  test("journal → 403 journal_protected", async () => {
    const r = await call("GET", "/api/notes/JRN-DIA1")
    expect(r.status).toBe(403)
    expect(await errorOf(r)).toBe("journal_protected")
  })
  test("bad ref → 400, never forwarded", async () => {
    for (const p of ["/api/notes/res-old1", "/api/notes/RES-OLD", "/api/notes/RESX-OLD1", "/api/notes/%E0%A4%A"]) {
      const r = await call("GET", p)
      expect(r.status).toBe(400)
      expect(await errorOf(r)).toBe("bad_ref")
    }
    expect(hits).toEqual([])
  })
})

describe("POST /api/notes", () => {
  test("happy path → 201 with ref_code; date = today, status defaults to draft", async () => {
    const r = await call("POST", "/api/notes", { title: " New idea ", folder: "ideas", body: "", tags: ["t"], extra: 1 })
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual({ ok: true, id: "ideas/2026-10-24-new", ref_code: "IDE-NEW9" })
    expect(hits.length).toBe(1)
    expect(hits[0]!.method).toBe("POST")
    expect(hits[0]!.key).toBe(DASH_KEY)
    expect(JSON.parse(hits[0]!.body)).toEqual({ folder: "ideas", title: "New idea", body: "", date: new Date().toLocaleDateString("en-CA"), status: "draft", tags: ["t"] })
  })
  test("validation → 4xx, never forwarded", async () => {
    const bad: Array<[unknown, number, string]> = [
      [{ folder: "ideas", body: "" }, 400, "missing_title"],
      [{ title: "  ", folder: "ideas", body: "" }, 400, "missing_title"],
      [{ title: "x".repeat(201), folder: "ideas", body: "" }, 400, "title_too_long"],
      [{ title: "x", folder: "journal", body: "" }, 403, "journal_protected"],
      [{ title: "x", folder: "accounting", body: "" }, 400, "bad_folder"],
      [{ title: "x", folder: "ideas" }, 400, "bad_body"],
      [{ title: "x", folder: "ideas", body: "", tags: "a" }, 400, "bad_tags"],
      [{ title: "x", folder: "ideas", body: "", tags: [1] }, 400, "bad_tags"],
      [{ title: "x", folder: "ideas", body: "", status: "wip" }, 400, "bad_status"],
      ["not json", 400, "bad_json"],
    ]
    for (const [body, status, error] of bad) {
      const r = await call("POST", "/api/notes", body)
      expect(r.status).toBe(status)
      expect(await errorOf(r)).toBe(error)
    }
    expect(hits).toEqual([])
  })
  test("dashboard 4xx passes through", async () => {
    reply = () => Response.json({ ok: false, error: "folder and title required" }, { status: 400 })
    const r = await call("POST", "/api/notes", { title: "x", folder: "ideas", body: "" })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ ok: false, error: "folder and title required" })
  })
})

describe("PUT /api/notes/:ref", () => {
  test("happy path resolves ref → id upstream and returns updated_at", async () => {
    const r = await call("PUT", "/api/notes/RES-OLD1", { title: "Renamed", body: "new body", status: "done", tags: ["z"], folder: "journal" })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, updated_at: "2026-10-24 12:34:56" })
    expect(hits.map(h => `${h.method} ${h.path}`)).toEqual(["GET /api/note?ref=RES-OLD1", "PUT /api/note"])
    expect(JSON.parse(hits[1]!.body)).toEqual({ id: "resources/2026-10-01-old", title: "Renamed", body: "new body", status: "done", tags: ["z"], changed_by: "companion" })
  })
  test("journal note → 403, never written", async () => {
    const r = await call("PUT", "/api/notes/JRN-DIA1", { body: "overwrite" })
    expect(r.status).toBe(403)
    expect(await errorOf(r)).toBe("journal_protected")
    expect(hits.some(h => h.method === "PUT")).toBe(false)
  })
  test("unknown ref → 404; empty / bad fields → 400 before the dashboard", async () => {
    expect((await call("PUT", "/api/notes/RES-NONE", { body: "x" })).status).toBe(404)
    hits = []
    for (const [body, error] of [[{}, "no_fields"], [{ status: "wip" }, "bad_status"], [{ title: "" }, "missing_title"], [{ body: 3 }, "bad_body"]] as const) {
      const r = await call("PUT", "/api/notes/RES-OLD1", body)
      expect(r.status).toBe(400)
      expect(await errorOf(r)).toBe(error)
    }
    expect(hits).toEqual([])
  })
})

describe("upstream errors", () => {
  test("no key in the vault → 503 dashboard_key_missing, nothing sent", async () => {
    writeFileSync(process.env.TLS_SECRETS_FILE!, "")
    for (const [m, p, b] of [["GET", "/api/notes", undefined], ["GET", "/api/notes/RES-OLD1", undefined], ["POST", "/api/notes", { title: "x", folder: "ideas", body: "" }], ["PUT", "/api/notes/RES-OLD1", { body: "x" }]] as const) {
      const r = await call(m, p, b)
      expect(r.status).toBe(503)
      expect(await errorOf(r)).toBe("dashboard_key_missing")
    }
    expect(hits).toEqual([])
  })
  test("dashboard 5xx → 502 dashboard_unreachable", async () => {
    reply = () => new Response("boom", { status: 500 })
    const r = await call("GET", "/api/notes")
    expect(r.status).toBe(502)
    expect(await errorOf(r)).toBe("dashboard_unreachable")
  })
  test("dashboard 401 passes through", async () => {
    reply = () => Response.json({ error: "unauthorized" }, { status: 401 })
    const r = await call("GET", "/api/notes/RES-OLD1")
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: "unauthorized" })
  })
})
