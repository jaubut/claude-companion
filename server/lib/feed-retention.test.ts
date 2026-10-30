import { test, expect, describe, beforeEach } from "bun:test"
import { appendFeedEvent, getFeed, onFeedEvict, sessionRetention, setFeedRetention, type FeedEvent } from "./feed"

// Build 68: an idle session's chat showed "waiting for activity" — its events
// had all left the shared 200-cap feed while other sessions kept working, so
// the init replay after a reconnect carried nothing for it. A listed session
// now keeps its newest 40 events past the cap.

let seq = 0
const ev = (over: Partial<FeedEvent> = {}): FeedEvent => ({
  id: `retention-${++seq}`,
  ts: Date.now(),
  kind: "tool_start",
  ...over,
})
const session = (n: string) => ({ key: `claude:tty:/dev/pts/${n}`, sessionId: `sid-${n}`, tty: `/dev/pts/${n}` })
const of = (tty: string) => getFeed().filter((e) => e.tty === tty)

beforeEach(() => {
  // Flush whatever an earlier test left, with retention off.
  setFeedRetention(null)
  for (let i = 0; i < 600; i++) appendFeedEvent(ev({ tty: "/dev/flush" }))
})

describe("feed retention for live sessions", () => {
  test("an idle session's conversation survives a busy session's 300 events", () => {
    setFeedRetention(sessionRetention([session("4"), session("3")]))
    const idle = Array.from({ length: 10 }, () => ev({ tty: "/dev/pts/4", sessionId: "sid-4" }))
    for (const e of idle) appendFeedEvent(e)
    for (let i = 0; i < 300; i++) appendFeedEvent(ev({ tty: "/dev/pts/3" }))
    expect(of("/dev/pts/4").map((e) => e.id)).toEqual(idle.map((e) => e.id))
    expect(getFeed()).toHaveLength(200)
    expect(getFeed().some((e) => e.tty === "/dev/flush")).toBe(false)
  })

  test("a long idle conversation keeps exactly its newest 40", () => {
    setFeedRetention(sessionRetention([session("4"), session("3")]))
    const idle = Array.from({ length: 60 }, () => ev({ sessionId: "sid-4" }))
    for (const e of idle) appendFeedEvent(e)
    for (let i = 0; i < 300; i++) appendFeedEvent(ev({ tty: "/dev/pts/3" }))
    expect(getFeed().filter((e) => e.sessionId === "sid-4").map((e) => e.id)).toEqual(idle.slice(20).map((e) => e.id))
    expect(getFeed()).toHaveLength(200)
  })

  test("a session no longer listed is evicted oldest-first as before", () => {
    setFeedRetention(sessionRetention([session("4"), session("3")]))
    for (let i = 0; i < 10; i++) appendFeedEvent(ev({ tty: "/dev/pts/4" }))
    setFeedRetention(sessionRetention([session("3")])) // pts/4 ended
    const evicted: string[] = []
    const off = onFeedEvict((gone) => { for (const e of gone) evicted.push(e.tty ?? "") })
    for (let i = 0; i < 300; i++) appendFeedEvent(ev({ tty: "/dev/pts/3" }))
    off()
    expect(of("/dev/pts/4")).toHaveLength(0)
    expect(evicted.filter((t) => t === "/dev/pts/4")).toHaveLength(10)
  })

  test("the total never exceeds 600 however many sessions are listed", () => {
    const many = Array.from({ length: 20 }, (_, i) => session(`m${i}`))
    setFeedRetention(sessionRetention(many))
    for (const s of many) for (let i = 0; i < 40; i++) appendFeedEvent(ev({ tty: s.tty }))
    expect(getFeed()).toHaveLength(600)
  })

  test("matches an event by key, sessionId or tty", () => {
    const r = sessionRetention([session("4")])
    expect(r(ev({ key: "claude:tty:/dev/pts/4" }))).toBe("claude:tty:/dev/pts/4")
    expect(r(ev({ sessionId: "sid-4" }))).toBe("claude:tty:/dev/pts/4")
    expect(r(ev({ tty: "/dev/pts/4" }))).toBe("claude:tty:/dev/pts/4")
    expect(r(ev({ tty: "/dev/pts/9", key: "codex:x" }))).toBeNull()
  })
})
