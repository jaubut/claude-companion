import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import type { Intent } from "./jev-router"
import { type RouteLogRow, agrees, buildReport, comparable, ensureRouteLog, formatReport, insertRouteLog, readRouteLog, textHash } from "./jev-route-log"

const row = (intent: Intent | null, conf: number, old: RouteLogRow["oldOutcome"], over: Partial<RouteLogRow> = {}): RouteLogRow => ({
  at: 1000, channel: "general", text: "hello", mode: "shadow", intent, intentConf: intent ? conf : null, project: null, projectNoteId: null,
  projectConf: null, projectSource: null, route: "brain", oldOutcome: old, oldNoteId: null, jevMs: 200, totalMs: 3000, error: intent ? null : "timeout", ...over,
})

describe("sqlite log", () => {
  test("insert + read back; text hashed, redacted and truncated", () => {
    const db = new Database(":memory:")
    ensureRouteLog(db)
    ensureRouteLog(db) // idempotent
    const secret = "sk-ant-api03-" + "A".repeat(40)
    insertRouteLog(db, row("quick_look", 0.9, "task", { text: `is it on nuxt 4? ${secret} ${"x".repeat(400)}`, project: "chantal-masse-website", projectNoteId: "projects/c", oldNoteId: "projects/c" }))
    insertRouteLog(db, row(null, 0, "chat", { at: 5 }))
    const rows = readRouteLog(db, 100)
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ intent: "quick_look", intentConf: 0.9, project: "chantal-masse-website", oldOutcome: "task", oldNoteId: "projects/c", jevMs: 200 })
    expect(rows[0]!.text.length).toBeLessThanOrEqual(200)
    expect(rows[0]!.text).not.toContain(secret)
    const hash = db.query("SELECT text_hash FROM jev_route_log WHERE at = 1000").get() as { text_hash: string }
    expect(hash.text_hash).toMatch(/^[0-9a-f]{16}$/)
    expect(textHash(" a ")).toBe(textHash("a"))
  })
})

describe("report math", () => {
  test("the old path is a valid label only where it could have said the same thing", () => {
    expect(comparable(row("task", 0.9, "task"))).toBe(true)
    expect(comparable(row("chat", 0.9, "task"))).toBe(true)
    expect(comparable(row("status", 0.9, "chat"))).toBe(false) // new capability
    expect(comparable(row("quick_look", 0.9, "chat"))).toBe(false)
    expect(comparable(row("status", 0.9, "task"))).toBe(true)
    expect(comparable(row("task", 0.9, "error"))).toBe(false)
    expect(comparable(row("task", 0.9, null))).toBe(false)
    expect(agrees(row("quick_look", 0.9, "task"))).toBe(true)
    expect(agrees(row("chat", 0.9, "chat"))).toBe(true)
    expect(agrees(row("status", 0.9, "task"))).toBe(false)
  })

  test("agreement, per-intent precision, confident count, project agreement, go-live bar", () => {
    const rows = [
      ...Array.from({ length: 12 }, () => row("task", 0.9, "task", { projectNoteId: "p/a", oldNoteId: "p/a" })),
      ...Array.from({ length: 6 }, () => row("chat", 0.8, "chat")),
      ...Array.from({ length: 2 }, () => row("chat", 0.8, "task", { projectNoteId: "p/a", oldNoteId: "p/b" })),
      ...Array.from({ length: 3 }, () => row("status", 0.95, "chat")), // not comparable
      row("task", 0.5, "chat"), // not confident
      row(null, 0, "chat"), // Jev error
    ]
    const r = buildReport(rows, 0.7)
    expect([r.total, r.errors, r.confident, r.comparable, r.agree]).toEqual([25, 1, 23, 20, 18])
    expect(r.agreement).toBe(0.9)
    expect(r.perIntent.task).toEqual({ confident: 12, comparable: 12, agree: 12, precision: 1 })
    expect(r.perIntent.chat).toEqual({ confident: 8, comparable: 8, agree: 6, precision: 0.75 })
    expect(r.perIntent.status).toEqual({ confident: 3, comparable: 0, agree: 0, precision: null })
    expect([r.projectChecked, r.projectAgree]).toEqual([14, 12])
    expect(r.meanJevMs).toBe(200)
    expect(r.goLive).toBe(true)
    expect(formatReport(r, 7)).toContain("MET — set COMPANION_JEV_ROUTER=live")
  })

  test("bar not met: too few confident, or agreement under 75%", () => {
    expect(buildReport(Array.from({ length: 19 }, () => row("task", 0.9, "task")), 0.7).goLive).toBe(false)
    const low = [...Array.from({ length: 14 }, () => row("task", 0.9, "task")), ...Array.from({ length: 6 }, () => row("task", 0.9, "chat"))]
    const r = buildReport(low, 0.7)
    expect([r.agreement, r.goLive]).toEqual([0.7, false])
    expect(buildReport([], 0.7)).toMatchObject({ total: 0, agreement: null, goLive: false, meanJevMs: null })
    expect(formatReport(buildReport([], 0.7), 30)).toContain("not met")
  })
})
