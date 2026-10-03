import { describe, expect, test } from "bun:test"
import type { ApnsPayload } from "./apns"
import {
  type BodyAlert, PUSH_WINDOW_MS, alertPushPayload, bodyPushEnabled, collapseIdFor, createPushGate, validateAlert,
} from "./body-alert"

const alert = (over: Partial<BodyAlert> = {}): BodyAlert => ({
  component_id: "mac:launchd:backup", severity: "critical", title: "backup dead", message: "exit 1 three times",
  state: "dead", from_state: "failing", ...over,
})

describe("validateAlert", () => {
  test("accepts the contract and normalises optionals", () => {
    expect(validateAlert({ component_id: " mac:x ", severity: "warning", title: "T", message: "M" })).toEqual({
      component_id: "mac:x", severity: "warning", title: "T", message: "M", state: null, from_state: null,
    })
  })
  test("400 reasons for missing / bad fields", () => {
    expect(validateAlert(null)).toEqual({ error: "body must be a JSON object" })
    expect(validateAlert([])).toEqual({ error: "body must be a JSON object" })
    expect(validateAlert({ severity: "info", title: "t", message: "m" })).toEqual({ error: "component_id required" })
    expect(validateAlert({ component_id: "a", severity: "fatal", title: "t", message: "m" })).toEqual({ error: "severity must be critical|warning|info" })
    expect(validateAlert({ component_id: "a", severity: "info", title: " ", message: "m" })).toEqual({ error: "title required" })
    expect(validateAlert({ component_id: "a", severity: "info", title: "t" })).toEqual({ error: "message required" })
    expect(validateAlert({ component_id: "a", severity: "info", title: "t", message: "m", state: 3 })).toEqual({ error: "state must be a string" })
  })
})

describe("push enablement", () => {
  test("sender configured AND COMPANION_BODY_PUSH not \"0\"", () => {
    expect(bodyPushEnabled(true, {})).toBe(true)
    expect(bodyPushEnabled(true, { COMPANION_BODY_PUSH: "1" })).toBe(true)
    expect(bodyPushEnabled(true, { COMPANION_BODY_PUSH: " 0 " })).toBe(false)
    expect(bodyPushEnabled(false, {})).toBe(false)
  })
})

describe("payload", () => {
  test("title, ≤180-char body, userInfo, collapseId, level by severity", () => {
    const p = alertPushPayload(alert({ message: "x".repeat(400) }))
    expect([...p.body].length).toBe(180)
    expect(p.body.endsWith("…")).toBe(true)
    expect(p).toMatchObject({ title: "backup dead", category: "body_alert", collapseId: "body-mac:launchd:backup", interruptionLevel: "time-sensitive", userInfo: { kind: "body_alert", component_id: "mac:launchd:backup" } })
    expect(alertPushPayload(alert({ severity: "warning" })).interruptionLevel).toBe("active")
    expect(alertPushPayload(alert({ severity: "info", title: "Body report" })).interruptionLevel).toBe("passive")
    const coalesced = alertPushPayload(alert({ message: "y".repeat(400) }), 4)
    expect([...coalesced.body].length).toBeLessThanOrEqual(180)
    expect(coalesced.body.endsWith("(+4 more in 15 min)")).toBe(true)
  })
  test("collapseId stays ≤ 64 bytes", () => {
    const id = collapseIdFor(`zettlab:systemd:${"é".repeat(60)}`)
    expect(Buffer.byteLength(id)).toBeLessThanOrEqual(64)
    expect(id).toStartWith("body-")
    expect(collapseIdFor("mac:x")).toBe("body-mac:x")
  })
})

function harness() {
  let t = Date.UTC(2026, 9, 3, 12)
  const pushes: ApnsPayload[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const gate = createPushGate({ push: (p) => pushes.push(p), now: () => t, schedule: (fn, ms) => timers.push({ fn, ms }) })
  return { gate, pushes, timers, advance: (ms: number) => { t += ms } }
}

describe("push gate", () => {
  test("max 1 push / 15 min per component; the window's alerts coalesce into one trailing push", () => {
    const h = harness()
    expect(h.gate.offer(alert())).toBe(true)
    h.advance(60_000)
    expect(h.gate.offer(alert({ severity: "warning", message: "w1" }))).toBe(false)
    expect(h.gate.offer(alert({ severity: "critical", message: "c2" }))).toBe(false)
    expect(h.gate.offer(alert({ severity: "warning", message: "w3" }))).toBe(false)
    expect(h.gate.offer(alert({ component_id: "mac:other" }))).toBe(true) // per component
    expect(h.pushes).toHaveLength(2)
    expect(h.timers).toHaveLength(1) // armed once
    expect(h.timers[0]!.ms).toBe(PUSH_WINDOW_MS - 60_000)
    h.advance(h.timers[0]!.ms)
    h.timers[0]!.fn()
    expect(h.pushes).toHaveLength(3)
    expect(h.pushes[2]!.body).toBe("c2 (+2 more in 15 min)") // worst severity wins, count of the others
    // The trailing push opened a new window.
    expect(h.gate.offer(alert())).toBe(false)
    h.advance(PUSH_WINDOW_MS)
    expect(h.gate.offer(alert())).toBe(true)
  })

  test("info never pushes; recovery to ok drops the pending trailing push", () => {
    const h = harness()
    expect(h.gate.offer(alert({ severity: "info", state: "ok", title: "backup recovered" }))).toBe(false)
    expect(h.pushes).toHaveLength(0)
    h.gate.offer(alert())
    h.advance(1000)
    h.gate.offer(alert({ message: "again" }))
    h.gate.offer(alert({ severity: "info", state: "ok", title: "recovered", message: "ok" }))
    h.timers[0]!.fn()
    expect(h.pushes).toHaveLength(1)
  })

  test("daily Body report pushes once per local day, passive", () => {
    const h = harness()
    const report = alert({ component_id: "zettlab:body:report", severity: "info", title: "Body report — 3 Oct", message: "41 ok, 1 dead" })
    expect(h.gate.offer(report)).toBe(true)
    expect(h.gate.offer(report)).toBe(false)
    h.advance(24 * 3600_000)
    expect(h.gate.offer(report)).toBe(true)
    expect(h.pushes.map((p) => [p.interruptionLevel, p.collapseId])).toEqual([["passive", "body-report"], ["passive", "body-report"]])
  })
})
