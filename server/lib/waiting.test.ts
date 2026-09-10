import { test, expect } from "bun:test"
import {
  WAITING_PRECEDENCE,
  type WaitingReason,
  removeReason,
  resolveWaiting,
  upsertReason,
} from "./waiting"

function reason(kind: WaitingReason["kind"], since: number, ref = ""): WaitingReason {
  return { kind, since, ref }
}

test("an empty reason list projects to nothing", () => {
  expect(resolveWaiting([])).toBeNull()
})

test("precedence is dialog > approval > question > turn-end, whatever the order in the list", () => {
  expect(WAITING_PRECEDENCE).toEqual(["dialog", "approval", "question", "turn-end"])
  const all = [
    reason("turn-end", 1),
    reason("question", 2, "q1"),
    reason("approval", 3, "a1"),
    reason("dialog", 4, "k1"),
  ]
  expect(resolveWaiting(all)?.kind).toBe("dialog")
  // Peel them off one at a time — each next kind takes over.
  expect(resolveWaiting(removeReason(all, "dialog"))?.kind).toBe("approval")
  expect(resolveWaiting(removeReason(removeReason(all, "dialog"), "approval"))?.kind).toBe("question")
  const onlyTurn = removeReason(removeReason(removeReason(all, "dialog"), "approval"), "question")
  expect(resolveWaiting(onlyTurn)?.kind).toBe("turn-end")
  // A newer, lower-precedence reason never outranks an older, higher one.
  expect(resolveWaiting([reason("turn-end", 9_999), reason("approval", 1, "a1")])?.kind).toBe("approval")
})

test("within one kind the OLDEST reason wins — the one blocking longest expires first", () => {
  const winner = resolveWaiting([
    reason("approval", 300, "second"),
    reason("approval", 100, "first"),
    reason("approval", 200, "third"),
  ])
  expect(winner?.ref).toBe("first")
  expect(winner?.since).toBe(100)
})

test("re-asserting the same (kind, ref) keeps its since; a new ref is a new reason", () => {
  let list: WaitingReason[] = []
  list = upsertReason(list, "approval", "a1", 1_000)
  expect(list).toEqual([reason("approval", 1_000, "a1")])

  // Same block, noticed again later — the badge's age must not reset.
  list = upsertReason(list, "approval", "a1", 5_000)
  expect(list).toEqual([reason("approval", 1_000, "a1")])

  // A second approval on the same session is its own reason, freshly stamped.
  list = upsertReason(list, "approval", "a2", 5_000)
  expect(list.length).toBe(2)
  expect(list[1]).toEqual(reason("approval", 5_000, "a2"))
  // …and the projection still names the older one.
  expect(resolveWaiting(list)?.ref).toBe("a1")

  // Different kinds coexist, one slot each per (kind, ref).
  list = upsertReason(list, "turn-end", "", 6_000)
  list = upsertReason(list, "turn-end", "", 7_000)
  expect(list.filter((r) => r.kind === "turn-end")).toEqual([reason("turn-end", 6_000, "")])
})

test("remove drops one reason by (kind, ref), a whole kind, or everything", () => {
  const list = [
    reason("turn-end", 1),
    reason("approval", 2, "a1"),
    reason("approval", 3, "a2"),
    reason("dialog", 4, "k1"),
  ]
  // Exact: only that approval goes, the sibling survives with its ref.
  const oneGone = removeReason(list, "approval", "a1")
  expect(oneGone.filter((r) => r.kind === "approval").map((r) => r.ref)).toEqual(["a2"])
  expect(oneGone.length).toBe(3)

  // Kind-wide: both approvals go.
  expect(removeReason(list, "approval").some((r) => r.kind === "approval")).toBe(false)

  // No kind at all: wipe.
  expect(removeReason(list)).toEqual([])

  // Removing what isn't there returns an equal list, so a caller comparing
  // lengths sees "nothing changed" and skips its emit.
  expect(removeReason(list, "question", "nope").length).toBe(list.length)
  expect(removeReason([], "turn-end").length).toBe(0)
})

test("clearing the winner falls back to the surviving reason — the headline case", () => {
  const list = [reason("turn-end", 1_000), reason("dialog", 2_000, "k1")]
  expect(resolveWaiting(list)?.kind).toBe("dialog")
  // Esc on the dialog must not blank a turn-end that was already lit.
  const afterEsc = removeReason(list, "dialog", "k1")
  expect(resolveWaiting(afterEsc)?.kind).toBe("turn-end")
  expect(resolveWaiting(afterEsc)?.since).toBe(1_000)
})
