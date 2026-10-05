import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realSh } from "./resolver-fix"
import { type GitFn, droppedPrChanges, guardFixRange } from "./resolver-fix-guard"

// The dropped-changes detector on constructed histories (real git, tmp dir):
//   main:  a.ts, b.ts, c.ts          PR: changes a.ts + b.ts, adds n.ts
//   fix commits on the PR head revert some of that to main's / the fork point's version.

let root: string
let dir: string
let pr: string
const ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" }
const env = () => ({ ...(process.env as Record<string, string>), ...ENV })

function g(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: env(), stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}
const git: GitFn = (cwd, ...args) => realSh("git", ["-C", cwd, ...args], { cwd, timeoutMs: 10_000, env: env() })
const put = (f: string, s: string) => writeFileSync(join(dir, f), s)
const commit = (m: string) => { g("add", "-A"); g("commit", "-q", "-m", m); return g("rev-parse", "HEAD") }

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "opus-guard-"))
  dir = join(root, "r")
  Bun.spawnSync(["git", "init", "-q", "-b", "main", dir], { env: env() })
  put("a.ts", "a main\n"); put("b.ts", "b main\n"); put("c.ts", "c main\n")
  commit("base")
  g("checkout", "-q", "-b", "pr")
  put("a.ts", "a PR\n"); put("b.ts", "b PR\n"); put("n.ts", "new in PR\n")
  pr = commit("the PR")
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A fix branch off the PR head with `edits` applied; returns its sha. */
function fixWith(name: string, edits: () => void): string {
  g("checkout", "-q", "-b", name, pr)
  edits()
  return g("status", "--porcelain") ? commit(`fix ${name}`) : g("rev-parse", "HEAD")
}

describe("droppedPrChanges", () => {
  test("a fix that keeps the PR's changes → nothing dropped", async () => {
    const sha = fixWith("ok", () => { put("a.ts", "a PR\nplus the review fix\n"); put("c.ts", "c touched\n") })
    expect(await droppedPrChanges(git, dir, pr, "main", sha)).toEqual([])
    g("checkout", "-q", "ok")
    expect(await guardFixRange(git, dir, pr, "main")).toEqual({ ok: true })
  })

  test("a fix that restores main's version of a PR file (and deletes the PR's new file) → both named", async () => {
    const sha = fixWith("drop", () => { put("a.ts", "a main\n"); put("c.ts", "c touched\n"); rmSync(join(dir, "n.ts")) })
    expect((await droppedPrChanges(git, dir, pr, "main", sha)).sort()).toEqual(["a.ts", "n.ts"])
    g("checkout", "-q", "drop")
    const v = await guardFixRange(git, dir, pr, "main")
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/^fix would drop the PR's changes in (a\.ts, n\.ts|n\.ts, a\.ts)$/)
  })

  test("main moved, then `merge -X theirs` takes main's side of a PR file → dropped", async () => {
    g("checkout", "-q", "main")
    put("b.ts", "b main moved\n")
    commit("main moves b.ts")
    const sha = fixWith("theirs", () => { g("merge", "-q", "--no-edit", "-X", "theirs", "main") })
    expect(await droppedPrChanges(git, dir, pr, "main", sha)).toEqual(["b.ts"])
  })

  test("a fix that is not on top of the PR head → history rewrite refused", async () => {
    g("checkout", "-q", "--detach", "main")
    const v = await guardFixRange(git, dir, pr, "main")
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("rewrote the PR's history") })
  })
})
