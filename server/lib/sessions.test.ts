import { test, expect } from "bun:test"
import { recordSession, listSessions, setSessionTitle, setTitleResolver, ttyTag, onSessions, metaFromHeaders, removeSessionByTmuxPane } from "./sessions"

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
