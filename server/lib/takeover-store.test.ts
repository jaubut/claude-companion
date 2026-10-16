import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { type NewTakeover, createTakeoverStore } from "./takeover-store"

// The takeover run store on its own :memory: database.

const input = (over: Partial<NewTakeover> = {}): NewTakeover => ({
  name: "tko-zettlab-abcd1234", taskId: "abcd1234ef", host: "zettlab", repo: "claude-companion", cwd: "/w/tko-zettlab-abcd1234",
  branch: "takeover/abcd1234", origBlocker: "Which repo?", taskVersion: "blocked|2026-10-16 10:00:00", ...over,
})

describe("takeover store", () => {
  test("one open run per task: a replay (same or another version) returns the run that exists", () => {
    const s = createTakeoverStore(new Database(":memory:"))
    const a = s.create(input(), 1)
    expect(a.created).toBe(true)
    expect(a.row).toMatchObject({ status: "starting", origBlocker: "Which repo?", createdAt: 1 })
    const b = s.create(input({ taskVersion: "blocked|other" }), 2)
    expect(b.created).toBe(false)
    expect(b.row.id).toBe(a.row.id)
    expect(s.openFor("abcd1234ef")?.id).toBe(a.row.id)
    expect(s.listOpen()).toHaveLength(1)
  })

  test("status moves are CAS on the current status; a finished run frees the task and the name", () => {
    const s = createTakeoverStore(new Database(":memory:"))
    const { row } = s.create(input(), 1)
    expect(s.move(row.name, ["active"], "finishing", 2)).toBe(false)
    expect(s.move(row.name, ["starting"], "active", 2)).toBe(true)
    expect(s.move(row.name, ["starting", "active"], "finishing", 3, { outcome: "{}", prUrl: "https://github.com/a/b/pull/1" })).toBe(true)
    expect(s.move(row.name, ["starting", "active"], "finishing", 3)).toBe(false)
    expect(s.move(row.name, ["finishing"], "done", 4)).toBe(true)
    expect(s.get(row.name)).toMatchObject({ status: "done", prUrl: "https://github.com/a/b/pull/1", endedAt: 4 })
    expect(s.openFor("abcd1234ef")).toBeNull()
    expect(s.move(row.name, ["finishing"], "failed", 5)).toBe(false)
    const again = s.create(input(), 6)
    expect(again.created).toBe(true)
    expect(again.row.id).not.toBe(row.id)
    expect(s.get(row.name)?.id).toBe(again.row.id)
  })
})
