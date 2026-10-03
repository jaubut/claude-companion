import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ApnsPayload } from "../lib/apns"
import type { BodyResponse, BodySnapshot } from "../lib/body"
import { type QueryFn, TursoUnreachable } from "../lib/turso"

// Route level: real orchestrator store (isolated sqlite), fake push sender,
// captured WS frames, fake Turso through the QueryFn seam. The 401 lives in
// the server's /api/* gate.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-body-")), "companion.db")

type Mod = typeof import("./body")
type Wiring = typeof import("../wiring/body")
type Chat = typeof import("../lib/orchestrator-chat") & typeof import("../lib/orchestrator-channels")
let routes: Mod
let wiring: Wiring
let chat: Chat

beforeAll(async () => {
  chat = { ...(await import("../lib/orchestrator-chat")), ...(await import("../lib/orchestrator-channels")) }
  wiring = await import("../wiring/body")
  routes = await import("./body")
})

function rig(enabled = true) {
  const frames: Record<string, unknown>[] = []
  const pushes: ApnsPayload[] = []
  const sink = wiring.createBodyAlertSink({
    appendTurn: (text) => chat.appendTurn("orchestrator", text, null, "body"),
    ensureChannel: () => chat.ensureChannel("body", "Body"),
    broadcast: (f) => frames.push(f),
    push: (p) => pushes.push(p),
    pushEnabled: () => enabled,
    now: () => Date.UTC(2026, 9, 3, 12),
    schedule: () => {},
  })
  const handler = routes.createBodyHandler({ sink, query: async () => [], snapshot: { get: async () => { throw new Error("unused") } } })
  return { frames, pushes, handler }
}

async function call(handler: ReturnType<Mod["createBodyHandler"]>, method: string, path: string, body?: unknown): Promise<Response | null> {
  const req = new Request(`http://localhost${path}`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) })
  return handler(req, new URL(req.url))
}

describe("POST /api/body/alert", () => {
  test("turn in #Body (created once) + push + body_alert frame", async () => {
    const { frames, pushes, handler } = rig()
    const res = await call(handler, "POST", "/api/body/alert", { component_id: "mac:launchd:backup", severity: "critical", title: "backup dead", message: "exit 1", state: "dead", from_state: "failing" })
    expect(res?.status).toBe(200)
    expect(await res!.json()).toEqual({ ok: true })

    const thread = chat.getThread("body")
    expect(thread.at(-1)).toMatchObject({ role: "orchestrator", text: "backup dead\nexit 1", threadId: "body", taskId: null })
    expect(chat.getChannel("body")).toMatchObject({ name: "Body", autoDispatch: false })

    expect(frames.map((f) => f.type)).toEqual(["orchestrator_channel", "orchestrator", "body_alert"])
    expect(frames[2]).toEqual({
      type: "body_alert",
      alert: { component_id: "mac:launchd:backup", severity: "critical", title: "backup dead", message: "exit 1", state: "dead", from_state: "failing", at: "2026-10-03T12:00:00.000Z" },
    })
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ title: "backup dead", body: "exit 1", collapseId: "body-mac:launchd:backup", userInfo: { kind: "body_alert", component_id: "mac:launchd:backup" } })

    // Second alert: channel already exists → no channel frame; rate-limited → no push.
    await call(handler, "POST", "/api/body/alert", { component_id: "mac:launchd:backup", severity: "warning", title: "still dead", message: "exit 1" })
    expect(frames.map((f) => f.type).slice(3)).toEqual(["orchestrator", "body_alert"])
    expect(pushes).toHaveLength(1)
  })

  test("info: turn + frame, no push", async () => {
    const { frames, pushes, handler } = rig()
    await call(handler, "POST", "/api/body/alert", { component_id: "mac:cron:x", severity: "info", title: "x recovered", message: "ok again", state: "ok" })
    expect(pushes).toHaveLength(0)
    expect(frames.some((f) => f.type === "body_alert")).toBe(true)
  })

  test("pushes for any host prefix when enabled; none when disabled (no sender or COMPANION_BODY_PUSH=0)", async () => {
    const on = rig(true)
    for (const id of ["zettlab:systemd:kb-api", "mac:launchd:y", "cloud:cron:x"]) {
      await call(on.handler, "POST", "/api/body/alert", { component_id: id, severity: "critical", title: "t", message: "m" })
    }
    expect(on.pushes.map((p) => p.userInfo?.component_id)).toEqual(["zettlab:systemd:kb-api", "mac:launchd:y", "cloud:cron:x"])
    const off = rig(false)
    await call(off.handler, "POST", "/api/body/alert", { component_id: "mac:launchd:z", severity: "critical", title: "t", message: "m" })
    expect(off.pushes).toHaveLength(0)
    expect(off.frames.filter((f) => f.type === "body_alert")).toHaveLength(1) // still local turn + frame
  })

  test("400 on missing fields / bad JSON; nothing recorded", async () => {
    const { frames, handler } = rig()
    const before = chat.getThread("body").length
    for (const body of [{ severity: "critical", title: "t", message: "m" }, { component_id: "a", title: "t", message: "m" }, { component_id: "a", severity: "info", message: "m" }, { component_id: "a", severity: "info", title: "t" }, "{nope"]) {
      const res = await call(handler, "POST", "/api/body/alert", body)
      expect(res?.status).toBe(400)
      expect(((await res!.json()) as { ok: boolean }).ok).toBe(false)
    }
    expect(frames).toHaveLength(0)
    expect(chat.getThread("body").length).toBe(before)
  })

  test("other paths / methods → null", async () => {
    const { handler } = rig()
    expect(await call(handler, "GET", "/api/body/alert")).toBeNull()
    expect(await call(handler, "POST", "/api/body")).toBeNull()
    expect(await call(handler, "GET", "/api/bodyx")).toBeNull()
  })
})

describe("GET /api/body + /api/body/component/:id", () => {
  const snapshotBody: BodyResponse = {
    ok: true, generated_at: "2026-10-03T12:00:00.000Z", components: [], recent_events: [],
    summary: { ok: 0, failing: 0, dead: 0, crash_loop: 0, dormant: 0, stopped: 0, unknown: 0, total: 0 },
  }

  test("passes all/fresh to the snapshot", async () => {
    const seen: unknown[] = []
    const snapshot: BodySnapshot = { get: async (o) => { seen.push(o); return snapshotBody } }
    const handler = routes.createBodyHandler({ snapshot, query: async () => [] })
    const res = await call(handler, "GET", "/api/body?all=1&fresh=1")
    expect(await res!.json()).toEqual(snapshotBody)
    await call(handler, "GET", "/api/body")
    expect(seen).toEqual([{ all: true, fresh: true }, { all: false, fresh: false }])
  })

  test("component id with colons, encoded or raw; 404 unknown", async () => {
    const asked: unknown[] = []
    const query: QueryFn = async (sql, args) => {
      if (sql.includes("WHERE id = ?")) { asked.push(args[0]); return args[0] === "zettlab:zfs:tank" ? [{ id: "zettlab:zfs:tank", retired: 0 }] : [] }
      return []
    }
    const handler = routes.createBodyHandler({ query, now: () => 0, snapshot: { get: async () => snapshotBody } })
    const enc = await call(handler, "GET", "/api/body/component/zettlab%3Azfs%3Atank")
    expect(enc?.status).toBe(200)
    const d = (await enc!.json()) as { component: { id: string }; vitals: unknown; events: unknown[] }
    expect(d.component.id).toBe("zettlab:zfs:tank")
    expect(d.vitals).toBeNull()
    expect((await call(handler, "GET", "/api/body/component/zettlab:zfs:tank"))?.status).toBe(200)
    expect(asked).toEqual(["zettlab:zfs:tank", "zettlab:zfs:tank"])
    expect((await call(handler, "GET", "/api/body/component/nope"))?.status).toBe(404)
    expect((await call(handler, "GET", "/api/body/component/%E0%A4%A"))?.status).toBe(400)
  })

  test("Turso down → 503 turso_unreachable", async () => {
    const down: QueryFn = async () => { throw new TursoUnreachable("network") }
    const handler = routes.createBodyHandler({ query: down, snapshot: { get: async () => { throw new TursoUnreachable("network") } } })
    for (const path of ["/api/body", "/api/body/component/a:b"]) {
      const res = await call(handler, "GET", path)
      expect(res?.status).toBe(503)
      expect(await res!.json()).toEqual({ ok: false, error: "turso_unreachable" })
    }
  })
})

describe("brain digest wiring", () => {
  const body: BodyResponse = {
    ok: true, generated_at: "g", recent_events: [],
    components: [{ id: "zettlab:systemd:kb-api", host: "zettlab", kind: "systemd", name: "kb-api", criticality: "high", state: "dead", last_run_at: null, last_ok_at: null, last_exit: 1, consecutive_failures: 2, detail: null, depends_on: [], dependents_count: 0 }],
    summary: { ok: 0, failing: 0, dead: 1, crash_loop: 0, dormant: 0, stopped: 0, unknown: 0, total: 1 },
  }
  const snap: BodySnapshot = { get: async () => body }

  test("#Body always gets the digest; other channels only on health intent", async () => {
    expect(await wiring.bodyDigestFor("body", "hello", snap)).toContain("zettlab:systemd:kb-api [high] dead")
    expect(await wiring.bodyDigestFor("general", "what's broken?", snap)).toContain("1 dead")
    expect(await wiring.bodyDigestFor("general", "refactor goals.ts", snap)).toBeNull()
  })

  test("brain prompt carries the digest only when there is one", async () => {
    const { contextLines } = await import("../lib/orchestrator-brain")
    expect(contextLines(null)).toEqual([])
    expect(contextLines("  ")).toEqual([])
    expect(contextLines("Body monitor: 1 dead")[1]).toBe("Body monitor: 1 dead")
  })

  test("unreachable Turso becomes a one-line note, never a throw", async () => {
    const bad: BodySnapshot = { get: async () => { throw new TursoUnreachable("network") } }
    expect(await wiring.bodyDigestFor("body", "system status", bad)).toStartWith("Body monitor: unreachable")
  })
})
