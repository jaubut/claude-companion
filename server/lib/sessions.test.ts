import { test, expect } from "bun:test"
import { recordSession, listSessions, setSessionTitle, setTitleResolver, ttyTag, onSessions, metaFromHeaders, removeSessionByTmuxPane, setSessionWaiting, clearSessionWaiting, clearWaitingForTarget, waitingSummary } from "./sessions"

test("Linux pts ttys get a tag like macOS ttys do", () => {
  expect(ttyTag("/dev/ttys017")).toBe("s017")
  expect(ttyTag("/dev/pts/8")).toBe("pts8")
  expect(ttyTag("/dev/?")).toBe("")
  const a = recordSession({ cwd: "/home/aubut", tty: "/dev/pts/8" })!
  const b = recordSession({ cwd: "/home/aubut", tty: "/dev/pts/9" })!
  expect(a.label).toBe("aubut · pts8")
  expect(b.label).toBe("aubut · pts9")
  expect(a.key).not.toBe(b.key)
})

test("title is sticky, set explicitly, and emitted as a change", () => {
  let emits = 0
  const off = onSessions(() => { emits++ })
  const s = recordSession({ cwd: "/home/aubut", tty: "/dev/pts/10", sessionId: "sid-x" })!
  expect(s.title).toBe("")
  setSessionTitle(s.key, "Rename the BRP footage")
  expect(listSessions().find((x) => x.key === s.key)?.title).toBe("Rename the BRP footage")
  const before = emits
  setSessionTitle(s.key, "Rename the BRP footage") // unchanged → no emit
  expect(emits).toBe(before)
  // a later hook without a title keeps it
  const again = recordSession({ cwd: "/home/aubut", tty: "/dev/pts/10" })!
  expect(again.title).toBe("Rename the BRP footage")
  off()
})

test("firstSeenAt keeps the earliest known start; discovery can push it back", () => {
  const s = recordSession({ cwd: "/home/aubut/lanes/qa", tty: "/dev/pts/11" })!
  const hookTime = s.firstSeenAt
  const earlier = hookTime - 60_000
  recordSession({ cwd: "/home/aubut/lanes/qa", tty: "/dev/pts/11", firstSeenAt: earlier }, { provisional: true })
  expect(listSessions().find((x) => x.key === s.key)?.firstSeenAt).toBe(earlier)
  recordSession({ cwd: "/home/aubut/lanes/qa", tty: "/dev/pts/11", firstSeenAt: earlier + 30_000 })
  expect(listSessions().find((x) => x.key === s.key)?.firstSeenAt).toBe(earlier)
})

test("a resolver fills a missing title once for sessions that carry a session id", async () => {
  const asked: string[] = []
  setTitleResolver(async (s) => { asked.push(s.sessionId); return `title for ${s.sessionId}` })
  const s = recordSession({ cwd: "/home/aubut/lanes/build", tty: "/dev/pts/12", sessionId: "sid-r" })!
  await Bun.sleep(5)
  expect(listSessions().find((x) => x.key === s.key)?.title).toBe("title for sid-r")
  recordSession({ cwd: "/home/aubut/lanes/build", tty: "/dev/pts/12", sessionId: "sid-r" })
  await Bun.sleep(5)
  expect(asked).toEqual(["sid-r"])
  setTitleResolver(null)
})

test("a guessed session id never names a chat and never overwrites a confirmed one", async () => {
  const asked: string[] = []
  setTitleResolver(async (s) => { asked.push(s.sessionId); return `title for ${s.sessionId}` })
  // ps discovery guessed the newest transcript in the folder
  const g = recordSession({ cwd: "/home/aubut", tty: "/dev/pts/20", sessionId: "sid-guess" }, { provisional: true, sessionIdConfirmed: false })!
  await Bun.sleep(5)
  expect(g.sidConfirmed).toBe(false)
  expect(listSessions().find((x) => x.key === g.key)?.title).toBe("")
  expect(asked).toEqual([])
  // the session's own hook arrives with the real id → resolver runs on it
  recordSession({ cwd: "/home/aubut", tty: "/dev/pts/20", sessionId: "sid-real" })
  await Bun.sleep(5)
  const s = listSessions().find((x) => x.key === g.key)!
  expect(s.sessionId).toBe("sid-real")
  expect(s.sidConfirmed).toBe(true)
  expect(s.title).toBe("title for sid-real")
  // a later discovery guess can't move it back
  recordSession({ cwd: "/home/aubut", tty: "/dev/pts/20", sessionId: "sid-guess" }, { provisional: true, sessionIdConfirmed: false })
  expect(listSessions().find((x) => x.key === g.key)?.sessionId).toBe("sid-real")
  expect(asked).toEqual(["sid-real"])
  setTitleResolver(null)
})

test("a confirmed id that replaces a different confirmed id drops the stale title", async () => {
  setTitleResolver(async (s) => `title for ${s.sessionId}`)
  const s = recordSession({ cwd: "/home/aubut", tty: "/dev/pts/21", sessionId: "sid-a" })!
  await Bun.sleep(5)
  expect(listSessions().find((x) => x.key === s.key)?.title).toBe("title for sid-a")
  recordSession({ cwd: "/home/aubut", tty: "/dev/pts/21", sessionId: "sid-b" }) // /clear → new session id on the same tty
  await Bun.sleep(5)
  expect(listSessions().find((x) => x.key === s.key)?.title).toBe("title for sid-b")
  setTitleResolver(null)
})

// ---- worker identity (PRJ-OR1T Phase 8) ------------------------------------

test("a worker's task id is sticky and its arrival fires an emit", () => {
  const headers = new Headers({
    "x-companion-tty": "/dev/pts/30",
    "x-companion-tmux-pane": "%30",
    "x-companion-task-id": "abc123ef",
  })
  // ps-discovery sees the worker first, with no headers at all
  const discovered = recordSession({ cwd: "/home/aubut/lanes/build", tty: "/dev/pts/30" }, { provisional: true })!
  expect(discovered.taskId).toBe("")

  let emits = 0
  const off = onSessions(() => { emits++ })
  // then its hook lands and brings the identity
  const bound = recordSession({ cwd: "/home/aubut/lanes/build", ...metaFromHeaders(headers) })!
  expect(bound.key).toBe(discovered.key)
  expect(bound.taskId).toBe("abc123ef")
  // The emit is the whole point: wiring/events.ts runs reconcileDispatch inside
  // the same onSessions callback, so a taskId that lands without an emit would
  // never reach the resolver.
  expect(emits).toBe(1)

  // a later header-less record (discovery, rehydrate) must not erase it
  const again = recordSession({ cwd: "/home/aubut/lanes/build", tty: "/dev/pts/30" })!
  expect(again.taskId).toBe("abc123ef")
  off()
})

test("a tmux pane arriving after registration also counts as a change", () => {
  recordSession({ cwd: "/home/aubut/lanes/qa2", tty: "/dev/pts/31" })
  let emits = 0
  const off = onSessions(() => { emits++ })
  recordSession({ cwd: "/home/aubut/lanes/qa2", tty: "/dev/pts/31", tmuxPane: "%31" })
  expect(emits).toBe(1)
  off()
})

test("removeSessionByTmuxPane drops one worker and leaves its cwd sibling alive", () => {
  const a = recordSession({ cwd: "/home/aubut/shared", tty: "/dev/pts/40", tmuxPane: "%40" })!
  const b = recordSession({ cwd: "/home/aubut/shared", tty: "/dev/pts/41", tmuxPane: "%41" })!
  expect(removeSessionByTmuxPane("%40")).toBe(true)
  const keys = listSessions().map((s) => s.key)
  expect(keys).not.toContain(a.key)
  expect(keys).toContain(b.key)
  expect(removeSessionByTmuxPane("%40")).toBe(false) // already gone
  expect(removeSessionByTmuxPane("")).toBe(false)
})

// ---- per-session waiting (PRJ-OR1T Phase 9) ---------------------------------

// The registry is a module singleton and waitingSummary() rolls up every live
// session, so each case starts and ends from a known-empty waiting set.
function clearAllWaiting(): void {
  for (const w of waitingSummary().waitingSessions) clearSessionWaiting(w.key)
}

test("waiting survives the identity collapse and fires an emit", () => {
  clearAllWaiting()
  // A Stop hook whose tty came back as "?" (Linux) keys on the session id.
  const weak = recordSession({ cwd: "/home/aubut/lanes/w1", sessionId: "sid-w1" })!
  expect(weak.key).toBe("claude:sid:sid-w1")

  let emits = 0
  const off = onSessions(() => { emits++ })
  expect(setSessionWaiting(weak.key, "turn-end")).toBeGreaterThan(0)
  expect(emits).toBe(1)
  expect(waitingSummary().waitingKey).toBe(weak.key)

  // The next hook carries a tty, so the weaker record collapses into it.
  const strong = recordSession({ cwd: "/home/aubut/lanes/w1", sessionId: "sid-w1", tty: "/dev/pts/50" })!
  expect(strong.key).not.toBe(weak.key)
  expect(listSessions().some((s) => s.key === weak.key)).toBe(false)
  expect(emits).toBe(2) // the collapse is itself a meaningful change

  const summary = waitingSummary()
  expect(summary.waitingSessions.map((w) => w.key)).toEqual([strong.key])
  expect(summary.waitingSessions[0]?.kind).toBe("turn-end")
  off()
  clearAllWaiting()
})

test("two sessions wait independently; clearing one leaves the other lit", () => {
  clearAllWaiting()
  const a = recordSession({ cwd: "/home/aubut/lanes/w2", tty: "/dev/pts/51" })!
  const b = recordSession({ cwd: "/home/aubut/lanes/w2", tty: "/dev/pts/52" })!
  setSessionWaiting(a.key, "turn-end")
  setSessionWaiting(b.key, "turn-end")
  expect(waitingSummary().waitingSessions.length).toBe(2)

  expect(clearSessionWaiting(a.key)).toBe(true)
  expect(waitingSummary().waitingSessions.map((w) => w.key)).toEqual([b.key])
  clearAllWaiting()
})

test("waiting is sticky across a header-less discovery re-record", () => {
  clearAllWaiting()
  const s = recordSession({ cwd: "/home/aubut/lanes/w3", tty: "/dev/pts/53" })!
  setSessionWaiting(s.key, "turn-end")
  // cli.ts re-runs discovery on an interval with agentStatus from the pid file
  // and no waiting fields at all — the badge must not blink off.
  const again = recordSession(
    { cwd: "/home/aubut/lanes/w3", tty: "/dev/pts/53", agentStatus: "busy", waitingFor: "" },
    { provisional: true },
  )!
  expect(again.waitingSince).toBeGreaterThan(0)
  expect(again.waitingKind).toBe("turn-end")
  clearAllWaiting()
})

test("waitingSummary lists every waiter and derives the scalars from the newest", async () => {
  clearAllWaiting()
  const a = recordSession({ cwd: "/home/aubut/lanes/w4a", tty: "/dev/pts/54" })!
  const b = recordSession({ cwd: "/home/aubut/lanes/w4b", tty: "/dev/pts/55" })!
  setSessionWaiting(a.key, "turn-end")
  await Bun.sleep(2)
  setSessionWaiting(b.key, "turn-end")

  const summary = waitingSummary()
  expect(summary.waitingForInput).toBe(true)
  expect(summary.waitingKey).toBe(b.key)
  expect(summary.waitingCwd).toBe("/home/aubut/lanes/w4b")
  expect(summary.waitingSessions.map((w) => w.key).sort()).toEqual([a.key, b.key].sort())

  clearAllWaiting()
  expect(waitingSummary().waitingForInput).toBe(false)
  expect(waitingSummary().waitingKey).toBe("")
})

test("clearWaitingForTarget clears the single waiter and refuses two", () => {
  clearAllWaiting()
  const a = recordSession({ cwd: "/home/aubut/lanes/w5a", tty: "/dev/pts/56" })!
  const b = recordSession({ cwd: "/home/aubut/lanes/w5b", tty: "/dev/pts/57" })!

  setSessionWaiting(a.key, "turn-end")
  const single = clearWaitingForTarget(null)
  expect(single.cleared?.key).toBe(a.key)
  expect(single.refused).toBe(0)
  expect(waitingSummary().waitingForInput).toBe(false)

  // Ambiguous: an inject that named nobody must not guess.
  setSessionWaiting(a.key, "turn-end")
  setSessionWaiting(b.key, "turn-end")
  const ambiguous = clearWaitingForTarget(null)
  expect(ambiguous.cleared).toBeNull()
  expect(ambiguous.refused).toBe(2)
  expect(waitingSummary().waitingSessions.length).toBe(2)

  // Naming one still clears exactly that one.
  expect(clearWaitingForTarget(b).cleared?.key).toBe(b.key)
  expect(waitingSummary().waitingSessions.map((w) => w.key)).toEqual([a.key])
  // And a target that isn't waiting reports nothing cleared, nothing refused.
  expect(clearWaitingForTarget(b)).toEqual({ cleared: null, refused: 0 })
  clearAllWaiting()
})

test("removing a session drops its waiting state with the record", () => {
  clearAllWaiting()
  const a = recordSession({ cwd: "/home/aubut/lanes/w6", tty: "/dev/pts/58", tmuxPane: "%58" })!
  setSessionWaiting(a.key, "turn-end")
  expect(removeSessionByTmuxPane("%58")).toBe(true)
  expect(waitingSummary().waitingForInput).toBe(false)
  // A fresh terminal on the recycled tty starts clean — no phantom target.
  expect(recordSession({ cwd: "/home/aubut/lanes/w6", tty: "/dev/pts/58" })!.waitingSince).toBe(0)
})

test("a waiting change emits; clearing a session that isn't waiting does not", () => {
  clearAllWaiting()
  const s = recordSession({ cwd: "/home/aubut/lanes/w7", tty: "/dev/pts/59" })!
  let emits = 0
  const off = onSessions(() => { emits++ })
  setSessionWaiting(s.key, "turn-end")
  expect(emits).toBe(1)
  expect(clearSessionWaiting(s.key)).toBe(true)
  expect(emits).toBe(2)
  expect(clearSessionWaiting(s.key)).toBe(false) // idempotent
  expect(clearSessionWaiting("claude:tty:/dev/pts/999")).toBe(false) // unknown key
  expect(setSessionWaiting("claude:tty:/dev/pts/999", "turn-end")).toBe(0)
  expect(emits).toBe(2)
  off()
})
