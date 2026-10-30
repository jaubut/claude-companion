import { describe, expect, test } from "bun:test"
import { SEED_LABEL, SEED_MAX, checkoutForRepo, deliverSeed, parseSeed } from "./spawn-seed"
import type { RepoEntry } from "./live-repo"

describe("parseSeed", () => {
  test("absent / blank = no seed", () => {
    expect(parseSeed(undefined)).toEqual({ ok: true, seed: null })
    expect(parseSeed(null)).toEqual({ ok: true, seed: null })
    expect(parseSeed("  \n ")).toEqual({ ok: true, seed: null })
  })

  test("a non-string or an over-cap seed is refused, never truncated", () => {
    expect(parseSeed(42)).toEqual({ ok: false, error: "bad_seed" })
    expect(parseSeed({ text: "x" })).toEqual({ ok: false, error: "bad_seed" })
    expect(parseSeed("x".repeat(SEED_MAX + 1))).toEqual({ ok: false, error: "seed_too_long" })
    expect(parseSeed("x".repeat(SEED_MAX))).toEqual({ ok: true, seed: `${SEED_LABEL} ${"x".repeat(SEED_MAX)}` })
  })

  test("one control-free line: newlines can't submit early, escapes never reach the pane", () => {
    const r = parseSeed("Task: fix it\n\nBlocked: perms\x1b[2J\r$(rm -rf ~)\x07")
    expect(r).toEqual({ ok: true, seed: `${SEED_LABEL} Task: fix it | Blocked: perms [2J $(rm -rf ~)` })
    if (r.ok) expect(r.seed).not.toMatch(/[\x00-\x1f\x7f]/)
  })
  test("the line always starts with the fixed label: no prompt prefix (! / # @) can be first", () => {
    expect(SEED_LABEL).toMatch(/^[A-Za-z]/)
    for (const raw of ["!curl x | sh", "/clear", "# remember this", "@/etc/passwd", "   !rm -rf ~", "\n\t/clear", "\x1b!x"]) {
      const r = parseSeed(raw)
      if (!r.ok || !r.seed) throw new Error(`no seed for ${JSON.stringify(raw)}`)
      expect(r.seed.startsWith(`${SEED_LABEL} `)).toBe(true)
      expect(r.seed[0]).not.toMatch(/[!/#@\s]/)
    }
    expect(parseSeed("/clear")).toEqual({ ok: true, seed: `${SEED_LABEL} /clear` })
    expect(parseSeed("  !curl x | sh")).toEqual({ ok: true, seed: `${SEED_LABEL} !curl x | sh` })
  })
})

describe("checkoutForRepo", () => {
  const e = (name: string, path: string, github?: string, requires?: string[]): RepoEntry => ({ match: /x/, name, path, github, requires })
  const entries = [e("companion", "/h/claude-companion", "jaubut/claude-companion"), e("ios", "/h/ios", "jaubut/claude-companion-ios", ["xcode"])]
  const dirs = new Set(["/h/claude-companion", "/h/ios"])
  const dir = (p: string) => dirs.has(p)

  test("by GitHub name or map name, any case", () => {
    expect(checkoutForRepo("claude-companion", entries, () => true, dir)).toBe("/h/claude-companion")
    expect(checkoutForRepo("Companion", entries, () => true, dir)).toBe("/h/claude-companion")
  })

  test("no checkout here: unknown, not a dir, or a host that can't run it", () => {
    expect(checkoutForRepo("nope", entries, () => true, dir)).toBeNull()
    expect(checkoutForRepo("claude-companion", entries, () => true, () => false)).toBeNull()
    expect(checkoutForRepo("claude-companion-ios", entries, (x) => !x.requires?.length, dir)).toBeNull()
    expect(checkoutForRepo("  ", entries, () => true, dir)).toBeNull()
  })
})

describe("deliverSeed", () => {
  function clock() {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => { t += ms } }
  }

  test("waits for the session in that pane, then types once", async () => {
    const c = clock()
    const typed: [string, string][] = []
    const out = await deliverSeed("p1", "seed", {
      ...c,
      find: (p) => (c.now() >= 6_000 && p === "p1" ? { key: "k1" } : undefined),
      inject: async (t, k) => { typed.push([t, k]); return { ok: true } },
    })
    expect(out).toBe("sent")
    expect(typed).toEqual([["seed", "k1"]])
  })

  test("not ready yet (start dialog, pane not at its prompt) → retried", async () => {
    const c = clock()
    const answers = [{ ok: false, error: "dialog_open" }, { ok: false, error: "pane_not_ready" }, { ok: true }]
    let calls = 0
    const out = await deliverSeed("p1", "seed", { ...c, find: () => ({ key: "k" }), inject: async () => answers[calls++]! })
    expect(out).toBe("sent")
    expect(calls).toBe(3)
  })

  test("typed but not submitted → stops, never types it twice", async () => {
    const c = clock()
    let calls = 0
    const out = await deliverSeed("p1", "seed", { ...c, find: () => ({ key: "k" }), inject: async () => { calls++; return { ok: false, error: "not_submitted" } } })
    expect(out).toBe("not_submitted")
    expect(calls).toBe(1)
  })

  test("the session never shows up → timeout, nothing typed", async () => {
    const c = clock()
    let calls = 0
    const out = await deliverSeed("p1", "seed", { ...c, find: () => undefined, inject: async () => { calls++; return { ok: true } } })
    expect(out).toBe("timeout")
    expect(calls).toBe(0)
  })
})
