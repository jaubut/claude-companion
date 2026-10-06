import { describe, expect, test } from "bun:test"
import type { QueryFn, Row, SqlArg } from "./turso"
import {
  humanDetail,
  BODY_CACHE_TTL_MS, DIGEST_MAX, type BodyResponse, buildBody, buildBodyDigest, buildComponentDetail,
  createBodySnapshot, dependentsIndex, emptySummary, isHealthIntent, parseDependsOn, toState, vitalsHeader,
} from "./body"

// Pure read model against fake Turso rows (the QueryFn seam) — no network.

interface Comp { id: string; host?: string; kind?: string; name?: string; criticality?: string; depends_on?: string | null; retired?: number; schedule_s?: number; notes?: string }
interface Vit { component_id: string; observed_at: string; state: string; consecutive_failures?: number; detail?: string; last_ok_at?: string }
interface Ev { id: number; component_id: string; at: string; kind: string; from_state: string; to_state: string; detail?: string }

function fakeTurso(comps: Comp[], vitals: Vit[], events: Ev[]) {
  const calls: { sql: string; args: SqlArg[] }[] = []
  const latest = (id: string) => vitals.filter((v) => v.component_id === id).sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0]
  const compRow = (c: Comp): Row => ({ host: null, kind: null, name: null, criticality: null, depends_on: null, retired: 0, schedule_s: null, notes: null, first_seen: null, last_seen: null, ...c })
  const query: QueryFn = async (sql, args) => {
    calls.push({ sql, args })
    if (sql.includes("LEFT JOIN body_vitals")) {
      return comps.map((c) => {
        const v = latest(c.id)
        return { ...compRow(c), state: v?.state ?? null, last_run_at: null, last_ok_at: v?.last_ok_at ?? null, last_exit: null, consecutive_failures: v?.consecutive_failures ?? null, detail: v?.detail ?? null }
      })
    }
    if (sql.startsWith("SELECT id, component_id, at") && sql.includes("WHERE component_id = ?")) {
      return events.filter((e) => e.component_id === args[0]).sort((a, b) => b.at.localeCompare(a.at)).slice(0, Number(args[1])) as unknown as Row[]
    }
    if (sql.includes("FROM body_events")) return [...events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, Number(args[0])) as unknown as Row[]
    if (sql.includes("FROM body_components WHERE id = ?")) return comps.filter((c) => c.id === args[0]).map(compRow)
    if (sql.includes("FROM body_vitals WHERE component_id = ?")) {
      const v = latest(String(args[0]))
      return v ? [{ last_exit: 0, last_run_at: null, runs_total: 10, runs_delta: 1, detail: null, ...v } as unknown as Row] : []
    }
    if (sql.startsWith("SELECT id, depends_on, retired")) return comps.map(compRow)
    throw new Error(`unexpected sql ${sql}`)
  }
  return { query, calls }
}

const COMPS: Comp[] = [
  { id: "mac:launchd:backup", host: "mac", kind: "launchd", name: "backup", criticality: "critical", depends_on: '["zettlab:zfs:tank"]' },
  { id: "zettlab:zfs:tank", host: "zettlab", kind: "zfs", name: "tank", criticality: "critical" },
  { id: "zettlab:systemd:kb-api", host: "zettlab", kind: "systemd", name: "kb-api", criticality: "high", depends_on: '["zettlab:zfs:tank","zettlab:zfs:tank"]' },
  { id: "cloud:cron:old", host: "cloud", kind: "cron", name: "old", retired: 1, depends_on: '["zettlab:zfs:tank"]' },
  { id: "mac:cron:nostate", host: "mac", kind: "cron", name: "nostate", depends_on: "not json" },
]
const VITALS: Vit[] = [
  { component_id: "mac:launchd:backup", observed_at: "2026-10-03T10:00:00Z", state: "ok" },
  { component_id: "mac:launchd:backup", observed_at: "2026-10-03T11:00:00Z", state: "failing", consecutive_failures: 3, detail: "exit 1" },
  { component_id: "zettlab:zfs:tank", observed_at: "2026-10-03T11:00:00Z", state: "ok" },
  { component_id: "zettlab:systemd:kb-api", observed_at: "2026-10-03T11:00:00Z", state: "dead", consecutive_failures: 9, last_ok_at: "2026-10-02T09:00:00Z" },
  { component_id: "cloud:cron:old", observed_at: "2026-10-01T11:00:00Z", state: "stopped" },
]
const EVENTS: Ev[] = Array.from({ length: 60 }, (_, i) => ({
  id: i, component_id: i % 2 ? "mac:launchd:backup" : "zettlab:systemd:kb-api",
  at: `2026-10-03T${String(10 + Math.floor(i / 60)).padStart(2, "0")}:${String(i).padStart(2, "0")}:00Z`, kind: "transition", from_state: "ok", to_state: "failing",
}))

describe("GET /api/body read model", () => {
  test("shape, summary, retired excluded, dependents_count from live components only", async () => {
    const { query } = fakeTurso(COMPS, VITALS, EVENTS)
    const body = await buildBody(query, { now: () => 0 })
    expect(body.ok).toBe(true)
    expect(body.generated_at).toBe(new Date(0).toISOString())
    expect(body.components.map((c) => c.id)).toEqual(["mac:launchd:backup", "zettlab:zfs:tank", "zettlab:systemd:kb-api", "mac:cron:nostate"])
    expect(body.summary).toEqual({ ok: 1, warning: 0, failing: 1, dead: 1, crash_loop: 0, dormant: 0, stopped: 0, unknown: 1, total: 4 })
    const tank = body.components.find((c) => c.id === "zettlab:zfs:tank")!
    expect(tank.dependents_count).toBe(2) // backup + kb-api (deduped); retired cloud:cron:old not counted
    const backup = body.components[0]!
    expect(backup).toEqual({
      id: "mac:launchd:backup", host: "mac", kind: "launchd", name: "backup", criticality: "critical", state: "failing",
      last_run_at: null, last_ok_at: null, last_exit: null, consecutive_failures: 3, detail: "exit 1",
      depends_on: ["zettlab:zfs:tank"], dependents_count: 0,
    })
    expect(body.components.find((c) => c.id === "mac:cron:nostate")!.depends_on).toEqual([])
    expect(body.recent_events).toHaveLength(50)
    expect(Object.keys(body.recent_events[0]!).sort()).toEqual(["at", "component_id", "detail", "from_state", "id", "kind", "to_state"])
  })

  test("?all=1 includes retired components", async () => {
    const { query } = fakeTurso(COMPS, VITALS, [])
    const body = await buildBody(query, { all: true })
    expect(body.components.map((c) => c.id)).toContain("cloud:cron:old")
    expect(body.summary.stopped).toBe(1)
    expect(body.summary.total).toBe(5)
  })

  test("queries are parameterized (events limit is an arg)", async () => {
    const { query, calls } = fakeTurso(COMPS, VITALS, EVENTS)
    await buildBody(query)
    expect(calls.find((c) => c.sql.includes("FROM body_events"))!.args).toEqual([50])
  })

  test("helpers: state, depends_on, dependents index", () => {
    expect(toState("CRASH_LOOP")).toBe("crash_loop")
    expect(toState("weird")).toBe("unknown")
    expect(toState("warning")).toBe("warning")
    expect(toState("WARNING")).toBe("warning")
    expect(toState(null)).toBe("unknown")
    expect(parseDependsOn('["a", 3, "", "b"]')).toEqual(["a", "b"])
    expect(parseDependsOn('{"a":1}')).toEqual([])
    expect(dependentsIndex([{ id: "x", depends_on: '["y"]', retired: "0" }, { id: "z", depends_on: '["y"]', retired: 1 }]).get("y")).toEqual(["x"])
  })
})

describe("GET /api/body/component/:id read model", () => {
  test("component id with colons: component + latest vitals + its last 50 events", async () => {
    const { query, calls } = fakeTurso(COMPS, VITALS, EVENTS)
    const d = (await buildComponentDetail(query, "zettlab:zfs:tank", () => 0))!
    expect(calls[0]!.args).toEqual(["zettlab:zfs:tank"])
    expect(d.component.id).toBe("zettlab:zfs:tank")
    expect(d.component.dependents.sort()).toEqual(["mac:launchd:backup", "zettlab:systemd:kb-api"])
    expect(d.component.dependents_count).toBe(2)
    expect(d.component.retired).toBe(false)
    expect(d.vitals?.state).toBe("ok")
    expect(d.events).toEqual([])

    const b = (await buildComponentDetail(query, "mac:launchd:backup"))!
    expect(b.vitals).toMatchObject({ component_id: "mac:launchd:backup", state: "failing", consecutive_failures: 3, observed_at: "2026-10-03T11:00:00Z", runs_total: 10 })
    expect(b.events).toHaveLength(30)
    expect(b.events.every((e) => e.component_id === "mac:launchd:backup")).toBe(true)
  })

  test("unknown component → null", async () => {
    const { query } = fakeTurso(COMPS, VITALS, EVENTS)
    expect(await buildComponentDetail(query, "nope:x")).toBeNull()
  })
})

describe("snapshot cache", () => {
  test("30 s TTL per all-flag, fresh bypasses", async () => {
    const { query, calls } = fakeTurso(COMPS, VITALS, [])
    let t = 1_000
    const snap = createBodySnapshot(query, () => t)
    await snap.get()
    await snap.get()
    expect(calls.length).toBe(2) // one build = components + events
    await snap.get({ all: true })
    expect(calls.length).toBe(4)
    t += BODY_CACHE_TTL_MS - 1
    await snap.get()
    expect(calls.length).toBe(4)
    await snap.get({ fresh: true })
    expect(calls.length).toBe(6)
    t += BODY_CACHE_TTL_MS
    await snap.get()
    expect(calls.length).toBe(8)
  })
})

describe("brain digest", () => {
  test("summary line + problems ordered by criticality, recent changes", async () => {
    const { query } = fakeTurso(COMPS, VITALS, EVENTS)
    const digest = buildBodyDigest(await buildBody(query, { now: () => 0 }))
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX)
    expect(digest).toContain("4 components — 1 ok, 1 failing, 1 dead, 1 unknown.")
    const lines = digest.split("\n")
    expect(lines[2]).toStartWith("- mac:launchd:backup [critical] failing, 3 fails — exit 1")
    expect(lines[3]).toStartWith("- zettlab:systemd:kb-api [high] dead, 9 fails, last ok 2026-10-02T09:00:00Z")
    expect(digest).toContain("Recent changes:")
    expect(digest).not.toContain("tank") // ok components are only counted
  })

  test("stays ≤ 800 chars with many problems and reports the overflow", () => {
    const components = Array.from({ length: 80 }, (_, i) => ({
      id: `zettlab:systemd:service-number-${i}`, host: "zettlab", kind: "systemd", name: `s${i}`, criticality: i === 79 ? "critical" : "low",
      state: "dead" as const, last_run_at: null, last_ok_at: null, last_exit: 1, consecutive_failures: 4, detail: "x".repeat(200),
      depends_on: [], dependents_count: 0,
    }))
    const body: BodyResponse = {
      ok: true, generated_at: "2026-10-03T12:00:00.000Z", components, recent_events: [],
      summary: { ok: 0, warning: 0, failing: 0, dead: 80, crash_loop: 0, dormant: 0, stopped: 0, unknown: 0, total: 80 },
    }
    const digest = buildBodyDigest(body)
    expect(digest.length).toBeLessThanOrEqual(DIGEST_MAX)
    expect(digest.split("\n")[2]).toStartWith("- zettlab:systemd:service-number-79 [critical]")
    expect(digest).toMatch(/\(\+\d+ more not ok\)/)
  })

  test("all healthy", () => {
    const body: BodyResponse = { ok: true, generated_at: "t", components: [], recent_events: [], summary: { ok: 3, warning: 0, failing: 0, dead: 0, crash_loop: 0, dormant: 0, stopped: 0, unknown: 0, total: 3 } }
    expect(buildBodyDigest(body)).toBe("Body monitor (as of t): 3 components — 3 ok.\nNothing failing, dead or crash-looping.")
  })
})

describe("health intent predicate", () => {
  for (const t of [
    "how's the body?", "How’s the body", "what's broken", "anything down?", "system status", "status of the servers",
    "status of the system", "is everything ok?", "is the server up?", "health check", "body report", "any outages today?",
    "qu'est-ce qui est brisé", "est-ce que tout roule?", "état du système", "quelque chose en panne?",
  ]) {
    test(`yes: ${t}`, () => expect(isHealthIntent(t)).toBe(true))
  }
  for (const t of [
    "update the README", "fix the request body parser", "write down the plan", "dispatch a worker to refactor goals.ts",
    "status", "status of project X", "what's the status on the Pelchat quote", "status of the invoice", "statut du projet Granby",
  ]) {
    test(`no: ${t}`, () => expect(isHealthIntent(t)).toBe(false))
  }
})

describe("warning state (token-burn spikes)", () => {
  test("normalized as warning, counted in summary, never a problem", async () => {
    const { query } = fakeTurso(
      [{ id: "zettlab:tokens:burn", host: "zettlab", kind: "tokens", name: "burn" }, { id: "mac:cron:a", host: "mac" }],
      [{ component_id: "zettlab:tokens:burn", observed_at: "2026-10-05T10:00:00Z", state: "warning" }, { component_id: "mac:cron:a", observed_at: "2026-10-05T10:00:00Z", state: "ok" }],
      [],
    )
    const body = await buildBody(query)
    expect(body.components.find((c) => c.id === "zettlab:tokens:burn")!.state).toBe("warning")
    expect(body.summary).toEqual({ ...emptySummary(), ok: 1, warning: 1, total: 2 })
    expect(buildBodyDigest(body)).toContain("1 warning")
    expect(buildBodyDigest(body)).toContain("Nothing failing, dead or crash-looping.")
    const v = vitalsHeader(body, 0)
    expect(v.worst).toBe("warning")
    expect(v.problems).toBe(0)
    expect(v.line).toBe("2 components: 1 ok · 1 warning")
  })

  test("worst ranks failing > warning > unknown", () => {
    const mk = (s: Partial<ReturnType<typeof emptySummary>>): BodyResponse => ({ ok: true, generated_at: "t", components: [], recent_events: [], summary: { ...emptySummary(), ...s } })
    expect(vitalsHeader(mk({ warning: 1, unknown: 1, stopped: 1, dormant: 1, ok: 1 }), 0).worst).toBe("warning")
    expect(vitalsHeader(mk({ warning: 1, failing: 1 }), 0).worst).toBe("failing")
    expect(vitalsHeader(mk({ unknown: 1, stopped: 1 }), 0).worst).toBe("unknown")
  })
})

describe("humanDetail (JSON vitals detail → text every client shows)", () => {
  test("tokens:burn JSON → its warning text", () => {
    const raw = JSON.stringify({ warning: "today 1003.4M > 2x 7-day avg 449.0M", today_total: 1003428589, top_sessions: [{ session_id: "0509", tokens: 1 }] })
    expect(humanDetail(raw)).toBe("today 1003.4M > 2x 7-day avg 449.0M")
  })
  test("warning + error are joined", () => {
    expect(humanDetail(JSON.stringify({ warning: "spike", error: "push failed: 503" }))).toBe("spike; push failed: 503")
  })
  test("plain text, JSON without warning/error, invalid JSON and null pass unchanged", () => {
    expect(humanDetail("exit 1")).toBe("exit 1")
    const noMsg = JSON.stringify({ today_total: 5 })
    expect(humanDetail(noMsg)).toBe(noMsg)
    expect(humanDetail("{not json")).toBe("{not json")
    expect(humanDetail(null)).toBeNull()
    expect(humanDetail(undefined)).toBeNull()
    expect(humanDetail(3)).toBe(3)
  })
})
