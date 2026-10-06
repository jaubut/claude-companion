import { describe, expect, test } from "bun:test"
import { type TaskRow, addDays, buildCascade, fromRow, localDay, normDate, sectionFor } from "./my-tasks"

const row = (id: string, o: Partial<TaskRow> = {}): TaskRow => ({
  id, noteId: "projects/p1", parentId: null, text: `task ${id}`, description: null, due: null, position: 0,
  noteTitle: "Project One", noteRef: "PRJ-AAAA", noteFolder: "projects", ...o,
})
const TODAY = "2026-10-06"
const NOW = Date.parse("2026-10-06T15:00:00Z")

describe("dates", () => {
  test("normDate: '' and garbage → null, datetime → day", () => {
    expect(normDate("")).toBeNull()
    expect(normDate(null)).toBeNull()
    expect(normDate("soon")).toBeNull()
    expect(normDate("2026-13-40")).toBeNull()
    expect(normDate("2026-02-31")).toBeNull()
    expect(normDate("2028-02-29")).toBe("2028-02-29")
    expect(normDate("2026-10-07T12:00:00Z")).toBe("2026-10-07")
  })
  test("localDay is Toronto's day, not UTC's", () => {
    // 02:30 UTC on the 7th = 22:30 EDT on the 6th.
    expect(localDay(Date.parse("2026-10-07T02:30:00Z"), "America/Toronto")).toBe("2026-10-06")
    expect(localDay(Date.parse("2026-10-07T04:30:00Z"), "America/Toronto")).toBe("2026-10-07")
  })
  test("addDays crosses month ends", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02")
  })
  test("sectionFor boundaries", () => {
    expect(sectionFor(null, TODAY)).toBe("none")
    expect(sectionFor("2026-10-05", TODAY)).toBe("overdue")
    expect(sectionFor(TODAY, TODAY)).toBe("today")
    expect(sectionFor("2026-10-07", TODAY)).toBe("week")
    expect(sectionFor("2026-10-12", TODAY)).toBe("week")
    expect(sectionFor("2026-10-13", TODAY)).toBe("later")
  })
})

describe("fromRow", () => {
  test("'' parent and due become null", () => {
    const r = fromRow({ id: "a", note_id: "n", parent_id: "", text: "x", description: "", due_date: "", position: 3, note_title: "T", note_ref: null, note_folder: "ideas" })
    expect(r.parentId).toBeNull()
    expect(r.due).toBeNull()
    expect(r.description).toBeNull()
    expect(r.position).toBe(3)
  })
})

describe("buildCascade", () => {
  test("all five sections always present, in order, with counts", () => {
    const out = buildCascade([row("a", { due: "2026-10-01" }), row("b", { due: TODAY }), row("c")], TODAY, NOW, "America/Toronto")
    expect(out.sections.map((s) => s.key)).toEqual(["overdue", "today", "week", "later", "none"])
    expect(out.sections.map((s) => s.count)).toEqual([1, 1, 0, 0, 1])
    expect(out.total).toBe(3)
    expect(out.today).toBe(TODAY)
  })

  test("groups by project inside a section; soonest project first, then title", () => {
    const out = buildCascade([
      row("a", { due: "2026-10-03", noteId: "projects/z", noteTitle: "Zeta" }),
      row("b", { due: "2026-10-01", noteId: "projects/y", noteTitle: "Yankee" }),
      row("c", { due: "2026-10-04", noteId: "projects/y", noteTitle: "Yankee" }),
      row("d", { noteId: "projects/b", noteTitle: "Bravo" }),
      row("e", { noteId: "projects/a", noteTitle: "Alpha" }),
    ], TODAY, NOW)
    const overdue = out.sections[0]!
    expect(overdue.projects.map((p) => p.title)).toEqual(["Yankee", "Zeta"])
    expect(overdue.projects[0]!.tasks.map((t) => t.id)).toEqual(["b", "c"])
    expect(out.sections[4]!.projects.map((p) => p.title)).toEqual(["Alpha", "Bravo"])
  })

  test("subtasks nest under their parent and follow its section", () => {
    const out = buildCascade([
      row("p", { due: TODAY }),
      row("k1", { parentId: "p", due: "2026-11-01" }),
      row("k2", { parentId: "k1" }),
    ], TODAY, NOW)
    const today = out.sections[1]!
    expect(today.count).toBe(3)
    const p = today.projects[0]!.tasks[0]!
    expect(p.id).toBe("p")
    expect(p.children[0]!.id).toBe("k1")
    expect(p.children[0]!.children[0]!.id).toBe("k2")
    expect(out.sections[3]!.count).toBe(0)
  })

  test("orphan subtask (parent not open/mine) stands on its own", () => {
    const out = buildCascade([row("k", { parentId: "gone", due: "2026-10-08" })], TODAY, NOW)
    expect(out.sections[2]!.projects[0]!.tasks[0]!.id).toBe("k")
  })

  test("a parent cycle never loops or duplicates", () => {
    const out = buildCascade([row("a", { parentId: "b" }), row("b", { parentId: "a" })], TODAY, NOW)
    expect(out.total).toBe(2)
    expect(out.sections[4]!.projects[0]!.tasks.length).toBe(1) // one root, the other nested once
    const self = buildCascade([row("s", { parentId: "s" })], TODAY, NOW)
    expect(self.total).toBe(1)
  })

  test("task without a note title falls back to the note id", () => {
    const out = buildCascade([row("a", { noteTitle: null, noteId: "meetings/2026-03-25-x" })], TODAY, NOW)
    expect(out.sections[4]!.projects[0]!.title).toBe("meetings/2026-03-25-x")
  })
})
