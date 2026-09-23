import { test, expect, describe } from "bun:test"
import { appendFeedEvent, getFeed, onFeedEvict, onFeedReset, pruneFeedForSession, type FeedEvent } from "./feed"

// The evict signal: fires on the 200-cap trim and on session prune, once,
// after the splice, with a copy. The feed store is module-global and shared
// with other test files in this process, so every test fills or tags its own
// events rather than assuming an empty feed.

const CAP = 200
let seq = 0
const ev = (over: Partial<FeedEvent> = {}): FeedEvent => ({
  id: `feedtest-${++seq}`,
  ts: Date.now(),
  kind: "tool_start",
  ...over,
})

describe("onFeedEvict", () => {
  test("201st append evicts exactly the oldest event", () => {
    const mine = Array.from({ length: CAP }, () => ev())
    for (const e of mine) appendFeedEvent(e) // feed is now exactly ours
    const calls: FeedEvent[][] = []
    const off = onFeedEvict((evicted) => { calls.push(evicted) })
    appendFeedEvent(ev())
    off()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.map((e) => e.id)).toEqual([mine[0]!.id])
    expect(getFeed()).toHaveLength(CAP)
  })

  test("a duplicate id is a no-op and evicts nothing", () => {
    const e = ev()
    appendFeedEvent(e)
    let fired = 0
    const off = onFeedEvict(() => { fired++ })
    appendFeedEvent({ ...e })
    off()
    expect(fired).toBe(0)
  })

  test("fires after the splice: the listener no longer sees evicted events in the feed", () => {
    for (let i = 0; i < CAP; i++) appendFeedEvent(ev())
    let stillThere = true
    const off = onFeedEvict((evicted) => {
      const live = new Set(getFeed().map((e) => e.id))
      stillThere = evicted.some((e) => live.has(e.id))
    })
    appendFeedEvent(ev())
    off()
    expect(stillThere).toBe(false)
  })

  test("session prune: evict and feed_pruned carry the same ids", () => {
    const tty = "/dev/feedtest-prune"
    const ours = [ev({ tty }), ev({ tty }), ev({ sessionId: "feedtest-sid" })]
    for (const e of ours) appendFeedEvent(e)
    appendFeedEvent(ev({ tty: "/dev/other" }))
    let resetIds: string[] = []
    let evictIds: string[] = []
    const offR = onFeedReset((ids) => { resetIds = ids })
    const offE = onFeedEvict((evicted) => { evictIds = evicted.map((e) => e.id) })
    pruneFeedForSession({ tty, sessionId: "feedtest-sid" })
    offR(); offE()
    expect(resetIds.slice().sort()).toEqual(ours.map((e) => e.id).sort())
    expect(evictIds).toEqual(resetIds) // same set, same order
    // feed_pruned payload shape unchanged: plain string ids, reverse feed order.
    expect(resetIds).toEqual(ours.map((e) => e.id).reverse())
  })

  test("each listener gets its own copy", () => {
    for (let i = 0; i < CAP; i++) appendFeedEvent(ev())
    let second: FeedEvent[] = []
    const off1 = onFeedEvict((evicted) => { evicted.length = 0 })
    const off2 = onFeedEvict((evicted) => { second = evicted })
    appendFeedEvent(ev())
    off1(); off2()
    expect(second).toHaveLength(1)
  })

  test("a re-entrant append from an evict listener leaves no matching event and no duplicate", () => {
    const tty = "/dev/feedtest-reentrant"
    const ours = [ev({ tty }), ev({ tty }), ev({ tty })]
    for (const e of ours) appendFeedEvent(e)
    const before = getFeed().length
    const extra = ev({ tty: "/dev/feedtest-elsewhere" })
    const off = onFeedEvict(() => { appendFeedEvent(extra) })
    pruneFeedForSession({ tty })
    off()
    const after = getFeed()
    expect(after.some((e) => e.tty === tty)).toBe(false)
    expect(after.filter((e) => e.id === extra.id)).toHaveLength(1)
    expect(new Set(after.map((e) => e.id)).size).toBe(after.length)
    expect(after.length).toBe(Math.min(CAP, before - ours.length + 1))
  })

  test("a prune with no match fires nothing", () => {
    let fired = 0
    const off = onFeedEvict(() => { fired++ })
    pruneFeedForSession({ tty: "/dev/feedtest-nobody" })
    off()
    expect(fired).toBe(0)
  })
})
