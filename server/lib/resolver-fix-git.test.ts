import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type FixInput, type ShFn, realSh, runPrFix } from "./resolver-fix"

// runPrFix against REAL git: a bare "GitHub" remote in a tmp dir, the local
// checkout, and a second clone that moves the PR branch during the run. The
// fix agent is a fake `claude` that edits the worktree. No network, no PR.
// Covers: fetch before push, rebase when the branch moved, conflict → blocked
// (never forced), a non-fast-forward rejection → one retry, the post-run guards
// (PR changes dropped by `-X theirs`, history rewritten), and that no git argv
// on the fix path carries a force flag.

const ENV_KEYS = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
  })
})
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function g(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: process.env as Record<string, string>, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

const HEAD = "dispatch/ab12cd34"
const BASE_A = "export const a = 1\n"
const PR_A = "export const a = 2 // the PR's change\n"
const B = "line one\nline two\nline three\n"

let root: string
let remote: string
let repo: string
let other: string
let argv: string[][]
let edit: (dir: string) => void
let beforePush: (() => void) | null

function commitAll(dir: string, msg: string): void {
  g(dir, "add", "-A")
  g(dir, "commit", "-q", "-m", msg)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "opus-fix-git-"))
  remote = join(root, "remote.git")
  g(root, "init", "-q", "--bare", "-b", "main", remote)
  const seed = join(root, "seed")
  g(root, "clone", "-q", remote, seed)
  g(seed, "checkout", "-q", "-b", "main")
  writeFileSync(join(seed, "a.ts"), BASE_A)
  writeFileSync(join(seed, "b.txt"), B)
  commitAll(seed, "base")
  g(seed, "push", "-q", "origin", "main")
  g(seed, "checkout", "-q", "-b", HEAD)
  writeFileSync(join(seed, "a.ts"), PR_A)
  writeFileSync(join(seed, "c.ts"), "export const c = 3\n")
  commitAll(seed, "the PR")
  g(seed, "push", "-q", "origin", HEAD)
  repo = join(root, "repo")
  g(root, "clone", "-q", remote, repo)
  other = join(root, "other")
  g(root, "clone", "-q", "-b", HEAD, remote, other)
  argv = []
  beforePush = null
  edit = (dir) => writeFileSync(join(dir, "b.txt"), B.replace("line two", "line two (fixed)"))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const reply = JSON.stringify({ type: "result", result: "RESOLVER_STATUS: fixed\nFixed line two." })

const sh: ShFn = async (cmd, args, opts) => {
  argv.push([cmd, ...args])
  if (cmd === "fake-claude") {
    edit(opts.cwd)
    return { ok: true, code: 0, out: reply, err: "" }
  }
  if (cmd === "git" && args.includes("push") && beforePush) {
    const hook = beforePush
    beforePush = null
    hook()
  }
  return realSh(cmd, args, opts)
}

const input = (over: Partial<FixInput> = {}): FixInput => ({
  prUrl: "https://github.com/jaubut/tls-review/pull/9", number: 9, title: "Fix", repo, head: HEAD, base: "main",
  instructions: "Fix line two", taskText: "", model: "claude-opus-5-5", timeoutMs: 30_000, ...over,
})

const run = () => runPrFix(input(), { sh, claudeBin: () => "fake-claude", mkTemp: () => mkdtempSync(join(root, "wt-")), linkModules: () => {} })
const remoteHead = () => g(remote, "rev-parse", `refs/heads/${HEAD}`)

/** The other clone pushes a commit to the PR branch (the branch moves under the fix run). */
function moveBranch(file: string, content: string): string {
  g(other, "pull", "-q", "--ff-only", "origin", HEAD)
  writeFileSync(join(other, file), content)
  commitAll(other, `moved: ${file}`)
  g(other, "push", "-q", "origin", HEAD)
  return g(other, "rev-parse", "HEAD")
}

function expectNeverForced(): void {
  const gits = argv.filter((c) => c[0] === "git")
  expect(gits.length).toBeGreaterThan(3)
  for (const c of gits) {
    expect(c.some((a) => a === "-f" || a.startsWith("--force") || a === "--mirror")).toBe(false)
    if (c.includes("push")) expect(c.slice(c.indexOf("push") + 1).some((a) => a.startsWith("+") || a.startsWith(":"))).toBe(false)
    if (c.includes("fetch")) for (const a of c.filter((x) => x.startsWith("+"))) expect(a).toMatch(/^\+refs\/heads\/[^:]+:refs\/remotes\/origin\//)
  }
}

describe("runPrFix on real git", () => {
  test("pushes the fix commit on top of the PR head, worktree gone", async () => {
    const before = remoteHead()
    const out = await run()
    expect(out.kind).toBe("pushed")
    if (out.kind !== "pushed") return
    expect(remoteHead()).toBe(out.sha)
    expect(g(remote, "rev-parse", `${out.sha}^`)).toBe(before)
    expect(g(remote, "show", `${out.sha}:a.ts`)).toBe(PR_A.trim())
    expect(g(repo, "worktree", "list").split("\n")).toHaveLength(1)
    expect(argv.some((c) => c.includes("rebase"))).toBe(false)
    expectNeverForced()
  })

  test("the branch moved during the run → the fix is rebased onto the new head, then pushed", async () => {
    let moved = ""
    edit = (dir) => {
      moved = moveBranch("d.ts", "export const d = 4\n")
      writeFileSync(join(dir, "b.txt"), B.replace("line two", "line two (fixed)"))
    }
    const out = await run()
    expect(out.kind).toBe("pushed")
    if (out.kind !== "pushed") return
    expect(g(remote, "rev-parse", `${out.sha}^`)).toBe(moved)
    expect(g(remote, "show", `${out.sha}:d.ts`)).toBe("export const d = 4")
    expect(g(remote, "show", `${out.sha}:b.txt`)).toContain("line two (fixed)")
    expect(argv.some((c) => c.includes("rebase") && c.includes("--onto"))).toBe(true)
    expectNeverForced()
  })

  test("the branch moved and conflicts with the fix → blocked, rebase aborted, remote untouched", async () => {
    let moved = ""
    edit = (dir) => {
      moved = moveBranch("b.txt", B.replace("line two", "line two (theirs)"))
      writeFileSync(join(dir, "b.txt"), B.replace("line two", "line two (fixed)"))
    }
    const out = await run()
    expect(out).toEqual({ kind: "blocked", reason: "branch moved and conflicts with Opus's fix (b.txt)" })
    expect(remoteHead()).toBe(moved)
    expect(argv.some((c) => c.includes("rebase") && c.includes("--abort"))).toBe(true)
    expect(argv.some((c) => c.includes("push"))).toBe(false)
    expectNeverForced()
  })

  test("a non-fast-forward rejection (moved between fetch and push) → fetch + rebase + push once more", async () => {
    let moved = ""
    beforePush = () => { moved = moveBranch("e.ts", "export const e = 5\n") }
    const out = await run()
    expect(out.kind).toBe("pushed")
    if (out.kind !== "pushed") return
    expect(argv.filter((c) => c.includes("push"))).toHaveLength(2)
    expect(g(remote, "rev-parse", `${out.sha}^`)).toBe(moved)
    expectNeverForced()
  })

  test("`git merge origin/main -X theirs` drops the PR's change → blocked, nothing pushed", async () => {
    // main changes a.ts too; the blanket strategy takes main's side of the PR's file.
    const seed = join(root, "seed")
    g(seed, "checkout", "-q", "main")
    writeFileSync(join(seed, "a.ts"), "export const a = 10 // main moved\n")
    commitAll(seed, "main moves a.ts")
    g(seed, "push", "-q", "origin", "main")
    const before = remoteHead()
    edit = (dir) => { g(dir, "merge", "-q", "--no-edit", "-X", "theirs", "refs/remotes/origin/main") }
    const out = await run()
    expect(out).toEqual({ kind: "blocked", reason: "fix would drop the PR's changes in a.ts" })
    expect(remoteHead()).toBe(before)
    expectNeverForced()
  })

  test("a fix that moves HEAD off the PR history (checkout of main) → blocked, nothing pushed", async () => {
    const before = remoteHead()
    edit = (dir) => { g(dir, "checkout", "-q", "--detach", "refs/remotes/origin/main") }
    const out = await run()
    expect(out.kind).toBe("blocked")
    if (out.kind === "blocked") expect(out.reason).toContain("rewrote the PR's history")
    expect(remoteHead()).toBe(before)
  })

  test("the fix reverts the PR's own file to main's version → blocked with the file named", async () => {
    edit = (dir) => {
      writeFileSync(join(dir, "a.ts"), BASE_A)
      writeFileSync(join(dir, "b.txt"), B.replace("line two", "line two (fixed)"))
    }
    const out = await run()
    expect(out).toEqual({ kind: "blocked", reason: "fix would drop the PR's changes in a.ts" })
    expect(readFileSync(join(other, "a.ts"), "utf8")).toBe(PR_A)
  })
})
