import { expect, test } from "bun:test"
import { type Mirror, type Seen, createDispatchWiring } from "./dispatch-poller"
import { type DispatchTask, phaseOf, seenKey } from "./dispatch-tasks"
import type { Channel } from "./orchestrator-channels"
import type { Turn, TurnCard } from "./orchestrator-chat"
import type { QueryFn, Row } from "./turso"

// brain-v2 (lib/dispatch-poller.ts): an announced transition also lands in the
// brain thread as a dispatch card turn — role orchestrator, Turn.taskId null,
// card.taskId the Turso id — while the old channel keeps its turn (until P3).
// Off the brain host (brainThread → null) nothing changes.

const ID = "a".repeat(32)
let rows: Row[] = []
const query: QueryFn = async (sql) => {
  if (sql.includes("pragma_table_info")) return [{ name: "id" }, { name: "dispatch_status" }]
  return sql.includes("FROM tasks t") ? rows : []
}
const channel = (id: string): Channel => ({ id, name: id, cwd: null, createdAt: 0, archived: false, trust: { approved: 0, rejected: 0, streak: 0, eligible: false }, noteId: null, noteTitle: null, noteRef: null })
const row = (status: string, at: string): Row => ({
  id: ID, note_id: "projects/none", text: "fix it", assignee: "agent:builder", done: 0, created_at: "2026-10-28 10:00:00", updated_at: at,
  dispatch_status: status, dispatch_blocker: status === "blocked" ? "no repo" : null, dispatch_owner: null, note_title: "P", note_ref: null,
})

function rig(brain: string | null) {
  const store = new Map<string, Seen>()
  const mirror: Mirror = {
    seenKey, lastSeen: (id) => store.get(id) ?? null,
    markSeen: (t: DispatchTask) => { store.set(t.id, { phase: phaseOf(t), updatedAt: t.updatedAtRaw, key: seenKey(t) }) },
    seenCount: () => store.size, pruneSeen: () => 0,
  }
  const turns: Array<Turn & { card?: TurnCard }> = []
  const traced: string[] = []
  const w = createDispatchWiring({
    query, broadcast: () => {}, push: () => {}, pushEnabled: () => false, linkedNotes: () => new Map(), getChannel: channel,
    localQueue: () => ({ cap: 0, live: 0, queued: 0 }), mirror, generalChannel: "general", log: () => {},
    appendTurn: (text, taskId, channelId, card) => {
      const t = { id: String(turns.length), threadId: channelId, role: "orchestrator" as const, text, taskId, createdAt: 0, ...(card ? { card } : {}) }
      turns.push(t)
      return t
    },
    brainThread: () => brain,
    traceTask: (t) => { traced.push(t.id) },
  })
  return { w, turns, traced }
}

test("brain host: the announce writes the old channel turn AND a brain card turn without Turn.taskId", async () => {
  const r = rig("brain")
  rows = [row("queued", "2026-10-28 10:00:00")]
  await r.w.poll() // seed
  rows = [row("blocked", "2026-10-28 11:00:00")]
  await r.w.poll()
  expect(r.turns.map((t) => [t.threadId, t.taskId])).toEqual([["general", ID], ["brain", null]])
  expect(r.turns[1]!.card).toEqual({ kind: "dispatch", source: "app", taskId: ID })
  expect(r.turns[1]!.text).toBe(r.turns[0]!.text)
  expect(r.traced).toContain(ID)
})

test("no brain host: only the old channel turn", async () => {
  const r = rig(null)
  rows = [row("queued", "2026-10-28 10:00:00")]
  await r.w.poll()
  rows = [row("blocked", "2026-10-28 11:00:00")]
  await r.w.poll()
  expect(r.turns.map((t) => t.threadId)).toEqual(["general"])
})
