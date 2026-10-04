import { beforeEach, describe, expect, test } from "bun:test"
import { type FixInput, type ShFn, fixEnv, pushableBranch, runPrFix } from "./resolver-fix"

// The PR fix run over a fake shell: worktree on the PR head, the builder run,
// commit + push to the SAME branch (never forced, never main), cleanup always.

let cmds: string[][]
let reply: string
let dirty: boolean
let headAfter: string
let cleaned: string[]

const input = (over: Partial<FixInput> = {}): FixInput => ({
  prUrl: "https://github.com/jaubut/tls-review/pull/9", number: 9, title: "Fix uploads", repo: "/repo", head: "dispatch/ab12cd34",
  base: "main", instructions: "Inject the clock", taskText: "Fix uploads", model: "claude-opus-5-5", timeoutMs: 1000, ...over,
})

const sh: ShFn = async (cmd, args) => {
  cmds.push([cmd, ...args])
  const sub = args[2]
  if (cmd === "claude") return { ok: true, code: 0, out: JSON.stringify({ type: "result", result: reply }), err: "" }
  if (sub === "rev-parse") return { ok: true, code: 0, out: cmds.some((c) => c.includes("commit")) ? headAfter : "start-sha", err: "" }
  if (sub === "status") return { ok: true, code: 0, out: dirty ? " M src/upload.ts\n" : "", err: "" }
  return { ok: true, code: 0, out: "", err: "" }
}

const deps = { sh, claudeBin: () => "claude", mkTemp: () => "/tmp/opus-x", linkModules: () => {}, cleanup: (d: string) => { cleaned.push(d) } }

beforeEach(() => {
  cmds = []
  reply = "RESOLVER_STATUS: fixed\nInjected the clock into the upload test."
  dirty = true
  headAfter = "new-sha-123"
  cleaned = []
})

describe("runPrFix", () => {
  test("pushes the fix to the same PR branch, never forced, and removes the worktree", async () => {
    const out = await runPrFix(input(), deps)
    expect(out).toEqual({ kind: "pushed", sha: "new-sha-123", summary: "Injected the clock into the upload test." })
    const push = cmds.find((c) => c.includes("push"))!
    expect(push).toEqual(["git", "-C", "/tmp/opus-x/wt", "push", "origin", "HEAD:refs/heads/dispatch/ab12cd34"])
    const forced = cmds.filter((c) => !(c.includes("worktree") && c.includes("remove"))).filter((c) => c.some((a) => a === "-f" || a.startsWith("--force")))
    expect(forced).toEqual([])
    expect(cmds.find((c) => c.includes("add") && c.includes("--detach"))).toContain("origin/dispatch/ab12cd34")
    const claude = cmds.find((c) => c[0] === "claude")!
    expect(claude).toContain("--agent")
    expect(claude[claude.indexOf("--model") + 1]).toBe("claude-opus-5-5")
    expect(cmds.at(-1)).toEqual(["git", "-C", "/repo", "worktree", "remove", "--force", "/tmp/opus-x/wt"])
    expect(cleaned).toEqual(["/tmp/opus-x"])
  })

  test("refuses main / master / the base branch before touching git", async () => {
    for (const head of ["main", "master", "develop"]) {
      expect((await runPrFix(input({ head }), deps)).kind).toBe("failed")
    }
    expect((await runPrFix(input({ head: "feature/x", base: "feature/x" }), deps)).kind).toBe("failed")
    expect((await runPrFix(input({ head: "-x" }), deps)).kind).toBe("failed")
    expect(cmds).toEqual([])
  })

  test("blocked agent → no commit, no push", async () => {
    reply = "RESOLVER_STATUS: blocked: needs a Stripe test key"
    expect(await runPrFix(input(), deps)).toEqual({ kind: "blocked", reason: "needs a Stripe test key" })
    expect(cmds.some((c) => c.includes("push"))).toBe(false)
    expect(cleaned).toHaveLength(1)
  })

  test("no change → no push", async () => {
    dirty = false
    headAfter = "start-sha"
    expect((await runPrFix(input(), deps)).kind).toBe("no_changes")
    expect(cmds.some((c) => c.includes("push"))).toBe(false)
  })

  test("pushableBranch + the builder env drops server tokens", () => {
    expect(pushableBranch("dispatch/ab12", "main")).toBe(true)
    expect(pushableBranch("main", "develop")).toBe(false)
    expect(pushableBranch("a..b", "main")).toBe(false)
    const env = fixEnv({ PATH: "/bin", TURSO_AUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k", COMPANION_TOKEN: "c", HOME: "/h" })
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" })
  })
})
