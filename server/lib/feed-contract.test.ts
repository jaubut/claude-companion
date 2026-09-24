import { test, expect, describe, afterAll } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { appendFeedEvent, getFeed, pruneFeedForSession, FEED_EVENT_KINDS, type FeedEvent } from "./feed"
import { CONTRACT_FIXTURES_DIR, IOS_FIXTURES_DIR, listFixtures } from "../../scripts/contracts-sync"

// FeedEvent wire contract. contracts/feed-events/ holds one fixture per kind
// (every field that kind carries) plus `.minimal` (required fields only) and
// `unknown-kind.json` (forward-compat). The iOS repo decodes a synced copy.

const UNKNOWN = "unknown-kind.json"
const KINDS: readonly string[] = FEED_EVENT_KINDS
const files = listFixtures(CONTRACT_FIXTURES_DIR)
const known = files.filter((f) => f !== UNKNOWN)
const read = (f: string): unknown => JSON.parse(readFileSync(join(CONTRACT_FIXTURES_DIR, f), "utf8"))

describe("feed-event fixtures", () => {
  // The round-trip case appends every fixture to the shared in-memory feed;
  // drop them so a later file counting events for that tty is not confused.
  afterAll(() => { pruneFeedForSession({ tty: "/dev/ttys004" }) })
  test("every kind has a full and a minimal fixture, plus unknown-kind", () => {
    const expected = [...FEED_EVENT_KINDS.flatMap((k) => [`${k}.json`, `${k}.minimal.json`]), UNKNOWN].sort()
    expect(files).toEqual(expected)
  })

  for (const f of known) {
    test(`${f} parses, has a known kind, round-trips through the feed`, () => {
      const raw = read(f) as Record<string, unknown>
      expect(typeof raw.id).toBe("string")
      expect(typeof raw.ts).toBe("number")
      expect(KINDS).toContain(raw.kind as string)
      expect(f.startsWith(`${raw.kind as string}.`)).toBe(true)

      const ev = raw as unknown as FeedEvent
      appendFeedEvent(ev)
      const stored = getFeed().find((x) => x.id === ev.id)
      expect(stored).toEqual(ev)
      expect(JSON.parse(JSON.stringify(stored))).toEqual(raw)
    })
  }

  test("unknown-kind.json parses and is rejected by FEED_EVENT_KINDS", () => {
    const raw = read(UNKNOWN) as Record<string, unknown>
    expect(typeof raw.kind).toBe("string")
    expect(KINDS).not.toContain(raw.kind as string)
  })
})

// DRIFT: the iOS repo's copy must be byte-identical. Hosts without the iOS
// repo (CI, Zettlab) skip loudly rather than pass silently.
const iosPresent = existsSync(IOS_FIXTURES_DIR)
if (!iosPresent) {
  console.log(`[feed-contract] drift check SKIPPED — iOS fixtures dir not found: ${IOS_FIXTURES_DIR}`)
}

describe("feed-event fixture drift vs iOS repo", () => {
  test.skipIf(!iosPresent)("iOS fixture set matches ours", () => {
    expect(listFixtures(IOS_FIXTURES_DIR)).toEqual(files)
  })

  test.skipIf(!iosPresent)("every iOS fixture is byte-identical (run `bun run contracts:sync`)", () => {
    for (const f of files) {
      const theirs = join(IOS_FIXTURES_DIR, f)
      expect(existsSync(theirs)).toBe(true)
      const a = readFileSync(join(CONTRACT_FIXTURES_DIR, f))
      const b = readFileSync(theirs)
      expect({ file: f, same: a.equals(b) }).toEqual({ file: f, same: true })
    }
  })
})
