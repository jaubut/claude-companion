import { describe, expect, test } from "bun:test"
import { BuilderJobStore, type BuilderJobsFrame, DROP_MS, MAX_JOBS, MAX_TOMBSTONES, STALE_MS, parseBuilderReport } from "./builder-jobs"

// Store-level: transitions, stale / drop timers, clear on DONE / ABORTED, validation.

function harness() {
  let now = 1_000_000
  const timers: Array<{ fn: () => void; at: number } | null> = []
  const frames: BuilderJobsFrame[] = []
  const store = new BuilderJobStore({
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, at: now + ms }),
    clearTimer: (h) => { timers[(h as number) - 1] = null },
    emit: (f) => frames.push(f),
  })
  // Advances the clock, firing due timers in order.
  const advance = (ms: number): void => {
    const end = now + ms
    for (;;) {
      const due = timers.map((t, i) => [t, i] as const).filter(([t]) => t && t.at <= end).sort((a, b) => a[0]!.at - b[0]!.at)[0]
      if (!due) break
      timers[due[1]] = null
      now = due[0]!.at
      due[0]!.fn()
    }
    now = end
  }
  const report = (body: Record<string, unknown>): void => store.report(parseBuilderReport(body)!)
  return { store, frames, advance, report, last: () => frames.at(-1)!.jobs }
}

describe("parseBuilderReport", () => {
  test("valid bodies; pct out of range or wrong type → indeterminate", () => {
    expect(parseBuilderReport({ event: "progress", id: "t-a.1", pct: 33.6, step: "rsync 34/87 GB" }))
      .toEqual({ event: "progress", id: "t-a.1", title: null, builder: null, pct: 34, step: "rsync 34/87 GB" })
    expect(parseBuilderReport({ event: "progress", id: "x", pct: 101 })?.pct).toBeNull()
    expect(parseBuilderReport({ event: "progress", id: "x", pct: "50" })?.pct).toBeNull()
    expect(parseBuilderReport({ event: "progress", id: "x", step: "a\nb\x1b[31m" })?.step).toBe("a b [31m")
    expect(parseBuilderReport({ event: "progress", id: "x", step: "s".repeat(300) })?.step?.length).toBe(120)
  })
  test("unusable bodies → null", () => {
    for (const b of [null, [], "x", { id: "x" }, { event: "ack", id: "x" }, { event: "done" }, { event: "done", id: "a b" }, { event: "done", id: "x".repeat(101) }])
      expect(parseBuilderReport(b)).toBeNull()
  })
})

describe("BuilderJobStore", () => {
  test("TASK → PROGRESS → DONE: shows then clears", () => {
    const h = harness()
    h.report({ event: "task", id: "t1", title: "Share 87 GB", builder: "builder-zettlab-x" })
    expect(h.last()).toEqual([{ id: "t1", title: "Share 87 GB", builder: "builder-zettlab-x", pct: null, step: null, startedAt: 1_000_000, updatedAt: 1_000_000, stale: false }])
    h.advance(5_000)
    h.report({ event: "progress", id: "t1", pct: 39, step: "rsync 34/87 GB" })
    expect(h.last()[0]).toMatchObject({ title: "Share 87 GB", pct: 39, step: "rsync 34/87 GB", updatedAt: 1_005_000, startedAt: 1_000_000 })
    h.report({ event: "progress", id: "t1", step: "previews" })
    expect(h.last()[0]).toMatchObject({ pct: null, step: "previews" })
    h.report({ event: "done", id: "t1" })
    expect(h.last()).toEqual([])
  })

  test("PROGRESS for an unknown id creates it (TASK missed); ABORTED clears; DONE for unknown id emits nothing", () => {
    const h = harness()
    h.report({ event: "progress", id: "t2", pct: 10, step: "s" })
    expect(h.last()[0]).toMatchObject({ id: "t2", title: "t2", builder: null, pct: 10 })
    h.report({ event: "aborted", id: "t2" })
    expect(h.last()).toEqual([])
    const n = h.frames.length
    h.report({ event: "done", id: "nope" })
    expect(h.frames.length).toBe(n)
  })

  test("TASK → DONE → late PROGRESS / TASK: stays gone (out-of-order POSTs)", () => {
    const h = harness()
    h.report({ event: "task", id: "t1", title: "x" })
    h.report({ event: "done", id: "t1" })
    const n = h.frames.length
    h.report({ event: "progress", id: "t1", pct: 90 })
    h.report({ event: "task", id: "t1", title: "x" })
    expect(h.frames.length).toBe(n)
    expect(h.store.frame().jobs).toEqual([])
  })

  test("DONE for an unknown id tombstones it; tombstones are bounded", () => {
    const h = harness()
    h.report({ event: "aborted", id: "u1" })
    h.report({ event: "progress", id: "u1", pct: 10 })
    expect(h.store.frame().jobs).toEqual([])
    for (let i = 0; i < MAX_TOMBSTONES; i++) h.report({ event: "done", id: `d${i}` })
    h.report({ event: "progress", id: "u1", pct: 10 })
    expect(h.last().map((j) => j.id)).toEqual(["u1"])
  })

  test("TASK re-send keeps progress", () => {
    const h = harness()
    h.report({ event: "progress", id: "t3", pct: 50, step: "half" })
    h.report({ event: "task", id: "t3", title: "Late title" })
    expect(h.last()[0]).toMatchObject({ title: "Late title", pct: 50, step: "half" })
  })

  test("stale after STALE_MS (frame re-sent), dropped after DROP_MS, a PROGRESS revives", () => {
    const h = harness()
    h.report({ event: "progress", id: "t4", pct: 5, step: "x" })
    h.advance(STALE_MS - 1)
    expect(h.last()[0]!.stale).toBe(false)
    h.advance(1)
    expect(h.last()[0]!.stale).toBe(true)
    h.report({ event: "progress", id: "t4", pct: 6, step: "y" })
    expect(h.last()[0]!.stale).toBe(false)
    h.advance(DROP_MS)
    expect(h.last()).toEqual([])
    expect(h.store.frame().jobs).toEqual([])
  })

  test("MAX_JOBS evicts the least recently updated", () => {
    const h = harness()
    for (let i = 0; i < MAX_JOBS + 1; i++) { h.report({ event: "task", id: `j${i}` }); h.advance(1) }
    const ids = h.last().map((j) => j.id)
    expect(ids.length).toBe(MAX_JOBS)
    expect(ids).not.toContain("j0")
  })
})
