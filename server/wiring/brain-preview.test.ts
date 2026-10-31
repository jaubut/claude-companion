import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ShFn } from "../lib/live-repo"
import { IDLE_MS, PREVIEW_REPOS, createPreviews, devPlan, previewEnv, previewRepo, validBranch } from "./brain-preview"

// bin/preview manager (wiring/brain-preview.ts): git / tailscale faked at the
// shell seam, the dev process and the proxy faked, the worktree a real dir.

function world(opts: { ready?: boolean; serveOk?: boolean; dev?: string; branchExists?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cc-preview-"))
  const calls: string[][] = []
  const spawned: Array<{ cmd: string[]; cwd: string; env: Record<string, string>; killed: boolean; exit: () => void }> = []
  const proxies: Array<{ hit: () => void; stopped: boolean }> = []
  let clock = 1_000_000
  const sh: ShFn = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === "git" && args.includes("rev-parse")) return { ok: opts.branchExists !== false, code: opts.branchExists === false ? 1 : 0, out: "", err: "" }
    if (cmd === "git" && args.includes("add")) {
      const wt = args[args.indexOf("--detach") + 1]!
      mkdirSync(join(wt, "node_modules", ".bin"), { recursive: true })
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
      const s = { cmd, cwd, env, killed: false, exit: onExit }
      spawned.push(s)
      return { pid: 4242, exited: false, kill: () => { s.killed = true } }
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
    const env = previewEnv("h.ts.net")
    expect(Object.values(env)).not.toContain("super-secret")
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
    expect(w.calls).toContainEqual(["git", "-C", "/repos/tlstudio", "worktree", "add", "--detach", join(w.root, "tlstudio", "main"), "refs/remotes/origin/main"])
    expect(w.spawned[0]!.cmd.slice(1)).toEqual(["dev", "--host", "127.0.0.1", "--port", "51234"])
    expect(w.spawned[0]!.cwd).toBe(join(w.root, "tlstudio", "main"))
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
    expect(w.spawned[0]!.cwd).toBe(join(w.root, "tls-dashboard-v2", "main", "client"))
    expect(w.spawned[0]!.cmd.slice(1)).toEqual(["--host", "127.0.0.1", "--port", "51234", "--strictPort"])
    expect(serveCalls(w.calls)[0]).toContain("--https=9402")
  })
})
