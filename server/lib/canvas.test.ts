import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import type { Activity } from "./activity"
import { type CanvasNode, PROMPT_MAX, contextPrompt, createCanvasStore, oneLine, sessionStatuses } from "./canvas"
import type { QueryFn, Row } from "./turso"
import type { Session } from "./sessions"
import type { WaitingKind } from "./waiting"

const session = (key: string, kinds: WaitingKind[] = []): Session =>
  ({ key, waitingReasons: kinds.map((kind, i) => ({ kind, since: i + 1, ref: "" })) }) as unknown as Session
const pill = (key: string): Activity => ({ key }) as unknown as Activity

test("tri-state: blocking reason → needs-you (beats a live pill); pill → working; turn-end / nothing → resting", () => {
  expect(sessionStatuses(
    [
      session("approval", ["approval"]), session("question+pill", ["question"]), session("dialog", ["turn-end", "dialog"]),
      session("pill"), session("turn-end", ["turn-end"]), session("idle"),
    ],
    [pill("question+pill"), pill("pill"), pill("")],
  )).toEqual({
    approval: "needs-you", "question+pill": "needs-you", dialog: "needs-you",
    pill: "working", "turn-end": "resting", idle: "resting",
  })
})

const node = (kind: CanvasNode["kind"], ref = "", data: Record<string, unknown> = {}): CanvasNode =>
  ({ id: "n", kind, ref, x: 0, y: 0, w: 1, h: 1, data, createdAt: 0, updatedAt: 0 })
const fakeQuery = (rows: Row[], seen: unknown[][] = []): QueryFn => async (_sql, args) => { seen.push(args); return rows }

test("context prompt: Turso task with its note, one line, no control bytes", async () => {
  const seen: unknown[][] = []
  const task = { text: "Fix the login", description: "step 1\n\n- step 2\x1b[31m", title: "Site", ref_code: "PRJ-AB12" }
  expect(await contextPrompt(node("task", "t1"), fakeQuery([task], seen)))
    .toEqual({ ok: true, text: 'Canvas task (Turso task t1, note PRJ-AB12 "Site") — start working on it: Fix the login | step 1 | - step 2 [31m' })
  expect(seen).toEqual([["t1"]])
  expect(await contextPrompt(node("task", "gone"), fakeQuery([]))).toEqual({ ok: false, error: "source_not_found" })
  expect(await contextPrompt(node("task", "t2"), fakeQuery([{ text: " ", description: "", title: null, ref_code: null }])))
    .toEqual({ ok: false, error: "source_empty" })
})

test("context prompt: notes are never sent (references since canvas-note-refs); oneLine caps", async () => {
  expect(await contextPrompt(node("note", "RES-XY12"), fakeQuery([{ title: "Spec", body: "B", ref_code: "RES-XY12" }]))).toEqual({ ok: false, error: "source_not_found" })
  expect(await contextPrompt(node("turso_note", "RES-XY12"), fakeQuery([{ title: "Spec", body: "B", ref_code: "RES-XY12" }]))).toEqual({ ok: false, error: "source_not_found" })
  expect(oneLine("x".repeat(PROMPT_MAX + 50)).length).toBe(PROMPT_MAX)
})

test("store: a pre-P6 edges table is migrated; a send cut by a restart reopens as failed", () => {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE canvas_edges (id TEXT PRIMARY KEY, kind TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (kind, from_id, to_id))")
  db.exec("INSERT INTO canvas_edges VALUES ('old', 'context', 'a', 'b', 1)")
  const s = createCanvasStore(db)
  expect(s.edge("old")).toMatchObject({ state: "proposed", error: "", sentAt: null })
  expect(s.claimEdge("old", 2)?.state).toBe("sending")
  expect(s.claimEdge("old", 3)).toBeNull()
  expect(createCanvasStore(db).edge("old")).toMatchObject({ state: "failed", error: "server_restart" })
})

for (const [otherGroup, group] of [[true, 1], [false, 0], [[1], "[1]"], [{ a: 1 }, '{"a":1}']] as const) {
  test(`store: preview groups match JSON type as well as value (${JSON.stringify(otherGroup)} vs ${JSON.stringify(group)})`, () => {
    const db = new Database(":memory:")
    const s = createCanvasStore(db)
    try {
      for (const [id, value] of [["other", otherGroup], ["same", group], ["picked", group]] as const) {
        s.addNode({ ...node("preview", "", { group: value }), id }, 1)
      }
      const other = s.pickNode("other", 2)
      if (!other.ok || !other.claimed) throw new Error("other pick was not claimed")
      s.pickNode("same", 3)
      const picked = s.pickNode("picked", 4)
      if (!picked.ok) throw new Error(picked.error)

      expect(s.node("other")?.data.picked).toBe(true)
      expect(s.currentPick("other", other.token)).not.toBeNull()
      expect(s.node("same")?.data.picked).toBe(false)
      expect(s.node("picked")?.data.picked).toBe(true)
      expect(picked.changed.map((n) => n.id)).toEqual(["picked", "same"])
    } finally {
      db.close()
    }
  })
}
