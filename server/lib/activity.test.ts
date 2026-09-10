import { afterEach, beforeEach, expect, test } from "bun:test"
import {
  forgetSession,
  getActivity,
  listActivities,
  onActivity,
  recordToolEnd,
  recordToolStart,
  recordTurnEnd,
  reconcileActivityLiveness,
  type Activity,
} from "./activity"
import { getState } from "./transcript"
import type { Session } from "./sessions"

// The pill is per session (PRJ-OR1T Phase 10): every hook writes only the
// PathState it was handed, and the host-wide `activity` is derived.
//
// Bun shares one module cache across test files and transcript.test.ts walks
// the same states map, so everything here is keyed to two disjoint fixtures
// and asserts only on the entries it owns — never on listActivities().length.
// forgetSession in afterEach drops both records, which also stops the 1.5s
// poll so no interval leaks into the next file.

const A = { tty: "/dev/ta1", cwd: "/tmp/cc-act-a", sessionId: "cc-act-sid-a", key: "claude:tty:/dev/ta1" }
const B = { tty: "/dev/ta2", cwd: "/tmp/cc-act-b", sessionId: "cc-act-sid-b", key: "claude:tty:/dev/ta2" }
const POLL_MS = 1500

type Fixture = typeof A

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// reconcileActivityLiveness reads nothing but `key` off each live session.
const live = (...keys: string[]): Session[] => keys.map(key => ({ key } as Session))

function toolStart(f: Fixture, tool = "Read", sessionKey = f.key): void {
  recordToolStart({
    tool,
    input: tool === "Bash" ? { command: "ls" } : { file_path: `${f.cwd}/x.ts` },
    summary: "x.ts",
    verdict: "auto-allow",
    cwd: f.cwd,
    sessionId: f.sessionId,
    tty: f.tty,
    sessionKey,
  })
}

function pill(key: string): Activity | undefined {
  return listActivities().find(a => a.key === key)
}

// Only the two entries this file owns, in the server's rollup order.
function myOrder(): string[] {
  return listActivities().filter(a => a.key === A.key || a.key === B.key).map(a => a.key)
}

function cleanup(): void {
  forgetSession({ tty: A.tty })
  forgetSession({ tty: B.tty })
}

beforeEach(cleanup)
afterEach(cleanup)

test("two sessions each hold their own pill", () => {
  toolStart(A, "Read")
  toolStart(B, "Bash")
  expect(pill(A.key)?.tool).toBe("Read")
  expect(pill(A.key)?.tty).toBe(A.tty)
  expect(pill(A.key)?.cwd).toBe(A.cwd)
  expect(pill(B.key)?.tool).toBe("Bash")
  expect(pill(B.key)?.tty).toBe(B.tty)
})

test("a tool_end refreshes only its own session's pill", async () => {
  toolStart(A)
  toolStart(B)
  const beatA = pill(A.key)!.lastBeatAt
  const beatB = pill(B.key)!.lastBeatAt
  await sleep(5)

  recordToolEnd({
    tool: "Read",
    input: { file_path: `${B.cwd}/x.ts` },
    cwd: B.cwd,
    sessionId: B.sessionId,
    tty: B.tty,
    sessionKey: B.key,
  })

  expect(pill(A.key)!.lastBeatAt).toBe(beatA)
  expect(pill(B.key)!.lastBeatAt).toBeGreaterThan(beatB)
  expect(getActivity()?.key).toBe(B.key)
})

test("a turn_end clears only its own pill and hands the rollup back", async () => {
  toolStart(A)
  await sleep(5)
  toolStart(B)
  expect(getActivity()?.key).toBe(B.key)

  await recordTurnEnd({ cwd: B.cwd, sessionId: B.sessionId, tty: B.tty, sessionKey: B.key })

  // The build-4 improvement: the finished session hands the pill back to the
  // one still working instead of blanking the phone.
  expect(pill(B.key)).toBeUndefined()
  expect(pill(A.key)?.key).toBe(A.key)
  expect(getActivity()?.key).toBe(A.key)
})

test("the rollup orders on the last real event, newest first", async () => {
  toolStart(A)
  await sleep(5)
  toolStart(B)
  expect(myOrder()).toEqual([B.key, A.key])

  await sleep(5)
  recordToolEnd({
    tool: "Read",
    input: { file_path: `${A.cwd}/x.ts` },
    cwd: A.cwd,
    sessionId: A.sessionId,
    tty: A.tty,
    sessionKey: A.key,
  })
  expect(myOrder()).toEqual([A.key, B.key])
})

test("one heartbeat tick refreshes every pill, emits once, and never re-orders", async () => {
  toolStart(A)
  await sleep(5)
  toolStart(B)
  const order = myOrder()
  const beatA = pill(A.key)!.lastBeatAt
  const beatB = pill(B.key)!.lastBeatAt

  const frames: Array<{ rollup: Activity | null; activities: Activity[]; key: string }> = []
  const off = onActivity((rollup, activities, key) => { frames.push({ rollup, activities, key }) })
  await sleep(POLL_MS + 200)
  off()

  // One frame per tick, not one per session.
  expect(frames).toHaveLength(1)
  expect(frames[0]!.key).toBe("")
  expect(pill(A.key)!.lastBeatAt).toBeGreaterThan(beatA)
  expect(pill(B.key)!.lastBeatAt).toBeGreaterThan(beatB)
  // The beat bumps lastBeatAt only — ordering is on lastEventAt.
  expect(myOrder()).toEqual(order)
  expect(frames[0]!.rollup?.key).toBe(order[0])
})

test("the pill rides getState's weak→strong migration", () => {
  toolStart(A)
  const weak = getState({ tty: A.tty, cwd: A.cwd })
  expect(weak.activity?.key).toBe(A.key)

  // Same session, now with a transcript path: the record moves to the strong
  // key in place and must bring its pill (no parallel key space, no orphan).
  const transcriptPath = `${A.cwd}/session.jsonl`
  recordToolEnd({
    tool: "Read",
    input: { file_path: `${A.cwd}/x.ts` },
    transcriptPath,
    cwd: A.cwd,
    sessionId: A.sessionId,
    tty: A.tty,
    sessionKey: A.key,
  })

  const strong = getState({ transcriptPath, tty: A.tty, cwd: A.cwd })
  expect(strong).toBe(weak)
  expect(strong.activity?.key).toBe(A.key)
  expect(pill(A.key)?.tty).toBe(A.tty)
})

test("reconcileActivityLiveness drops a dead session's stale pill and spares the rest", () => {
  toolStart(A)
  toolStart(B)
  // A's terminal was SIGKILLed: no session-end hook ever fires, and its last
  // real event is older than the grace window.
  getState({ tty: A.tty, cwd: A.cwd }).lastEventAt = Date.now() - 6_000

  reconcileActivityLiveness(live(B.key))

  expect(pill(A.key)).toBeUndefined()
  expect(pill(B.key)?.key).toBe(B.key)
})

test("the grace window spares a pill whose session key just changed", () => {
  toolStart(A)
  // A is absent from the live set here too, but its event is fresh — that is
  // recordSession's collapse race, not a dead terminal.
  reconcileActivityLiveness(live("claude:tty:/dev/ta-other"))
  expect(pill(A.key)?.key).toBe(A.key)
})

test("a keyless pill is never judged by the reconcile", () => {
  // A hook with no cwd registers no Session, so there is no key to judge.
  toolStart(A, "Read", "")
  getState({ tty: A.tty, cwd: A.cwd }).lastEventAt = Date.now() - 60_000

  reconcileActivityLiveness(live(B.key))

  expect(listActivities().some(a => a.key === "" && a.tty === A.tty)).toBe(true)
})

test("forgetSession clears only that session's pill, weak key included", () => {
  toolStart(A)
  toolStart(B)
  // A's record is still under the weak tty: key — reaching it that way must
  // clear its pill, and only its pill.
  forgetSession({ tty: A.tty })

  expect(pill(A.key)).toBeUndefined()
  expect(pill(B.key)?.tool).toBe("Read")
  expect(getActivity()?.key).toBe(B.key)
})
