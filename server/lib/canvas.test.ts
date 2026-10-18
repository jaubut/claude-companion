import { expect, test } from "bun:test"
import type { Activity } from "./activity"
import { sessionStatuses } from "./canvas"
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
