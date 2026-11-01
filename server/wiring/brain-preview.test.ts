import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ShFn } from "../lib/live-repo"
import { IDLE_MS, PREVIEW_REPOS, branchDir, createPreviews, devPlan, previewEnv, previewRepo, validBranch } from "./brain-preview"

// bin/preview manager (wiring/brain-preview.ts): git / tailscale faked at the
// shell seam, the dev process and the proxy faked, the worktree a real dir.

function world(opts: { ready?: boolean; serveOk?: boolean; dev?: string; branchExists?: boolean; fetchOk?: boolean; diesDuringServe?: boolean; noModules?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cc-preview-"))
  const calls: string[][] = []
  const spawned: Array<{ cmd: string[]; cwd: string; env: Record<string, string>; killed: boolean; dead: boolean; exit: () => void }> = []
  const proxies: Array<{ hit: () => void; stopped: boolean }> = []
  let clock = 1_000_000
  const sh: ShFn = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === "git" && args.includes("fetch") && opts.fetchOk === false) return { ok: false, code: 128, out: "", err: "fatal: could not read from remote" }
    if (cmd === "tailscale" && args.includes("--bg") && opts.diesDuringServe) spawned.at(-1)!.dead = true
    if (cmd === "git" && args.includes("rev-parse")) return { ok: opts.branchExists !== false, code: opts.branchExists === false ? 1 : 0, out: "", err: "" }
    if (cmd === "git" && args.includes("add")) {
      const wt = args[args.indexOf("--detach") + 1]!
      mkdirSync(opts.noModules ? wt : join(wt, "node_modules", ".bin"), { recursive: true })
      writeFileSync(join(wt, ".git"), "gitdir: x\n")
      writeFileSync(join(wt, "package.json"), JSON.stringify({ scripts: { dev: opts.dev ?? "astro dev" } }))
      if (opts.dev?.includes("cd client")) {
        mkdirSync(join(wt, "client", "node_modules"), { recursive: true })
        writeFileSync(join(wt, "client", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
      }
    }
    if (cmd === "tailscale" && args.includes("--bg") && opts.serveOk === false) return { ok: false, code: 1, out: "", err: "serve refused" }
    return { ok: true, code: 0, out: "", err: "" }
  }
  const p = createPreviews({
    root,
    repoPath: (n) => (n === "tlstudio" || n === "tls-dashboard-v2" ? `/repos/${n}` : null),
    sh,
    tailnetHost: async () => "zettlab.tail1234.ts.net",
    freePort: async () => 51234,
    spawnDev: (cmd, cwd, env, logFile, onExit) => {
      writeFileSync(logFile, "booting\nError: TOKEN missing ghp_abcdefghijklmnopqrstu\n")
      const s = { cmd, cwd, env, killed: false, dead: false, exit: onExit }
      spawned.push(s)
      return { pid: 4242, get exited() { return s.dead }, kill: () => { s.killed = true } }
    },
    ready: async () => opts.ready !== false,
    proxy: (_port, onHit) => {
      const px = { hit: onHit, stopped: false }
      proxies.push(px)
      return { port: 40000 + proxies.length, stop: () => { px.stopped = true } }
    },
    now: () => clock,
  })
  return { p, root, calls, spawned, proxies, tick: (ms: number) => { clock += ms } }
}

const serveCalls = (calls: string[][]) => calls.filter((c) => c[0] === "tailscale")

describe("preview input validation", () => {
  test("only allowlisted repos, case-insensitive", () => {
    expect(previewRepo("TLSTUDIO")).toBe("tlstudio")
    expect(previewRepo("tls-dashboard-v2")).toBe("tls-dashboard-v2")
    for (const bad of ["claude-companion", "../tlstudio", "tlstudio;rm", "", "constructor", 7, null]) expect(previewRepo(bad)).toBeNull()
  })

  test("branch names: git-safe only", () => {
    for (const ok of ["main", "feat/hero-v2", "dispatch/abcd1234", "release-1.2"]) expect(validBranch(ok)).toBe(true)
    for (const bad of ["-main", "a..b", "a b", "x;y", "feat/", "a//b", "x.lock", "$(id)", "", 3]) expect(validBranch(bad)).toBe(false)
  })

  test("the dev env carries no server secrets", () => {
    process.env.COMPANION_AUTH_TOKEN_PROBE = "super-secret"
    const env = previewEnv("h.ts.net", "/sandbox/home")
    expect(Object.values(env)).not.toContain("super-secret")
    expect(env.HOME).toBe("/sandbox/home")
    expect(env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS).toBe("h.ts.net")
    delete process.env.COMPANION_AUTH_TOKEN_PROBE
  })

  test("dev plan: astro / vite at the root, else a vite client/, never the script text", () => {
    const d = mkdtempSync(join(tmpdir(), "cc-plan-"))
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { dev: "bun --watch server/index.ts & cd client && bun run dev" } }))
    expect(devPlan(d)).toBeNull()
    mkdirSync(join(d, "client"))
    writeFileSync(join(d, "client", "package.json"), JSON.stringify({ scripts: { dev: "vite" } }))
    expect(devPlan(d)).toEqual({ cwd: join(d, "client"), bin: "vite" })
  })
})

describe("preview lifecycle", () => {
  test("start: worktree of origin/main under the previews dir, astro on 127.0.0.1, tailscale serve on the repo's port", async () => {
    const w = world()
    const out = await w.p.start("tlstudio", "main")
    expect(out.status).toBe(200)
    expect(out.body.url).toBe(`https://zettlab.tail1234.ts.net:${PREVIEW_REPOS.tlstudio}/`)
    expect(w.calls).toContainEqual(["git", "-C", "/repos/tlstudio", "worktree", "add", "--detach", join(w.root, "tlstudio", branchDir("main")), "refs/remotes/origin/main"])
    expect(w.spawned[0]!.cmd.slice(1)).toEqual(["dev", "--host", "127.0.0.1", "--port", "51234"])
    expect(w.spawned[0]!.cwd).toBe(join(w.root, "tlstudio", branchDir("main")))
    expect(serveCalls(w.calls)).toEqual([["tailscale", "serve", "--bg", "--https=9401", "http://127.0.0.1:40001"]])
    expect(w.calls.flat().some((a) => a.includes("funnel"))).toBe(false)
  })

  test("one preview per repo: a second (even concurrent) start returns the same URL", async () => {
    const w = world()
    const [a, b] = await Promise.all([w.p.start("tlstudio", "main"), w.p.start("tlstudio", "main")])
    const c = await w.p.start("tlstudio", "feat/x")
    expect(w.spawned).toHaveLength(1)
    expect(a.body.url).toBe(b.body.url)
    expect(c.body).toMatchObject({ ok: true, url: a.body.url, branch: "main", reused: true })
    expect(w.p.list()).toHaveLength(1)
  })

  test("stop kills the process and the serve mapping, keeps the worktree for reuse", async () => {
    const w = world()
    await w.p.start("tlstudio", "main")
    const out = await w.p.stop("tlstudio")
    expect(out.body).toMatchObject({ ok: true, stopped: true })
    expect(w.spawned[0]!.killed).toBe(true)
    expect(w.proxies[0]!.stopped).toBe(true)
    expect(serveCalls(w.calls).at(-1)).toEqual(["tailscale", "serve", "--https=9401", "off"])
    expect((await w.p.stop("tlstudio")).status).toBe(404)
    const adds = () => w.calls.filter((c) => c.includes("add")).length
    await w.p.start("tlstudio", "main")
    expect(adds()).toBe(1)
  })

  test("idle stop after 2 h without a request; a request resets the clock", async () => {
    const w = world()
    await w.p.start("tlstudio", "main")
    w.tick(IDLE_MS - 1_000)
    w.proxies[0]!.hit()
    w.tick(IDLE_MS - 1_000)
    expect(await w.p.sweepIdle()).toEqual([])
    w.tick(2_000)
    expect(await w.p.sweepIdle()).toEqual(["tlstudio"])
    expect(w.spawned[0]!.killed).toBe(true)
    expect(w.p.list()).toHaveLength(0)
  })

  test("the dev server exiting stops the preview", async () => {
    const w = world()
    await w.p.start("tlstudio", "main")
    w.spawned[0]!.exit()
    await Bun.sleep(0)
    expect(w.p.list()).toHaveLength(0)
    expect(serveCalls(w.calls).at(-1)).toEqual(["tailscale", "serve", "--https=9401", "off"])
  })

  test("a dev server that never comes up: 502 with the redacted log tail, no serve mapping", async () => {
    const w = world({ ready: false })
    const out = await w.p.start("tlstudio", "main")
    expect([out.status, out.body.error]).toEqual([502, "dev_failed"])
    expect(JSON.stringify(out.body.log)).not.toContain("ghp_abcdefghijklmnopqrstu")
    expect((out.body.log as string[])[0]).toBe("booting")
    expect(serveCalls(w.calls)).toHaveLength(0)
    expect(w.spawned[0]!.killed).toBe(true)
  })

  test("refusals: unknown checkout, missing branch, serve failure", async () => {
    expect((await world().p.start("remorquage-pelchat", "main")).body.error).toBe("repo_not_found")
    expect((await world({ branchExists: false }).p.start("tlstudio", "nope")).body.error).toBe("branch_not_found")
    const w = world({ serveOk: false })
    const out = await w.p.start("tlstudio", "main")
    expect(out.body.error).toBe("serve_failed")
    expect(w.spawned[0]!.killed && w.proxies[0]!.stopped).toBe(true)
    expect(w.p.list()).toHaveLength(0)
  })

  test("dashboard-style repo: vite in client/ with --strictPort", async () => {
    const w = world({ dev: "bun --watch server/index.ts & cd client && bun run dev" })
    const out = await w.p.start("tls-dashboard-v2", "main")
    expect(out.status).toBe(200)
    expect(w.spawned[0]!.cwd).toBe(join(w.root, "tls-dashboard-v2", branchDir("main"), "client"))
    expect(w.spawned[0]!.cmd.slice(1)).toEqual(["--host", "127.0.0.1", "--port", "51234", "--strictPort"])
    expect(serveCalls(w.calls)[0]).toContain("--https=9402")
  })

  test("every start fetches and force-checks-out origin/<branch>: a second start on a new branch serves the new head", async () => {
    const w = world()
    const mainWt = join(w.root, "tlstudio", branchDir("main"))
    const featWt = join(w.root, "tlstudio", branchDir("feat/new"))
    await w.p.start("tlstudio", "main")
    await w.p.stop("tlstudio")
    const out = await w.p.start("tlstudio", "feat/new")
    expect(out.body).toMatchObject({ ok: true, branch: "feat/new", reused: false })
    expect(w.spawned[1]!.cwd).toBe(featWt)
    expect(w.calls).toContainEqual(["git", "-C", "/repos/tlstudio", "fetch", "--quiet", "origin", "feat/new"])
    expect(w.calls.at(-2)).toEqual(["git", "-C", featWt, "checkout", "--detach", "--force", "origin/feat/new"])
    await w.p.stop("tlstudio")
    // Same branch again: the kept worktree is not re-added but is moved to the fetched head.
    const before = w.calls.length
    await w.p.start("tlstudio", "main")
    const again = w.calls.slice(before)
    expect(again).toContainEqual(["git", "-C", "/repos/tlstudio", "fetch", "--quiet", "origin", "main"])
    expect(again).toContainEqual(["git", "-C", mainWt, "checkout", "--detach", "--force", "origin/main"])
    expect(again.some((c) => c.includes("add"))).toBe(false)
  })

  test("worktree folders never collide: feat/x and feat__x get distinct dirs", async () => {
    expect(branchDir("feat/x")).not.toBe(branchDir("feat__x"))
    const w = world()
    await w.p.start("tlstudio", "feat/x")
    await w.p.stop("tlstudio")
    await w.p.start("tlstudio", "feat__x")
    expect(w.spawned[0]!.cwd).not.toBe(w.spawned[1]!.cwd)
    expect(w.calls.filter((c) => c.includes("add"))).toHaveLength(2)
  })

  test("fetch failure: 502 fetch_failed, nothing spawned", async () => {
    const w = world({ fetchOk: false })
    const out = await w.p.start("tlstudio", "main")
    expect([out.status, out.body.error]).toEqual([502, "fetch_failed"])
    expect(w.spawned).toHaveLength(0)
  })

  test("dev server dying during tailscale serve: 502, mapping removed, not listed", async () => {
    const w = world({ diesDuringServe: true })
    const out = await w.p.start("tlstudio", "main")
    expect([out.status, out.body.error]).toEqual([502, "dev_failed"])
    expect(w.proxies[0]!.stopped).toBe(true)
    expect(serveCalls(w.calls).at(-1)).toEqual(["tailscale", "serve", "--https=9401", "off"])
    expect(w.p.list()).toHaveLength(0)
  })

  test("start and stop are serialized per repo: a stop during a start runs after it", async () => {
    const w = world()
    const [a, b] = await Promise.all([w.p.start("tlstudio", "main"), w.p.stop("tlstudio")])
    expect(a.status).toBe(200)
    expect(b.body).toMatchObject({ ok: true, stopped: true })
    expect(w.spawned[0]!.killed).toBe(true)
    expect(w.p.list()).toHaveLength(0)
  })

  test("install never runs package scripts; the dev process gets a sandbox HOME", async () => {
    const w = world({ noModules: true })
    await w.p.start("tlstudio", "main")
    expect(w.calls).toContainEqual(["bun", "install", "--ignore-scripts"])
    expect(w.spawned[0]!.env.HOME).toBe(join(w.root, ".home"))
    expect(w.spawned[0]!.env.HOME).not.toBe(process.env.HOME)
  })
})
