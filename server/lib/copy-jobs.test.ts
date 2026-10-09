import { beforeEach, describe, expect, test } from "bun:test"
import {
  CopyJobStore, type CopyJobsFrame, type CopyReport, EMIT_MIN_MS, FINISHED_KEEP_MS, MAX_JOBS, STALE_MS,
  etaOf, parseCopyReport, rateOf, stateOf,
} from "./copy-jobs"

// Fake clock + manual timers: everything the store does on time is driven here.
let now: number
let timers: Array<{ at: number; fn: () => void; dead: boolean }>
let frames: CopyJobsFrame[]
let keys: Map<string, string>
let store: CopyJobStore

function advance(ms: number): void {
  const until = now + ms
  for (;;) {
    const next = timers.filter((t) => !t.dead && t.at <= until).sort((a, b) => a.at - b.at)[0]
    if (!next) break
    now = next.at
    next.dead = true
    next.fn()
  }
  now = until
}

beforeEach(() => {
  now = 1_000_000
  timers = []
  frames = []
  keys = new Map([["sid-a", "claude:tty:/dev/ttys001"]])
  store = new CopyJobStore({
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn, dead: false }; timers.push(t); return t },
    clearTimer: (h) => { (h as { dead: boolean }).dead = true },
    resolveKey: (sid) => keys.get(sid) ?? null,
    emit: (f) => frames.push(f),
  })
})

function rep(over: Partial<CopyReport> = {}): CopyReport {
  return {
    sessionId: "sid-a", jobId: "job-a.log", label: "cam A", startedAt: now - 10_000, copyStartedAt: null,
    totalFiles: 4, totalBytes: 4_000_000_000, doneFiles: 0, doneBytes: 0, current: null, failed: 0, finished: false, at: now,
    ...over,
  }
}

const job = (id = "job-a.log") => store.snapshot().jobs.find((j) => j.jobId === id)

describe("parseCopyReport", () => {
  test("full body maps every field", () => {
    expect(parseCopyReport({
      session_id: "u1", job_id: "a.log", label: "cam A", started_at: 1000, copy_started_at: 2000,
      total_files: 4, total_bytes: 4000, done_files: 1, done_bytes: 1000, current: "A001.MP4", failed: 0, finished: false, at: 3000,
    })).toEqual({
      sessionId: "u1", jobId: "a.log", label: "cam A", startedAt: 1000, copyStartedAt: 2000,
      totalFiles: 4, totalBytes: 4000, doneFiles: 1, doneBytes: 1000, current: "A001.MP4", failed: 0, finished: false, at: 3000,
    })
  })

  test("only job_id is required; null, missing and mistyped fields are absent", () => {
    expect(parseCopyReport({ job_id: "a.log", session_id: 5, label: "", total_files: "4", done_bytes: -1, copy_started_at: null, finished: "yes", current: 7 }))
      .toEqual({
        sessionId: null, jobId: "a.log", label: null, startedAt: null, copyStartedAt: null,
        totalFiles: null, totalBytes: null, doneFiles: null, doneBytes: null, current: null, failed: null, finished: false, at: null,
      })
  })

  test("unusable bodies", () => {
    for (const b of [null, "x", [], {}, { job_id: "" }, { job_id: "  " }, { job_id: 7 }, { job_id: "x".repeat(201) }]) {
      expect(parseCopyReport(b)).toBeNull()
    }
    expect(parseCopyReport({ job_id: "x".repeat(200) })?.jobId).toHaveLength(200)
  })
})

describe("derived fields", () => {
  test("state: hashing until the copy starts; done / failed once finished", () => {
    expect(stateOf({ finished: false, failed: 0, copyStartedAt: null })).toBe("hashing")
    expect(stateOf({ finished: false, failed: 2, copyStartedAt: 5 })).toBe("copying")
    expect(stateOf({ finished: true, failed: 0, copyStartedAt: 5 })).toBe("done")
    expect(stateOf({ finished: true, failed: 1, copyStartedAt: 5 })).toBe("failed")
  })

  test("rate = average since copyStartedAt; ETA = remaining / rate; null without data", () => {
    expect(rateOf(1_000_000_000, 0, 60_000)).toBe(16_666_667)
    expect(etaOf(4_000_000_000, 1_000_000_000, 16_666_667)).toBe(180)
    expect(rateOf(0, 0, 60_000)).toBeNull()
    expect(rateOf(5, null, 60_000)).toBeNull()
    expect(rateOf(5, 60_000, 60_000)).toBeNull()
    expect(etaOf(5, 1, null)).toBeNull()
  })
})

describe("CopyJobStore", () => {
  test("report → item with derived state, rate, ETA and resolved key; frame emitted", () => {
    store.report(rep({ copyStartedAt: now - 60_000, doneFiles: 1, doneBytes: 1_000_000_000, current: "A001.MP4" }))
    const snap = store.snapshot()
    expect(snap).toEqual({
      ok: true,
      jobs: [{
        jobId: "job-a.log", sessionKey: "claude:tty:/dev/ttys001", label: "cam A", state: "copying",
        totalFiles: 4, doneFiles: 1, totalBytes: 4_000_000_000, doneBytes: 1_000_000_000, failed: 0, current: "A001.MP4",
        startedAt: now - 10_000, copyStartedAt: now - 60_000, finishedAt: null, bytesPerSec: 16_666_667, etaSec: 180, at: now,
      }],
    })
    expect(frames).toEqual([{ type: "copy_jobs", jobs: snap.jobs, at: now }])
  })

  test("hashing: no rate, no ETA; unknown session → null key, still listed; label defaults to the job id", () => {
    store.report(rep({ sessionId: "sid-unknown", label: null }))
    expect(job()).toMatchObject({ state: "hashing", sessionKey: null, label: "job-a.log", bytesPerSec: null, etaSec: null })
    store.report(rep({ sessionId: null }))
    expect(job()?.sessionKey).toBeNull() // keeps the session id it had, still unknown
    keys.set("sid-unknown", "claude:tty:/dev/ttys009")
    expect(job()?.sessionKey).toBe("claude:tty:/dev/ttys009")
  })

  test("startedAt / copyStartedAt are sticky: later reports never move them", () => {
    const t0 = now
    store.report(rep({ startedAt: t0 - 5_000 }))
    store.report(rep({ startedAt: t0 + 99_000, copyStartedAt: t0 + 1_000 }))
    store.report(rep({ startedAt: t0 + 99_000, copyStartedAt: t0 + 50_000 }))
    expect(job()).toMatchObject({ startedAt: t0 - 5_000, copyStartedAt: t0 + 1_000 })
  })

  test("startedAt falls back to the reporter's time, then receipt", () => {
    store.report(rep({ startedAt: null, at: 777 }))
    expect(job()?.startedAt).toBe(777)
    store.report(rep({ jobId: "job-b.log", startedAt: null, at: null }))
    expect(job("job-b.log")?.startedAt).toBe(now)
  })

  test("totals keep the last non-zero value (the mod reports 0 on a parse miss)", () => {
    store.report(rep({ totalFiles: 4, totalBytes: 4_000 }))
    store.report(rep({ totalFiles: 0, totalBytes: 0 }))
    expect(job()).toMatchObject({ totalFiles: 4, totalBytes: 4_000 })
    store.report(rep({ totalFiles: 5, totalBytes: 5_000 }))
    expect(job()).toMatchObject({ totalFiles: 5, totalBytes: 5_000 })
  })

  test("finished: done or failed, finishedAt stamped once, kept 60 s then a frame without it", () => {
    store.report(rep({ jobId: "ok.log", copyStartedAt: now - 10_000, doneFiles: 4, doneBytes: 4_000, finished: true }))
    store.report(rep({ jobId: "bad.log", copyStartedAt: now - 10_000, doneFiles: 4, doneBytes: 4_000, failed: 1, finished: true }))
    const stamped = now
    expect(job("ok.log")).toMatchObject({ state: "done", finishedAt: stamped, etaSec: null, current: null })
    expect(job("bad.log")).toMatchObject({ state: "failed", failed: 1, finishedAt: stamped })
    advance(10_000)
    store.report(rep({ jobId: "ok.log", finished: false })) // a late tick never un-finishes
    expect(job("ok.log")).toMatchObject({ state: "done", finishedAt: stamped })
    advance(FINISHED_KEEP_MS - 10_001)
    expect(store.snapshot().jobs).toHaveLength(2)
    const before = frames.length
    advance(1) // the sweep timer, no read needed
    expect(frames.length).toBe(before + 1)
    expect(frames.at(-1)).toEqual({ type: "copy_jobs", jobs: [], at: now })
  })

  test("unfinished with no report for 120 s → dropped; a report keeps it alive", () => {
    store.report(rep())
    advance(STALE_MS - 1_000)
    store.report(rep())
    advance(STALE_MS - 1)
    expect(store.snapshot().jobs).toHaveLength(1)
    advance(1)
    expect(store.snapshot().jobs).toHaveLength(0)
    expect(frames.at(-1)?.jobs).toEqual([])
  })

  test("frames throttled to 1 / 2 s per host, trailing frame carries the latest list", () => {
    store.report(rep({ doneFiles: 1 }))
    store.report(rep({ doneFiles: 2 }))
    store.report(rep({ jobId: "job-b.log", doneFiles: 7 })) // same host: same budget
    expect(frames.map((f) => f.jobs.map((j) => j.doneFiles))).toEqual([[1]])
    advance(EMIT_MIN_MS - 1)
    expect(frames).toHaveLength(1)
    advance(1)
    expect(frames).toHaveLength(2)
    expect(frames[1]!.jobs.map((j) => [j.jobId, j.doneFiles])).toEqual([["job-a.log", 2], ["job-b.log", 7]])
    advance(10 * EMIT_MIN_MS)
    expect(frames).toHaveLength(2) // nothing new → nothing sent
    store.report(rep({ doneFiles: 3 })) // every accepted report emits (keeps `at` live)
    expect(frames).toHaveLength(3)
  })

  test("MAX_JOBS: the oldest finished job is evicted first, else the least recently reported", () => {
    for (let i = 0; i < MAX_JOBS; i++) {
      store.report(rep({ jobId: `j${i}`, finished: i === 5 || i === 9 }))
      advance(10)
    }
    store.report(rep({ jobId: "new-1" }))
    let ids = store.snapshot().jobs.map((j) => j.jobId)
    expect(ids).toHaveLength(MAX_JOBS)
    expect(ids).not.toContain("j5")
    expect(ids).toContain("j9")
    store.report(rep({ jobId: "new-2" }))
    store.report(rep({ jobId: "new-3" }))
    ids = store.snapshot().jobs.map((j) => j.jobId)
    expect(ids).toHaveLength(MAX_JOBS)
    expect(ids).not.toContain("j9")
    expect(ids).not.toContain("j0") // no finished left → least recently reported
    expect(ids).toContain("j1")
  })

  test("frame() is the current list; stop() clears jobs and timers", () => {
    expect(store.frame()).toEqual({ type: "copy_jobs", jobs: [], at: now })
    store.report(rep())
    store.report(rep({ doneFiles: 1 })) // trailing frame pending
    expect(store.frame().jobs).toHaveLength(1)
    store.stop()
    expect(store.frame().jobs).toEqual([])
    const before = frames.length
    advance(STALE_MS * 2)
    expect(frames).toHaveLength(before)
  })
})
