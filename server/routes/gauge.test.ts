import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { recordSession } from "../lib/sessions"
import { recordPeer } from "../lib/vault-guard"
import { clients } from "../state"

// Route-level: /hooks/gauge (mod reports), the Stop-hook transcript fallback,
// session-end drop, GET /api/gauge through the real server's auth gate, and
// the `gauge` WS frame.

const dir = mkdtempSync(join(tmpdir(), "gauge-route-"))
process.env.COMPANION_DB_PATH ??= join(dir, "test.db")
// Whichever test file asked first fixed the token (lib/auth.ts caches it).
process.env.COMPANION_AUTH_TOKEN ??= "gauge-test-token-0123456789abcdef"
const TOKEN = getAuthToken()

type Route = (req: Request, url: URL) => Promise<Response | null>
let routes: Route[]
let gauge: typeof import("../wiring/gauge").gauge
let server: { port: number; stop(force?: boolean): void }
const frames: Array<Record<string, unknown>> = []
const fake = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Parameters<typeof clients.add>[0]

beforeAll(async () => {
  // Same order as the server's route chain.
  routes = [(await import("./hooks")).handleHookRoute, (await import("./gauge")).handleGaugeRoute]
  gauge = (await import("../wiring/gauge")).gauge
  const { createCompanionServer } = await import("../companion-server")
  server = createCompanionServer(0) as unknown as { port: number; stop(force?: boolean): void }
  clients.add(fake)
})
afterAll(() => {
  clients.delete(fake)
  gauge.stop()
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

const gaugeFrames = (key: string) => frames.filter((f) => f.type === "gauge" && f.sessionKey === key)

describe("POST /hooks/gauge", () => {
  test("loopback accepted; frame emitted under the registry key", async () => {
    const s = recordSession({ cwd: "/tmp/g-a", sessionId: "g-sid-a", tty: "/dev/ttys701" })!
    const res = await hook("/hooks/gauge", {
      session_id: "g-sid-a", cwd: "/tmp/g-a", ctx_tokens: 412000, ctx_window: 1000000, ctx_percent: 41,
      five_hour_percent: 23.5, five_hour_resets_at: "2026-10-06T19:00:00Z", seven_day_percent: 12, at: 1791230000000,
    })
    expect(res!.status).toBe(200)
    expect(await res!.json()).toEqual({ ok: true })
    expect(s.key).toBe("claude:tty:/dev/ttys701")
    expect(gaugeFrames(s.key).at(-1)).toEqual({
      type: "gauge", sessionKey: s.key, ctxTokens: 412000, ctxWindow: 1000000, ctxPercent: 41, source: "mod", at: 1791230000000,
      account: { fiveHourPercent: 23.5, fiveHourResetsAt: "2026-10-06T19:00:00Z", sevenDayPercent: 12, limits: [], at: 1791230000000 },
    })
  })

  test("off-box without bearer → 403; with bearer → 200", async () => {
    expect((await hook("/hooks/gauge", { session_id: "g-x" }, "192.168.1.50"))!.status).toBe(403)
    expect((await hook("/hooks/gauge", { session_id: "g-x" }, "100.64.1.2"))!.status).toBe(403)
    expect((await hook("/hooks/gauge", { session_id: "g-x" }, "192.168.1.50", { authorization: `Bearer ${TOKEN}` }))!.status).toBe(200)
  })

  test("validation: bad JSON / missing session_id → 400; partial body → 200", async () => {
    const bad = await hook("/hooks/gauge", "{nope")
    expect(bad!.status).toBe(400)
    expect(await bad!.json()).toEqual({ ok: false, error: "invalid_json" })
    const noSid = await hook("/hooks/gauge", { ctx_percent: 5 })
    expect(noSid!.status).toBe(400)
    expect(await noSid!.json()).toEqual({ ok: false, error: "session_id_required" })
    recordSession({ cwd: "/tmp/g-p", sessionId: "g-sid-p", tty: "/dev/ttys702" })
    expect((await hook("/hooks/gauge", { session_id: "g-sid-p", ctx_tokens: 50000 }))!.status).toBe(200)
    expect(gauge.snapshot().sessions.find((x) => x.sessionKey === "claude:tty:/dev/ttys702"))
      .toMatchObject({ ctxTokens: 50000, ctxWindow: 200000, ctxPercent: 25, source: "mod" })
  })
})

describe("transcript fallback + session end", () => {
  test("Stop with no mod report derives ctx from the transcript; SessionEnd drops it", async () => {
    const transcript = join(dir, "t.jsonl")
    writeFileSync(transcript, [
      { type: "user", message: { content: "hi" }, timestamp: "2026-10-06T10:00:00Z" },
      { type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 1000, cache_read_input_tokens: 80000, cache_creation_input_tokens: 2000 }, content: [{ type: "text", text: "ok" }] }, timestamp: "2026-10-06T10:00:01Z" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n")
    const headers = { "x-companion-tty": "/dev/ttys703" }
    await hook("/hooks/stop", { session_id: "g-sid-t", cwd: "/tmp/g-t", transcript_path: transcript, last_assistant_message: "ok" }, "127.0.0.1", headers)
    const key = "claude:tty:/dev/ttys703"
    for (let i = 0; i < 50 && !gauge.snapshot().sessions.some((x) => x.sessionKey === key); i++) await Bun.sleep(10)
    expect(gauge.snapshot().sessions.find((x) => x.sessionKey === key))
      .toMatchObject({ ctxTokens: 83000, ctxWindow: 200000, ctxPercent: 42, source: "transcript" })
    expect(gaugeFrames(key).at(-1)).toMatchObject({ source: "transcript", ctxPercent: 42 })

    await hook("/hooks/session-end", { session_id: "g-sid-t", cwd: "/tmp/g-t", reason: "exit" }, "127.0.0.1", headers)
    expect(gauge.snapshot().sessions.some((x) => x.sessionKey === key)).toBe(false)
    for (let i = 0; i < 300 && gaugeFrames(key).at(-1)?.source !== null; i++) await Bun.sleep(10) // trailing throttle ≤ 2 s
    expect(gaugeFrames(key).at(-1)).toMatchObject({ sessionKey: key, ctxTokens: null, ctxPercent: null, source: null })
  })

  test("a fresh mod report blocks the fallback", async () => {
    recordSession({ cwd: "/tmp/g-m", sessionId: "g-sid-m", tty: "/dev/ttys704" })
    await hook("/hooks/gauge", { session_id: "g-sid-m", ctx_tokens: 600000, ctx_window: 1000000, ctx_percent: 60 })
    const transcript = join(dir, "t2.jsonl")
    writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 5 } } }) + "\n")
    await hook("/hooks/stop", { session_id: "g-sid-m", cwd: "/tmp/g-m", transcript_path: transcript, last_assistant_message: "ok" }, "127.0.0.1", { "x-companion-tty": "/dev/ttys704" })
    await Bun.sleep(50)
    expect(gauge.snapshot().sessions.find((x) => x.sessionKey === "claude:tty:/dev/ttys704"))
      .toMatchObject({ source: "mod", ctxTokens: 600000 })
  })
})

describe("rate_limits", () => {
  test("mod rate_limits land on account.limits in the frame and GET", async () => {
    recordSession({ cwd: "/tmp/g-l", sessionId: "g-sid-l", tty: "/dev/ttys705" })
    const res = await hook("/hooks/gauge", {
      session_id: "g-sid-l", ctx_tokens: 1000, ctx_window: 200000, ctx_percent: 1, at: 1791230000500,
      rate_limits: [
        { kind: "five_hour", percent_used: 23.5, resets_at: "2026-10-06T19:00:00Z" },
        { kind: "seven_day_opus", percent_used: 31, resets_at: null },
        { kind: "brand_new_kind", percent_used: 1 },
      ],
    })
    expect(res!.status).toBe(200)
    const want = [
      { kind: "five_hour", percentUsed: 23.5, resetsAt: "2026-10-06T19:00:00Z" },
      { kind: "seven_day_opus", percentUsed: 31, resetsAt: null },
      { kind: "brand_new_kind", percentUsed: 1, resetsAt: null },
    ]
    expect((gaugeFrames("claude:tty:/dev/ttys705").at(-1)!.account as { limits: unknown }).limits).toEqual(want)
    expect(gauge.snapshot().account?.limits).toEqual(want)
    // A mistyped rate_limits is ignored (keeps the last array), never a 400.
    expect((await hook("/hooks/gauge", { session_id: "g-sid-l", rate_limits: "nope", at: 1791230000600 }))!.status).toBe(200)
    expect(gauge.snapshot().account?.limits).toEqual(want)
  })
})

describe("GET /api/gauge", () => {
  test("bearer required; shape", async () => {
    const url = `http://127.0.0.1:${server.port}/api/gauge`
    expect((await fetch(url)).status).toBe(401)
    expect((await fetch(url, { headers: { authorization: "Bearer wrong-token-wrong-token-xx" } })).status).toBe(401)
    const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; account: Record<string, unknown> | null; sessions: Array<Record<string, unknown>> }
    expect(body.ok).toBe(true)
    expect(Object.keys(body.account!).sort()).toEqual(["at", "fiveHourPercent", "fiveHourResetsAt", "limits", "sevenDayPercent"])
    const a = body.sessions.find((x) => x.sessionKey === "claude:tty:/dev/ttys701")!
    expect(a).toEqual({ sessionKey: "claude:tty:/dev/ttys701", ctxTokens: 412000, ctxWindow: 1000000, ctxPercent: 41, source: "mod", at: 1791230000000 })
  })
})

describe("contracts/gauge fixtures", () => {
  const fixture = (f: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "contracts", "gauge", f), "utf8")) as Record<string, unknown>
  const keysOf = (o: unknown) => Object.keys(o as object).sort()

  test("live frame, cleared frame and GET body carry the fixture keys", async () => {
    const live = gaugeFrames("claude:tty:/dev/ttys701").find((f) => f.source === "mod")!
    expect(keysOf(live)).toEqual(keysOf(fixture("frame.json")))
    expect(keysOf(live.account)).toEqual(keysOf(fixture("frame.json").account))
    const limit = (gauge.snapshot().account?.limits ?? [])[0]
    expect(keysOf(limit)).toEqual(keysOf(((fixture("frame.json").account as { limits: unknown[] }).limits)[0]))
    const cleared = gaugeFrames("claude:tty:/dev/ttys703").find((f) => f.source === null)!
    expect(keysOf(cleared)).toEqual(keysOf(fixture("frame.cleared.json")))
    const api = gauge.snapshot()
    const want = fixture("api.json")
    expect(keysOf(api)).toEqual(keysOf(want))
    expect(keysOf(api.sessions[0])).toEqual(keysOf((want.sessions as unknown[])[0]))
  })
})
