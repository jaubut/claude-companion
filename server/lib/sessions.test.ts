import { test, expect } from "bun:test"
import { recordSession, listSessions, setSessionTitle, setTitleResolver, ttyTag, onSessions, removeSessionByTmuxPane, setSessionWaiting, clearSessionWaiting, clearSessionWaitingByRef, clearWaitingForTarget, waitingSummary } from "./sessions"
import { metaFromHeaders } from "./hook-common"

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
  // The init array's shape: every entry names what blocks it, not just when.
  const entry = summary.waitingSessions.find((w) => w.key === a.key)!
  expect(entry.kind).toBe("turn-end")
  expect(entry.ref).toBe("")
  // …and the record spread into `sessions` / `init` / status carries both the
  // projection and the raw list the next iOS build reads.
  const rec = listSessions().find((x) => x.key === a.key)!
  expect(rec.waitingKind).toBe("turn-end")
  expect(rec.waitingRef).toBe("")
  expect(rec.waitingReasons).toEqual([{ kind: "turn-end", since: rec.waitingSince, ref: "" }])

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

// ---- one waiting kind per session (PRJ-OR1T Phase 11) -----------------------

test("an approval and a turn-end coexist; the projection prefers the approval", () => {
  clearAllWaiting()
  const a = recordSession({ cwd: "/home/aubut/lanes/p1", tty: "/dev/pts/60" })!
  setSessionWaiting(a.key, "turn-end")
  setSessionWaiting(a.key, "approval", "appr-1")

  const rec = () => listSessions().find((x) => x.key === a.key)!
  expect(rec().waitingKind).toBe("approval")
  expect(rec().waitingRef).toBe("appr-1")
  expect(rec().waitingReasons.map((r) => r.kind).sort()).toEqual(["approval", "turn-end"])
  // One session, one waiting entry — the list is the detail, not a second row.
  expect(waitingSummary().waitingSessions.length).toBe(1)
  clearAllWaiting()
})

test("clearing the approval falls back to the turn-end instead of blanking it", () => {
  clearAllWaiting()
  const a = recordSession({ cwd: "/home/aubut/lanes/p2", tty: "/dev/pts/61" })!
  const turnStamp = setSessionWaiting(a.key, "turn-end")
  setSessionWaiting(a.key, "dialog", a.key)
  const rec = () => listSessions().find((x) => x.key === a.key)!
  expect(rec().waitingKind).toBe("dialog")

  // Esc on a /model dialog opened after the turn ended. Before Phase 11 this
  // was a waiting:false that darkened a badge the user still owed an answer.
  expect(clearSessionWaiting(a.key, "dialog", a.key)).toBe(true)
  expect(rec().waitingKind).toBe("turn-end")
  expect(rec().waitingSince).toBe(turnStamp)
  expect(rec().waitingRef).toBe("")
  clearAllWaiting()
})

test("two approvals on one session: clearing the first leaves the second with its ref", async () => {
  clearAllWaiting()
  const a = recordSession({ cwd: "/home/aubut/lanes/p3", tty: "/dev/pts/62" })!
  setSessionWaiting(a.key, "approval", "appr-1")
  await Bun.sleep(2)
  setSessionWaiting(a.key, "approval", "appr-2")
  const rec = () => listSessions().find((x) => x.key === a.key)!
  // Oldest within the kind — the one whose 290s expiry fires first.
  expect(rec().waitingRef).toBe("appr-1")

  expect(clearSessionWaiting(a.key, "approval", "appr-1")).toBe(true)
  expect(rec().waitingKind).toBe("approval")
  expect(rec().waitingRef).toBe("appr-2")

  expect(clearSessionWaiting(a.key, "approval", "appr-2")).toBe(true)
  expect(rec().waitingKind).toBe("")
  expect(rec().waitingSince).toBe(0)
  // Idempotent: the phone can resolve over both the WS and REST paths.
  expect(clearSessionWaiting(a.key, "approval", "appr-2")).toBe(false)
  clearAllWaiting()
})

test("clearSessionWaitingByRef finds an approval whose key went stale in the collapse", () => {
  clearAllWaiting()
  // The PermissionRequest hook fired without a tty, so the request captured a
  // sid: key…
  const weak = recordSession({ cwd: "/home/aubut/lanes/p4", sessionId: "sid-p4" })!
  expect(weak.key).toBe("claude:sid:sid-p4")
  setSessionWaiting(weak.key, "approval", "appr-stale")

  // …then a hook with a tty collapsed that record into a strong one.
  const strong = recordSession({ cwd: "/home/aubut/lanes/p4", sessionId: "sid-p4", tty: "/dev/pts/63" })!
  expect(strong.key).not.toBe(weak.key)
  const rec = () => listSessions().find((x) => x.key === strong.key)!
  expect(rec().waitingKind).toBe("approval")
  expect(rec().waitingRef).toBe("appr-stale")

  // The direct lookup misses — the request still names the dead key.
  expect(clearSessionWaiting(weak.key, "approval", "appr-stale")).toBe(false)
  // The fallback is an exact (kind, ref) match, and it hands back the session
  // so the caller can announce what survived.
  const cleared = clearSessionWaitingByRef("approval", "appr-stale")
  expect(cleared?.key).toBe(strong.key)
  expect(rec().waitingSince).toBe(0)
  expect(clearSessionWaitingByRef("approval", "appr-stale")).toBeNull()
  clearAllWaiting()
})

test("the same fallback closes a dialog whose key the liveness sweep already retired", () => {
  clearAllWaiting()
  const weak = recordSession({ cwd: "/home/aubut/lanes/p5", sessionId: "sid-p5" })!
  // The watcher opened the dialog against the key it saw, and uses that key as
  // the reason's ref — so the reason survives the collapse verbatim.
  setSessionWaiting(weak.key, "dialog", weak.key)
  const strong = recordSession({ cwd: "/home/aubut/lanes/p5", sessionId: "sid-p5", tty: "/dev/pts/64" })!
  const rec = () => listSessions().find((x) => x.key === strong.key)!
  expect(rec().waitingKind).toBe("dialog")
  expect(rec().waitingRef).toBe(weak.key)

  expect(clearSessionWaiting(weak.key, "dialog", weak.key)).toBe(false)
  expect(clearSessionWaitingByRef("dialog", weak.key)?.key).toBe(strong.key)
  expect(rec().waitingSince).toBe(0)
  clearAllWaiting()
})

test("reasons survive the identity collapse and re-project onto the strong record", () => {
  clearAllWaiting()
  const weak = recordSession({ cwd: "/home/aubut/lanes/p6", sessionId: "sid-p6" })!
  const stamp = setSessionWaiting(weak.key, "turn-end")
  setSessionWaiting(weak.key, "approval", "appr-6")

  const strong = recordSession({ cwd: "/home/aubut/lanes/p6", sessionId: "sid-p6", tty: "/dev/pts/65" })!
  expect(listSessions().some((x) => x.key === weak.key)).toBe(false)
  const rec = () => listSessions().find((x) => x.key === strong.key)!
  expect(rec().waitingReasons.map((r) => r.kind).sort()).toEqual(["approval", "turn-end"])
  expect(rec().waitingKind).toBe("approval")
  // The turn-end kept its original stamp through the move.
  expect(rec().waitingReasons.find((r) => r.kind === "turn-end")?.since).toBe(stamp)

  // A header-less discovery tick must not blank the list.
  recordSession({ cwd: "/home/aubut/lanes/p6", tty: "/dev/pts/65", agentStatus: "busy" }, { provisional: true })
  expect(rec().waitingReasons.length).toBe(2)
  expect(rec().waitingKind).toBe("approval")
  clearAllWaiting()
})

test("an inject answers turn-end only, and the ambiguity count reads the raw reasons", () => {
  clearAllWaiting()
  const a = recordSession({ cwd: "/home/aubut/lanes/p7a", tty: "/dev/pts/66" })!
  const b = recordSession({ cwd: "/home/aubut/lanes/p7b", tty: "/dev/pts/67" })!

  // A is blocked on an approval only — typed text does not answer it, so it is
  // not a candidate and B is the single unambiguous turn-end waiter.
  setSessionWaiting(a.key, "approval", "appr-7")
  setSessionWaiting(b.key, "turn-end")
  const single = clearWaitingForTarget(null, "turn-end")
  expect(single.cleared?.key).toBe(b.key)
  expect(single.refused).toBe(0)
  // A's approval badge stays lit.
  expect(listSessions().find((x) => x.key === a.key)?.waitingKind).toBe("approval")

  // Now A holds turn-end AND approval: it must still COUNT as a turn-end
  // waiter, or naming nobody would silently clear B and leave A's turn-end lit
  // with no text delivered.
  setSessionWaiting(a.key, "turn-end")
  setSessionWaiting(b.key, "turn-end")
  const ambiguous = clearWaitingForTarget(null, "turn-end")
  expect(ambiguous.cleared).toBeNull()
  expect(ambiguous.refused).toBe(2)

  // Naming A clears its turn-end and nothing else.
  expect(clearWaitingForTarget(a, "turn-end").cleared?.key).toBe(a.key)
  const rec = listSessions().find((x) => x.key === a.key)!
  expect(rec.waitingKind).toBe("approval")
  expect(rec.waitingRef).toBe("appr-7")
  clearAllWaiting()
})
