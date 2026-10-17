import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"

// /api/taste/* through the real server's bearer gate, against a fake
// tls-dashboard-v2. No swipe ever reaches a real dashboard.

const home = mkdtempSync(join(tmpdir(), "taste-route-"))
process.env.COMPANION_DB_PATH ??= join(home, "test.db")
process.env.COMPANION_AUTH_TOKEN ??= "taste-test-token-0123456789abcdef"
const TOKEN = getAuthToken()
const DASH_KEY = "dash-SECRET-key-taste-42"
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const savedEnv = { ...process.env }

interface Hit { method: string; path: string; key: string | null; body: string }
let hits: Hit[] = []
let reply: (h: Hit) => Response = () => Response.json({ ok: true })
let dash: ReturnType<typeof Bun.serve>
let server: { port: number; stop(force?: boolean): void }

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
  reply = () => Response.json({ ok: true })
})

const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })

describe("auth", () => {
  test("every route needs the Companion bearer; nothing reaches the dashboard", async () => {
    for (const [m, p] of [["GET", "/api/taste/next"], ["POST", "/api/taste/swipe"], ["GET", "/api/taste/items/1/image"], ["GET", "/api/taste/stats"]] as const) {
      expect((await call(m, p, m === "POST" ? { item_id: 1, verdict: "like" } : undefined, null)).status).toBe(401)
      expect((await call(m, p, m === "POST" ? { item_id: 1, verdict: "like" } : undefined, "wrong-token-wrong-token-xx")).status).toBe(401)
    }
    expect(hits).toEqual([])
  })
})

describe("GET /api/taste/next", () => {
  test("forwards dataset + limit with the vault key, passes the body through", async () => {
    const items = [{ id: 7, dataset: "websites", source_url: "https://x.test/", title: null, image_url: "/api/taste/items/7/image" }]
    reply = () => Response.json({ items })
    const r = await call("GET", "/api/taste/next?dataset=websites&limit=5&junk=1")
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ items })
    expect(hits).toEqual([{ method: "GET", path: "/api/taste/next?dataset=websites&limit=5", key: DASH_KEY, body: "" }])
  })
  test("bad dataset / limit → 400 before the dashboard", async () => {
    expect((await call("GET", "/api/taste/next?dataset=a%26b")).status).toBe(400)
    expect((await call("GET", "/api/taste/next?limit=-1")).status).toBe(400)
    expect((await call("GET", "/api/taste/next?limit=abc")).status).toBe(400)
    expect(hits).toEqual([])
  })
})

describe("POST /api/taste/swipe", () => {
  test("valid swipe forwarded with only the known fields", async () => {
    const r = await call("POST", "/api/taste/swipe", { item_id: 3, verdict: "dislike", reason_tag: "color", extra: "x" })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
    expect(hits.length).toBe(1)
    expect(hits[0]!.method).toBe("POST")
    expect(hits[0]!.key).toBe(DASH_KEY)
    expect(JSON.parse(hits[0]!.body)).toEqual({ item_id: 3, verdict: "dislike", reason_tag: "color" })
    await call("POST", "/api/taste/swipe", { item_id: 4, verdict: "like", reason_tag: null })
    expect(JSON.parse(hits[1]!.body)).toEqual({ item_id: 4, verdict: "like" })
  })
  test("enum + shape validation → 400, never forwarded", async () => {
    const bad: Array<[unknown, string]> = [
      [{ item_id: 1, verdict: "meh" }, "invalid_verdict"],
      [{ item_id: 1 }, "invalid_verdict"],
      [{ item_id: 1, verdict: "like", reason_tag: "vibes" }, "invalid_reason_tag"],
      [{ item_id: 1, verdict: "like", reason_tag: 3 }, "invalid_reason_tag"],
      [{ item_id: "1", verdict: "like" }, "invalid_item_id"],
      [{ item_id: 1.5, verdict: "like" }, "invalid_item_id"],
      [{ item_id: 0, verdict: "like" }, "invalid_item_id"],
      ["not json", "bad_json"],
      [[1], "bad_json"],
    ]
    for (const [body, error] of bad) {
      const r = await call("POST", "/api/taste/swipe", body)
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: string }).error).toBe(error)
    }
    expect(hits).toEqual([])
  })
  test("dashboard 4xx passes through (status + body)", async () => {
    reply = () => Response.json({ error: "item_not_found" }, { status: 404 })
    const r = await call("POST", "/api/taste/swipe", { item_id: 999, verdict: "like" })
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: "item_not_found" })
  })
  test("GET on swipe → 405", async () => {
    expect((await call("GET", "/api/taste/swipe")).status).toBe(405)
  })
})

describe("GET /api/taste/items/:id/image", () => {
  test("bytes + content-type + nosniff", async () => {
    reply = () => new Response(PNG, { headers: { "content-type": "image/png" } })
    const r = await call("GET", "/api/taste/items/12/image")
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("image/png")
    expect(r.headers.get("x-content-type-options")).toBe("nosniff")
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG)
    expect(hits[0]!.path).toBe("/api/taste/items/12/image")
  })
  test("upstream 404 → 404; malformed id never forwarded", async () => {
    reply = () => Response.json({ error: "not_found" }, { status: 404 })
    expect((await call("GET", "/api/taste/items/12/image")).status).toBe(404)
    expect((await call("GET", "/api/taste/items/0/image")).status).toBe(404)
    expect((await call("GET", "/api/taste/items/..%2F..%2Fnote/image")).status).toBe(404)
    expect(hits.length).toBe(1)
  })
})

describe("image route hardening", () => {
  test("upstream 403 keeps its status; non-raster mime → 502, never served", async () => {
    reply = () => new Response("nope", { status: 403 })
    expect((await call("GET", "/api/taste/items/12/image")).status).toBe(403)
    reply = () => new Response("<svg onload=alert(1)>", { headers: { "content-type": "image/svg+xml" } })
    const r = await call("GET", "/api/taste/items/12/image")
    expect(r.status).toBe(502)
    expect(await r.text()).not.toContain("<svg")
  })
  test("served image is sandboxed", async () => {
    reply = () => new Response(PNG, { headers: { "content-type": "image/png; charset=binary" } })
    const r = await call("GET", "/api/taste/items/12/image")
    expect(r.headers.get("content-type")).toBe("image/png")
    expect(r.headers.get("content-security-policy")).toContain("sandbox")
  })
})

describe("GET /api/taste/stats + upstream errors", () => {
  test("stats pass through", async () => {
    const stats = [{ dataset: "websites", verdict: "unswiped", count: 155 }]
    reply = () => Response.json({ stats })
    const r = await call("GET", "/api/taste/stats")
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ stats })
  })
  test("dashboard 5xx → 502 dashboard_unreachable", async () => {
    reply = () => new Response("boom", { status: 500 })
    for (const p of ["/api/taste/stats", "/api/taste/next", "/api/taste/items/1/image"]) {
      const r = await call("GET", p)
      expect(r.status).toBe(502)
      expect(((await r.json()) as { error: string }).error).toBe("dashboard_unreachable")
    }
  })
  test("dashboard 401 (bad key) passes through", async () => {
    reply = () => Response.json({ error: "unauthorized" }, { status: 401 })
    const r = await call("GET", "/api/taste/stats")
    expect(r.status).toBe(401)
    expect(await r.json()).toEqual({ error: "unauthorized" })
  })
  test("no key in the vault → 503, nothing sent", async () => {
    writeFileSync(process.env.TLS_SECRETS_FILE!, "")
    const r = await call("GET", "/api/taste/stats")
    expect(r.status).toBe(503)
    expect(((await r.json()) as { error: string }).error).toBe("dashboard_key_missing")
    expect(hits).toEqual([])
  })
})
