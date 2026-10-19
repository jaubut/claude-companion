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

test("context prompt: Turso note by id/ref_code, else the sticky's text", async () => {
  const seen: unknown[][] = []
  expect(await contextPrompt(node("note", "RES-XY12"), fakeQuery([{ title: "Spec", body: "# A\nB", ref_code: "RES-XY12" }], seen)))
    .toEqual({ ok: true, text: 'Canvas note context (RES-XY12 "Spec"): # A | B' })
  expect(seen).toEqual([["RES-XY12", "RES-XY12"]])
  expect(await contextPrompt(node("note", "", { text: "use bun" }), fakeQuery([]))).toEqual({ ok: true, text: "Canvas note context: use bun" })
  expect(await contextPrompt(node("note"), fakeQuery([]))).toEqual({ ok: false, error: "source_empty" })
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
