import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COOLDOWN_MS, MAX_CONCURRENT, MAX_PER_DAY, RETRY_MS, createInvestigationStore, disabledFlagPath, gate, hostFromId, investigateEnabled,
  investigationDigest, investigationDto, localBodyHost, ownerHost, routeFor,
} from "./body-investigate"

// Policy + store over an in-memory sqlite (the store takes its Database).

const T0 = Date.UTC(2026, 9, 4, 12)
const mem = () => createInvestigationStore(new Database(":memory:"))
const res = (rootCause = "rc") => ({ rootCause, evidence: ["e"], confidence: 0.8, severity: "med" as const, recommendedFix: null, retire: false, notes: "" })

function finish(store: ReturnType<typeof mem>, componentId: string, state: string, status: "done" | "failed", at: number) {
  const r = store.insert({ componentId, host: "mac", state, trigger: "sweep", status: "running", runOn: "local", attempt: 1, startedAt: at }, at)
  store.update(r.id, { status, finishedAt: at, result: status === "done" ? res() : null, error: status === "failed" ? "boom" : null })
  return r.id
}

describe("trigger + dedupe", () => {
  test("only dead / crash_loop / failing pass", () => {
    const s = mem()
    for (const state of ["dead", "crash_loop", "failing"]) expect(gate(s, { componentId: "a", state }, T0, { budget: true }).ok).toBe(true)
    for (const state of ["ok", "warning", "dormant", "stopped", "unknown", ""]) expect(gate(s, { componentId: "a", state }, T0, { budget: true })).toMatchObject({ ok: false, reason: "not a problem state" })
  })

  test("one open investigation per component", () => {
    const s = mem()
    s.insert({ componentId: "a", host: "mac", state: "dead", trigger: "alert", status: "running", runOn: "local", attempt: 1, startedAt: T0 }, T0)
    const v = gate(s, { componentId: "a", state: "dead" }, T0 + 1000, { budget: true })
    expect(v).toMatchObject({ ok: false, reason: "open (running)" })
    expect(gate(s, { componentId: "b", state: "dead" }, T0, { budget: true }).ok).toBe(true)
  })

  test("same-state repeat inside the 12 h cooldown is skipped; after it, allowed", () => {
    const s = mem()
    finish(s, "a", "dead", "done", T0)
    expect(gate(s, { componentId: "a", state: "dead", fromState: "dead" }, T0 + 60_000, { budget: true })).toMatchObject({ ok: false, reason: "cooldown" })
    expect(gate(s, { componentId: "a", state: "dead" }, T0 + COOLDOWN_MS - 1, { budget: true }).ok).toBe(false)
    expect(gate(s, { componentId: "a", state: "dead" }, T0 + COOLDOWN_MS, { budget: true }).ok).toBe(true)
  })

  test("a state change resets the cooldown (different state, or a real transition alert)", () => {
    const s = mem()
    finish(s, "a", "dead", "done", T0)
    expect(gate(s, { componentId: "a", state: "crash_loop" }, T0 + 60_000, { budget: true }).ok).toBe(true)
    expect(gate(s, { componentId: "a", state: "dead", fromState: "ok" }, T0 + 60_000, { budget: true }).ok).toBe(true)
  })

  test("one failure retries after 10 min (attempt 2); two failures cool down 12 h", () => {
    const s = mem()
    finish(s, "a", "dead", "failed", T0)
    expect(gate(s, { componentId: "a", state: "dead" }, T0 + RETRY_MS - 1, { budget: true })).toMatchObject({ ok: false, reason: "retry later" })
    expect(gate(s, { componentId: "a", state: "dead" }, T0 + RETRY_MS, { budget: true })).toMatchObject({ ok: true, attempt: 2 })
    finish(s, "a", "dead", "failed", T0 + RETRY_MS)
    expect(s.consecutiveFailures("a", "dead")).toBe(2)
    expect(gate(s, { componentId: "a", state: "dead" }, T0 + 2 * RETRY_MS, { budget: true })).toMatchObject({ ok: false, reason: "cooldown (failed twice)" })
    expect(gate(s, { componentId: "a", state: "dead" }, T0 + RETRY_MS + COOLDOWN_MS, { budget: true })).toMatchObject({ ok: true, attempt: 1 })
  })

  test("a dropped record is not a verdict", () => {
    const s = mem()
    const r = s.insert({ componentId: "a", host: "mac", state: "dead", trigger: "sweep", status: "pending_host", runOn: "peer", attempt: 1 }, T0)
    s.update(r.id, { status: "dropped", finishedAt: T0 })
    expect(s.latestFinished("a")).toBeNull()
    expect(gate(s, { componentId: "a", state: "dead" }, T0 + 1, { budget: true }).ok).toBe(true)
  })

  test("pending_host is handed back for a re-forward (no-budget path only)", () => {
    const s = mem()
    const r = s.insert({ componentId: "a", host: "mac", state: "dead", trigger: "sweep", status: "pending_host", runOn: "peer", attempt: 1 }, T0)
    expect(gate(s, { componentId: "a", state: "dead" }, T0, { budget: false })).toMatchObject({ ok: true, retry: { id: r.id } })
    expect(gate(s, { componentId: "a", state: "dead" }, T0, { budget: true }).ok).toBe(false)
  })
})

describe("budgets + kill switch", () => {
  test("≤ 3 concurrent local runs", () => {
    const s = mem()
    for (let i = 0; i < MAX_CONCURRENT; i++) s.insert({ componentId: `c${i}`, host: "mac", state: "dead", trigger: "sweep", status: "running", runOn: "local", attempt: 1, startedAt: T0 }, T0)
    expect(gate(s, { componentId: "x", state: "dead" }, T0, { budget: true })).toMatchObject({ ok: false, reason: "busy (3 running)" })
    // A forward spends the owner's budget, not ours.
    expect(gate(s, { componentId: "x", state: "dead" }, T0, { budget: false }).ok).toBe(true)
  })

  test("≤ 10 started per rolling 24 h", () => {
    const s = mem()
    for (let i = 0; i < MAX_PER_DAY; i++) finish(s, `c${i}`, "dead", "done", T0 + i)
    expect(gate(s, { componentId: "x", state: "dead" }, T0 + 1000, { budget: true })).toMatchObject({ ok: false, reason: "daily budget spent (10/24h)" })
    expect(gate(s, { componentId: "x", state: "dead" }, T0 + 24 * 3600_000 + MAX_PER_DAY, { budget: true }).ok).toBe(true)
  })

  test("kill switch: env 0 or the flag file", () => {
    const home = "/h"
    expect(investigateEnabled({}, () => false, home)).toBe(true)
    expect(investigateEnabled({ COMPANION_BODY_INVESTIGATE: "0" }, () => false, home)).toBe(false)
    expect(investigateEnabled({ COMPANION_BODY_INVESTIGATE: "1" }, () => false, home)).toBe(true)
    expect(investigateEnabled({}, (p) => p === "/h/.claude-companion/.body-investigate-disabled", home)).toBe(false)
    expect(disabledFlagPath(home)).toBe("/h/.claude-companion/.body-investigate-disabled")
  })
})

describe("host routing", () => {
  test("owner + route", () => {
    expect(ownerHost("mac")).toBe("mac")
    expect(ownerHost("zettlab")).toBe("zettlab")
    expect(ownerHost("cloud")).toBe("zettlab")
    expect(ownerHost("pi")).toBeNull()
    expect(routeFor("zettlab", "zettlab")).toBe("local")
    expect(routeFor("cloud", "zettlab")).toBe("local")
    expect(routeFor("mac", "mac")).toBe("local")
    expect(routeFor("mac", "zettlab")).toBe("forward")
    expect(routeFor("zettlab", "mac")).toBe("not_owner")
    expect(routeFor("cloud", "mac")).toBe("not_owner")
    expect(routeFor(null, "zettlab")).toBe("not_owner")
  })

  test("host from id + local host", () => {
    expect(hostFromId("mac:launchd:com.x")).toBe("mac")
    expect(hostFromId("cloud:http:dash")).toBe("cloud")
    expect(hostFromId("weird")).toBeNull()
    expect(localBodyHost({}, "darwin")).toBe("mac")
    expect(localBodyHost({}, "linux")).toBe("zettlab")
    expect(localBodyHost({ COMPANION_BODY_HOST: "zettlab" }, "darwin")).toBe("zettlab")
  })
})

describe("store", () => {
  test("restart: a second store on the same file sees finished records (no re-run) and closes orphaned runs", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-inv-")), "c.db")
    const a = createInvestigationStore(new Database(file))
    finish(a, "done:x", "dead", "done", T0)
    a.insert({ componentId: "run:x", host: "mac", state: "dead", trigger: "sweep", status: "running", runOn: "local", attempt: 1, startedAt: T0 }, T0)
    const b = createInvestigationStore(new Database(file))
    expect(gate(b, { componentId: "done:x", state: "dead" }, T0 + 60_000, { budget: true })).toMatchObject({ ok: false, reason: "cooldown" })
    expect(b.closeInterrupted(T0 + 1)).toHaveLength(1)
    expect(b.latest("run:x")).toMatchObject({ status: "failed", error: "companion restarted mid-investigation" })
    expect(b.closeInterrupted(T0 + 2)).toHaveLength(0)
  })

  test("result round-trips; dto shape", () => {
    const s = mem()
    const id = finish(s, "a", "dead", "done", T0)
    s.update(id, { proposalId: "p1" })
    expect(investigationDto(s.get(id))).toEqual({
      id, status: "done", startedAt: new Date(T0).toISOString(), finishedAt: new Date(T0).toISOString(),
      rootCause: "rc", confidence: 0.8, severity: "med", proposalId: "p1", error: null,
    })
    expect(investigationDto(null)).toBeNull()
  })

  test("digest: open + recent, latest per component, capped", () => {
    const s = mem()
    expect(investigationDigest(s, T0)).toBeNull()
    finish(s, "mac:launchd:old", "dead", "done", T0 - 1000)
    const id = finish(s, "mac:launchd:old", "dead", "done", T0)
    s.update(id, { proposalId: "p9" })
    s.insert({ componentId: "zettlab:docker:x", host: "zettlab", state: "crash_loop", trigger: "alert", status: "running", runOn: "local", attempt: 1, startedAt: T0 }, T0)
    finish(s, "mac:launchd:failed", "failing", "failed", T0)
    const d = investigationDigest(s, T0 + 1)!
    expect(d).toContain("zettlab:docker:x (crash_loop): investigating")
    expect(d).toContain("mac:launchd:old (dead): rc (80%) · fix proposed [p9]")
    expect(d).toContain("mac:launchd:failed (failing): investigation failed — boom")
    expect(d.match(/mac:launchd:old/g)).toHaveLength(1)
    for (let i = 0; i < 40; i++) finish(s, `mac:launchd:n${i}`, "dead", "done", T0)
    const big = investigationDigest(s, T0 + 1)!
    expect(big.length).toBeLessThanOrEqual(700)
    expect(big).toMatch(/\(\+\d+ more\)$/)
  })
})
