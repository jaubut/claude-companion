import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ShFn, realSh } from "../lib/live-repo"
import type { ExecFn, Row } from "../lib/turso"

// wiring/auto-deploy.ts: the repo allowlist, the fast-forward-only guard, dirty trees, the debounce. git is real
// (a bare origin + the two checkouts under a temp HOME); systemctl and bun are faked at the shell seam.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-deploy-")), "test.db")
const { DEPLOY_ACTION, QUIET_MS, SYNC_GRACE_MS, confirmBoot, createAutoDeploy, deployRepo } = await import("./auto-deploy")

const genv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: genv })
  return { ok: r.status === 0, out: r.stdout.trim() }
}

function world(opts: { install?: boolean; systemctl?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "cc-deploy-home-"))
  const seeds: Record<string, string> = {}
  for (const [name, dir] of [["claude-companion", "claude-companion"], ["claude-config", ".claude"]] as const) {
    const seed = join(home, `seed-${name}`)
    mkdirSync(seed)
    git(seed, "init", "-q", "-b", "main")
    writeFileSync(join(seed, "app.ts"), "v1\n")
    writeFileSync(join(seed, "bun.lock"), "lock1\n")
    git(seed, "add", ".")
    git(seed, "commit", "-qm", "v1")
    spawnSync("git", ["clone", "-q", "--bare", seed, join(home, `${name}.git`)])
    git(seed, "remote", "add", "origin", join(home, `${name}.git`))
    spawnSync("git", ["clone", "-q", join(home, `${name}.git`), join(home, dir)])
    seeds[name] = seed
  }
  const push = (name: string, file = "app.ts", text = `v${Date.now()}${Math.random()}\n`) => {
    writeFileSync(join(seeds[name]!, file), text)
    git(seeds[name]!, "commit", "-qam", `edit ${file}`)
    git(seeds[name]!, "push", "-q", "origin", "main")
    return git(seeds[name]!, "rev-parse", "HEAD").out
  }
  const calls: string[] = []
  const sh: ShFn = async (cmd, args, o) => {
    if (cmd === "git") return realSh(cmd, args, { ...o, env: genv as Record<string, string> })
    calls.push([cmd, ...args].join(" "))
    const ok = cmd === "bun" ? opts.install !== false : opts.systemctl !== false
    return { ok, code: ok ? 0 : 1, out: "", err: ok ? "" : `${cmd} failed` }
  }
  const db = new Database(":memory:")
  db.exec("CREATE TABLE agent_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT, action TEXT, target_kind TEXT, target_id TEXT, summary TEXT, meta TEXT, ts TEXT DEFAULT (datetime('now')))")
  const exec: ExecFn = async (sql, args) => /^\s*SELECT/i.test(sql)
    ? { rows: db.query(sql).all(...args) as Row[], affected: 0 }
    : { rows: [], affected: db.query(sql).run(...args).changes }
  const events: string[] = []
  let clock = 1_000_000
  const deps = { sh, exec, event: (t: string) => events.push(t), now: () => clock, home }
  const head = (dir: string) => git(join(home, dir), "rev-parse", "HEAD").out
  const rows = () => (db.query("SELECT meta FROM agent_activity WHERE action = ?").all(DEPLOY_ACTION) as Row[]).map((r) => JSON.parse(String(r.meta)) as Record<string, unknown>)
  return { home, push, calls, events, deps, head, rows, advance: (ms: number) => { clock += ms } }
}

describe("auto-deploy: allowlist", () => {
  test("only claude-companion and claude-config: anything else is refused before any command runs", async () => {
    const w = world()
    for (const repo of ["tls-dashboard-v2", "../claude-companion", "claude-companion; rm -rf ~", "", "CLAUDE-CONFIG"]) {
      expect(await deployRepo(repo, "brain", w.deps)).toEqual({ ok: false, repo, error: "repo_not_allowed" })
      expect(await createAutoDeploy(w.deps).deployNow(repo)).toMatchObject({ ok: false, error: "repo_not_allowed" })
    }
    expect(w.calls).toEqual([])
    expect(w.rows()).toEqual([])
  })
})

describe("auto-deploy: claude-companion", () => {
  test("fast-forwards to origin/main, writes the row + event, then restarts its own unit (no-block); the boot confirms it", async () => {
    const w = world()
    const from = w.head("claude-companion")
    w.push("claude-companion")
    const to = w.push("claude-companion")
    const out = await deployRepo("claude-companion", "auto", w.deps)
    expect(out).toEqual({ ok: true, repo: "claude-companion", result: "restarting", from, to, commits: 2 })
    expect(w.head("claude-companion")).toBe(to)
    expect(w.calls).toEqual(["systemctl --user restart --no-block claude-companion.service"])
    expect(w.rows()).toEqual([expect.objectContaining({ repo: "claude-companion", from, to, commits: 2, result: "restarting", source: "auto" })])
    expect(w.events[0]).toContain("restarting")
    await confirmBoot(w.deps)
    expect(w.rows()[1]).toMatchObject({ result: "restarted", head: to })
    expect(existsSync(join(w.home, ".claude-companion", "deploy-pending.json"))).toBe(false)
  })

  test("up to date → nothing runs", async () => {
    const w = world()
    expect(await deployRepo("claude-companion", "auto", w.deps)).toMatchObject({ ok: true, result: "up_to_date" })
    expect(w.calls).toEqual([])
  })

  test("ff-only guard: local main with its own commit is never reset, merged or restarted", async () => {
    const w = world()
    const dir = join(w.home, "claude-companion")
    writeFileSync(join(dir, "local.ts"), "mine\n")
    git(dir, "add", ".")
    git(dir, "commit", "-qm", "local commit")
    const local = w.head("claude-companion")
    w.push("claude-companion")
    const out = await deployRepo("claude-companion", "auto", w.deps)
    expect(out).toMatchObject({ ok: false, error: "not_fast_forward" })
    expect(w.head("claude-companion")).toBe(local)
    expect(w.calls).toEqual([])
    expect(w.rows()[0]).toMatchObject({ result: "not_fast_forward" })
  })

  test("not on main → refused, the branch is left alone", async () => {
    const w = world()
    git(join(w.home, "claude-companion"), "checkout", "-qb", "feature")
    w.push("claude-companion")
    expect(await deployRepo("claude-companion", "auto", w.deps)).toMatchObject({ ok: false, error: "not_on_main", detail: "feature" })
    expect(git(join(w.home, "claude-companion"), "symbolic-ref", "--short", "HEAD").out).toBe("feature")
    expect(w.calls).toEqual([])
  })

  test("dirty tree: local edits the merge doesn't touch survive the deploy", async () => {
    const w = world()
    const dir = join(w.home, "claude-companion")
    writeFileSync(join(dir, "bun.lock"), "local lock edit\n")
    writeFileSync(join(dir, "scratch.log"), "runtime\n")
    const to = w.push("claude-companion", "app.ts")
    expect(await deployRepo("claude-companion", "auto", w.deps)).toMatchObject({ ok: true, result: "restarting", to })
    expect(readFileSync(join(dir, "bun.lock"), "utf8")).toBe("local lock edit\n")
    expect(readFileSync(join(dir, "scratch.log"), "utf8")).toBe("runtime\n")
  })

  test("dirty tree: a local edit the merge would overwrite → refused before anything changes, edit kept, no restart", async () => {
    const w = world()
    const dir = join(w.home, "claude-companion")
    const from = w.head("claude-companion")
    writeFileSync(join(dir, "app.ts"), "my hotfix\n")
    w.push("claude-companion", "app.ts")
    const out = await deployRepo("claude-companion", "auto", w.deps)
    expect(out).toMatchObject({ ok: false, error: "dirty_overlap" })
    expect(w.head("claude-companion")).toBe(from)
    expect(readFileSync(join(dir, "app.ts"), "utf8")).toBe("my hotfix\n")
    expect(w.calls).toEqual([])
  })

  test("a lockfile change installs deps first; a failed install means no restart", async () => {
    const ok = world()
    ok.push("claude-companion", "bun.lock", "lock2\n")
    await deployRepo("claude-companion", "auto", ok.deps)
    expect(ok.calls).toEqual(["bun install --frozen-lockfile", "systemctl --user restart --no-block claude-companion.service"])
    const bad = world({ install: false })
    bad.push("claude-companion", "bun.lock", "lock2\n")
    expect(await deployRepo("claude-companion", "auto", bad.deps)).toMatchObject({ ok: false, error: "install_failed" })
    expect(bad.calls).toEqual(["bun install --frozen-lockfile"])
  })
})

describe("auto-deploy: claude-config", () => {
  test("runs claude-config-sync (never git-merges ~/.claude itself, dirty runtime files untouched); a later poll confirms the head", async () => {
    const w = world()
    const dir = join(w.home, ".claude")
    mkdirSync(join(dir, "memory"))
    writeFileSync(join(dir, "memory", "note.md"), "runtime write\n")
    writeFileSync(join(dir, "app.ts"), "dirty tracked\n")
    const from = w.head(".claude")
    const to = w.push("claude-config")
    const loop = createAutoDeploy(w.deps)
    expect(await loop.deployNow("claude-config")).toEqual({ ok: true, repo: "claude-config", result: "sync_started", from, to, commits: 1 })
    expect(w.calls).toEqual(["systemctl --user start --no-block claude-config-sync.service"])
    expect(w.head(".claude")).toBe(from)
    expect(readFileSync(join(dir, "memory", "note.md"), "utf8")).toBe("runtime write\n")
    // claude-config-sync lands it (here by hand): the next poll posts "deployed".
    git(dir, "stash", "-q"); git(dir, "merge", "-q", "--ff-only", "origin/main"); git(dir, "stash", "pop", "-q")
    await loop.tick()
    expect(w.rows().at(-1)).toMatchObject({ repo: "claude-config", result: "synced", head: to })
  })

  test("a sync that never lands is reported once after the grace period", async () => {
    const w = world()
    w.push("claude-config")
    const loop = createAutoDeploy(w.deps)
    await loop.deployNow("claude-config")
    w.advance(SYNC_GRACE_MS)
    await loop.tick()
    await loop.tick()
    expect(w.rows().filter((r) => r.result === "sync_held")).toHaveLength(1)
    expect(w.calls).toHaveLength(1) // not re-triggered for the same head
  })
})

describe("auto-deploy: debounce", () => {
  test("a burst of merges is one deploy, once origin/main has stayed put for QUIET_MS", async () => {
    const w = world()
    const loop = createAutoDeploy(w.deps)
    const restarts = () => w.calls.filter((c) => c.includes("restart")).length
    w.push("claude-companion")
    await loop.tick() // first sight: the quiet period starts
    w.advance(QUIET_MS - 1000)
    await loop.tick()
    expect(restarts()).toBe(0)
    const last = w.push("claude-companion") // a second merge restarts the wait
    await loop.tick()
    w.advance(QUIET_MS - 1000)
    await loop.tick()
    expect(restarts()).toBe(0)
    w.advance(1000)
    await loop.tick()
    expect(restarts()).toBe(1)
    expect(w.head("claude-companion")).toBe(last)
    w.advance(QUIET_MS * 3)
    await loop.tick()
    expect(restarts()).toBe(1)
  })

  test("a refused head is not retried every poll; a new origin/main is", async () => {
    const w = world()
    const dir = join(w.home, "claude-companion")
    writeFileSync(join(dir, "app.ts"), "my hotfix\n")
    w.push("claude-companion", "app.ts")
    const loop = createAutoDeploy(w.deps)
    await loop.tick(); w.advance(QUIET_MS); await loop.tick()
    w.advance(QUIET_MS); await loop.tick()
    expect(w.rows().filter((r) => r.result === "dirty_overlap")).toHaveLength(1)
    git(dir, "checkout", "--", "app.ts")
    w.push("claude-companion")
    await loop.tick(); w.advance(QUIET_MS); await loop.tick()
    expect(w.rows().at(-1)).toMatchObject({ result: "restarting" })
  })
})
