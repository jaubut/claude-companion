import { describe, expect, test } from "bun:test"
import { rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type GateDeps, GATE_BUDGET_MS, mergeGate } from "./merge-gate"
import { STUB_GATE, writeStubTools } from "./merge-gate.test-util"
import { type GhFn, GhUnreachable } from "./triage-pr"
import type { ExecFn } from "./turso"

// The gate's loader and every way it fails closed. The acceptance matrix on both callers is
// wiring/merge-gate-callers.test.ts.

const URL = "https://github.com/o/r/pull/7"
const SHA = "1111111111111111111111111111111111111111"
const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" })

function world(over: { heads?: string[]; bases?: string[]; files?: string; origin?: string | null; labels?: string[]; failOn?: string; hang?: string; turso?: "down"; diff?: string } = {}): GateDeps {
  const heads = [...(over.heads ?? [SHA])]
  const bases = [...(over.bases ?? ["main"])]
  const gh: GhFn = async (args) => {
    const what = args[0] === "api" ? "files" : args[1] === "diff" ? "diff" : "view"
    if (over.hang === what) return new Promise(() => {})
    if (over.failOn === what) return { code: 1, stdout: "", stderr: "HTTP 502" }
    if (what === "files") return ok(over.files ?? "server/lib/a.ts\t\n")
    if (what === "diff") return ok(over.diff ?? "diff --git a/server/lib/a.ts b/server/lib/a.ts\n")
    const head = heads.length > 1 ? heads.shift() : heads[0]
    const base = bases.length > 1 ? bases.shift() : bases[0]
    return ok(JSON.stringify({ url: URL, headRefOid: head, baseRefName: base, labels: (over.labels ?? []).map((name) => ({ name })) }))
  }
  const exec: ExecFn = async () => {
    if (over.turso) throw new Error("turso down")
    return { rows: over.origin === undefined ? [{ origin: "jeremie" }] : over.origin === null ? [] : [{ origin: over.origin }], affected: 0 }
  }
  return { gh, exec }
}

const unavailable = (detail: string) => ({ ok: false as const, status: 409, error: "gate_unavailable", extra: { detail } })
const run = (deps: GateDeps, tools: string, budgetMs?: number) => mergeGate(deps, { url: URL }, { tools, budgetMs })

describe("mergeGate: the verdict", () => {
  const tools = writeStubTools()
  test("a routine PR passes at the head it read", async () => {
    expect(await run(world(), tools)).toEqual({ ok: true, head: SHA, base: "main" })
  })
  test("a stop is a 403 named after it, carrying action, reason and head", async () => {
    expect(await run(world({ files: "hooks/guard.py\t\n" }), tools)).toEqual({
      ok: false, status: 403, error: "human-merge-path", extra: { action: "park", reason: "touches hooks/guard.py — human merge only", head: SHA },
    })
  })
  test("a reason built from PR-controlled paths is capped", async () => {
    const out = await run(world({ files: `hooks/${"x".repeat(1000)}.py\t\n` }), tools)
    expect(out.ok === false && String(out.extra.reason).length).toBe(300)
  })
  test("no task reads as unknown, so tainted: a sensitive path stops", async () => {
    const diff = "diff --git a/memory/x.md b/memory/x.md\n"
    expect(await run(world({ origin: null, files: "memory/x.md\t\n", diff }), tools)).toMatchObject({ status: 403, error: "tainted-sensitive" })
  })
  test("a tainted PR on plain paths passes", async () => {
    expect(await run(world({ origin: "web" }), tools)).toEqual({ ok: true, head: SHA, base: "main" })
  })
  test("a doc about a migration passes for a trusted origin", async () => {
    expect(await run(world({ files: "docs/herdr-only-migration.md\t\n" }), tools)).toEqual({ ok: true, head: SHA, base: "main" })
  })
  test("a failed diff on a tainted PR stops it; a trusted PR never reads the diff", async () => {
    expect(await run(world({ origin: "web", failOn: "diff" }), tools)).toMatchObject({ status: 403, error: "tainted-sensitive" })
    expect(await run(world({ failOn: "diff" }), tools)).toEqual({ ok: true, head: SHA, base: "main" })
  })
  test("the head read twice: a push during the gate is 409 head_moved, even on a stopped PR", async () => {
    expect(await run(world({ heads: [SHA, "2222"], files: "hooks/guard.py\t\n" }), tools)).toEqual({ ok: false, status: 409, error: "head_moved", extra: {} })
  })
  test("the base read twice: a retarget during the gate is 409 base_moved, even on a stopped PR", async () => {
    expect(await run(world({ bases: ["main", "release"], files: "hooks/guard.py\t\n" }), tools)).toEqual({ ok: false, status: 409, error: "base_moved", extra: {} })
  })
  test("a moved head outranks a moved base: one answer, the head's", async () => {
    expect(await run(world({ heads: [SHA, "2222"], bases: ["main", "release"] }), tools)).toMatchObject({ error: "head_moved" })
  })
})

describe("mergeGate: loading", () => {
  test("a newer mtime loads the new gate with no restart", async () => {
    const tools = writeStubTools()
    const pr = world({ files: "tools/new.ts\t\n" })
    expect(await run(pr, tools)).toEqual({ ok: true, head: SHA, base: "main" })
    const file = join(tools, "pr-gate.ts")
    writeFileSync(file, STUB_GATE.replace('const human = g.paths.filter((p) => HUMAN_MERGE_RE.test(p));', 'const human = g.paths.filter((p) => HUMAN_MERGE_RE.test(p) || p === "tools/new.ts");'))
    utimesSync(file, new Date(), new Date(Date.now() + 60_000))
    expect(await run(pr, tools)).toMatchObject({ status: 403, error: "human-merge-path" })
  })
  test("the default budget stays inside the iOS 30 s choose timeout", () => {
    expect(GATE_BUDGET_MS).toBeLessThan(30_000)
  })
})

describe("mergeGate: fails closed", () => {
  for (const file of ["pr-gate.ts", "dep-lane.ts", "pr-shepherd-policy.ts", "client-origin.ts"]) {
    test(`${file} missing`, async () => {
      const tools = writeStubTools()
      rmSync(join(tools, file))
      expect(await run(world(), tools)).toEqual(unavailable(`${file} missing on this host`))
    })
  }
  test("no tools dir at all", async () => {
    expect(await run(world(), "/nonexistent/tools")).toEqual(unavailable("pr-gate.ts missing on this host"))
  })
  test("a bad export", async () => {
    const tools = writeStubTools({ "pr-gate.ts": STUB_GATE.replace("export function gateVerdict", "function gateVerdict") })
    expect(await run(world(), tools)).toEqual(unavailable("gate self-check failed"))
  })
  test("an import that throws", async () => {
    expect(await run(world(), writeStubTools({ "dep-lane.ts": 'throw new Error("boom")\n' }))).toEqual(unavailable("gate error"))
  })
  test("a syntax error in the file", async () => {
    expect(await run(world(), writeStubTools({ "pr-gate.ts": "export const = 1\n" }))).toEqual(unavailable("gate error"))
  })
  for (const [what, gate] of [
    ["an older gate with no human list", STUB_GATE.replace('if (human.length) return', 'if (false) return')],
    ["a gate that passes tainted PRs", STUB_GATE.replace('if (g.taint?.sensitive.length) return', 'if (false) return')],
    ["a gate that lifts taint on approval", STUB_GATE.replace('if (g.taint?.truncated)', 'if (g.approved) return null;\n  if (g.taint?.truncated)')],
    ["a gate that dropped the label stop", STUB_GATE.replace('if (g.holdLabels?.length) return', 'if (false) return')],
    ["a gate that dropped the prod-schema stop", STUB_GATE.replace('if (schema.length) return', 'if (false) return')],
    ["a gate that stops everything", STUB_GATE.replace('const human = g.paths.filter((p) => HUMAN_MERGE_RE.test(p));', 'const human = g.paths;')],
    ["a reworded reason bin/pr-merge would retire", STUB_GATE.replaceAll("human merge", "needs your review")],
  ] as const) {
    test(`self-check: ${what}`, async () => {
      expect(await run(world(), writeStubTools({ "pr-gate.ts": gate }))).toEqual(unavailable("gate self-check failed"))
    })
  }
  for (const word of ["auth", "token"]) {
    test(`self-check: a SENSITIVE_RE that lost ${word}`, async () => {
      const lane = `export const SENSITIVE_RE = /${word === "auth" ? "token" : "auth"}|^memory\\//i;\n`
      expect(await run(world(), writeStubTools({ "dep-lane.ts": lane }))).toEqual(unavailable("gate self-check failed"))
    })
  }
  test("a gateVerdict that throws on the real input, after passing the self-check", async () => {
    const tools = writeStubTools({ "pr-gate.ts": STUB_GATE.replace("export function gateVerdict(g) {", 'export function gateVerdict(g) {\n  if (g.paths.includes("boom.ts")) throw new Error("boom");') })
    expect(await run(world({ files: "boom.ts\t\n" }), tools)).toEqual(unavailable("gate error"))
  })
  for (const what of ["view", "files", "diff"] as const) {
    test(`a hung gh on ${what} hits the budget`, async () => {
      expect(await run(world({ origin: "web", hang: what }), writeStubTools(), 50)).toEqual(unavailable("gate timed out"))
    })
  }
  for (const what of ["view", "files"] as const) {
    test(`gh failing on ${what}`, async () => {
      expect(await run(world({ failOn: what }), writeStubTools())).toEqual(unavailable(`couldn't read the PR ${what === "view" ? "head" : "files"}`))
    })
  }
  test("gh that can't start never escapes as a throw", async () => {
    const deps = { ...world(), gh: (async () => { throw new GhUnreachable("ENOENT") }) as GhFn }
    expect(await run(deps, writeStubTools())).toEqual(unavailable("gate error"))
  })
  test("a read with no base refuses: the diff means nothing without it", async () => {
    const deps = { ...world(), gh: (async () => ok(JSON.stringify({ url: URL, headRefOid: SHA, labels: [] }))) as GhFn }
    expect(await run(deps, writeStubTools())).toEqual(unavailable("couldn't read the PR head"))
  })
  test("bad JSON from gh", async () => {
    const deps = { ...world(), gh: (async () => ok("not json")) as GhFn }
    expect(await run(deps, writeStubTools())).toEqual(unavailable("couldn't read the PR head"))
  })
  test("an answer that isn't a GitHub PR url", async () => {
    const deps = { ...world(), gh: (async () => ok(JSON.stringify({ url: "https://evil.test/o/r/pull/7", headRefOid: SHA, baseRefName: "main", labels: [] }))) as GhFn }
    expect(await run(deps, writeStubTools())).toEqual(unavailable("not a GitHub PR url"))
  })
  test("an empty file list", async () => {
    expect(await run(world({ files: "" }), writeStubTools())).toEqual(unavailable("empty file list"))
  })
  test("3000 files, GitHub's silent ceiling", async () => {
    const files = Array.from({ length: 3000 }, (_, i) => `src/f${i}.ts\t`).join("\n")
    expect(await run(world({ files }), writeStubTools())).toEqual(unavailable("file list too long to trust"))
  })
  test("Turso down", async () => {
    expect(await run(world({ turso: "down" }), writeStubTools())).toEqual(unavailable("gate error"))
  })
})
