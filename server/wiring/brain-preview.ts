import { type ChildProcess, spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { type ShFn, isDir, realSh, repoEntriesSafe } from "../lib/live-repo"
import { companionLog } from "../lib/log"
import { type PreviewProxy, startPreviewProxy } from "../lib/preview-proxy"
import { redactSecrets } from "../lib/secret-redact"

// bin/preview (POST/GET /hooks/brain/preview, DELETE /hooks/brain/preview/<repo>):
// a live dev server for a web repo, reachable ONLY on the tailnet, so Jeremie
// sees changes on his phone with hot reload. Everything is decided here:
//   - allowlisted repos only (PREVIEW_REPOS), resolved through REPO_MAP; the
//     branch is validated; the brain never passes a command.
//   - a detached git worktree of origin/<branch> under the previews dir (never
//     the repo's main checkout, never ~/.claude), reused across starts and kept
//     on stop; `bun install` when node_modules is missing.
//   - the dev binary (astro / vite) from node_modules/.bin, chosen from the dev
//     script's text but never running it, bound to 127.0.0.1 on a free port,
//     with a minimal env: no server secrets, no .env (the worktree has none).
//   - lib/preview-proxy.ts in front (counts requests, passes HMR websockets),
//     exposed by `tailscale serve --https=<fixed port>`; never funnel.
//   - one preview per repo; 2 h without a request, a DELETE or the dev server
//     exiting stops it: process group killed, serve mapping removed.
// A failed start answers the dev log's last lines, redacted, never env contents.

/** Allowlisted repos (REPO_MAP names) → their dedicated tailnet https port. */
export const PREVIEW_REPOS: Readonly<Record<string, number>> = {
  tlstudio: 9401,
  "tls-dashboard-v2": 9402,
  "remorquage-pelchat": 9403,
  "remorquage-pelchat-web": 9404,
}
export const IDLE_MS = 2 * 60 * 60_000
const SWEEP_MS = 60_000
const READY_MS = 120_000
const INSTALL_MS = 10 * 60_000
const TAIL_LINES = 30
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/
const REPO_NAME = /^[A-Za-z0-9._-]{1,64}$/

export interface DevProc { pid: number; readonly exited: boolean; kill(): void }

export interface PreviewDeps {
  root: string
  repoPath(name: string): string | null
  sh: ShFn
  tailnetHost(): Promise<string | null>
  freePort(): Promise<number>
  spawnDev(cmd: string[], cwd: string, env: Record<string, string>, logFile: string, onExit: () => void): DevProc
  ready(port: number, proc: DevProc, timeoutMs: number): Promise<boolean>
  proxy(devPort: number, onHit: () => void): PreviewProxy
  now(): number
}

interface Live { repo: string; branch: string; url: string; servePort: number; proc: DevProc; proxy: PreviewProxy; since: number; lastHit: number }
type Out = { status: number; body: Record<string, unknown> }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { ok: false, error, ...extra } })

/** The allowlisted repo name for the brain's input (case-insensitive: "TLSTUDIO" → "tlstudio"), else null. */
export function previewRepo(input: unknown): string | null {
  if (typeof input !== "string" || !REPO_NAME.test(input)) return null
  const name = input.toLowerCase()
  return Object.hasOwn(PREVIEW_REPOS, name) ? name : null
}

export function validBranch(input: unknown): input is string {
  return typeof input === "string" && BRANCH.test(input)
}

function devScript(dir: string): string | null {
  try {
    const s = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts?.dev
    return typeof s === "string" ? s : null
  } catch {
    return null
  }
}

/** Which dev binary to run where: astro or vite at the root, else a vite client/ (dashboard-style repos: frontend only). */
export function devPlan(wt: string): { cwd: string; bin: "astro" | "vite" } | null {
  const root = devScript(wt) ?? ""
  if (/\bastro\b/.test(root)) return { cwd: wt, bin: "astro" }
  if (/\bvite\b/.test(root)) return { cwd: wt, bin: "vite" }
  if (/\bvite\b/.test(devScript(join(wt, "client")) ?? "")) return { cwd: join(wt, "client"), bin: "vite" }
  return null
}

export function devArgs(bin: "astro" | "vite", port: number): string[] {
  const p = String(port)
  return bin === "astro" ? ["dev", "--host", "127.0.0.1", "--port", p] : ["--host", "127.0.0.1", "--port", p, "--strictPort"]
}

/** The only env a preview process gets: no tokens from the companion server's own env. */
export function previewEnv(host: string | null): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || homedir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_ENV: "development",
    BROWSER: "none",
    ASTRO_TELEMETRY_DISABLED: "1",
  }
  if (host) env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = host
  return env
}

/** The last lines of a dev log, secrets masked. */
export function logTail(file: string): string[] {
  let text = ""
  try { text = readFileSync(file, "utf8") } catch { return [] }
  return text.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-TAIL_LINES).map((l) => redactSecrets(l).slice(0, 300))
}

export function createPreviews(deps: PreviewDeps) {
  const live = new Map<string, Live>()
  const starting = new Map<string, Promise<Out>>()
  const view = (l: Live) => ({
    repo: l.repo, branch: l.branch, url: l.url,
    since: new Date(l.since).toISOString(), lastRequestAt: new Date(l.lastHit).toISOString(),
    idleStopAt: new Date(l.lastHit + IDLE_MS).toISOString(),
  })
  const sh = (cmd: string, args: string[], cwd: string, timeoutMs = 60_000) => deps.sh(cmd, args, { cwd, timeoutMs, env: previewEnv(null) })
  const serveOff = (port: number) => sh("tailscale", ["serve", `--https=${port}`, "off"], "/", 20_000)

  async function worktree(repoPath: string, wt: string, branch: string): Promise<Out | null> {
    if (existsSync(join(wt, ".git"))) return null
    await sh("git", ["-C", repoPath, "fetch", "--quiet", "origin", branch], repoPath, 90_000)
    const ref = `refs/remotes/origin/${branch}`
    if (!(await sh("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath)).ok) return fail(404, "branch_not_found", { branch })
    await sh("git", ["-C", repoPath, "worktree", "prune"], repoPath)
    mkdirSync(join(wt, ".."), { recursive: true })
    const add = await sh("git", ["-C", repoPath, "worktree", "add", "--detach", wt, ref], repoPath)
    return add.ok ? null : fail(502, "worktree_failed", { detail: redactSecrets(add.err.trim()).slice(-300) })
  }

  async function install(dirs: string[]): Promise<Out | null> {
    for (const dir of [...new Set(dirs)]) {
      if (!existsSync(join(dir, "package.json")) || isDir(join(dir, "node_modules"))) continue
      const r = await sh("bun", ["install"], dir, INSTALL_MS)
      if (!r.ok) return fail(502, "install_failed", { log: (r.err || r.out).trim().split("\n").slice(-TAIL_LINES).map((l) => redactSecrets(l).slice(0, 300)) })
    }
    return null
  }

  async function launch(repo: string, branch: string): Promise<Out> {
    const repoPath = deps.repoPath(repo)
    if (!repoPath) return fail(404, "repo_not_found", { repo })
    const host = await deps.tailnetHost()
    if (!host) return fail(503, "tailscale_unavailable")
    const wt = join(deps.root, repo, branch.replace(/\//g, "__"))
    const refusal = await worktree(repoPath, wt, branch)
    if (refusal) return refusal
    const plan = devPlan(wt)
    if (!plan) return fail(422, "no_dev_server")
    const installed = await install([wt, plan.cwd])
    if (installed) return installed
    const port = await deps.freePort()
    const local = join(plan.cwd, "node_modules", ".bin", plan.bin)
    const bin = existsSync(local) ? local : join(wt, "node_modules", ".bin", plan.bin)
    const logFile = join(deps.root, `${repo}.log`)
    const servePort = PREVIEW_REPOS[repo]!
    let entry: Live | null = null
    const proc = deps.spawnDev([bin, ...devArgs(plan.bin, port)], plan.cwd, previewEnv(host), logFile, () => {
      if (entry && live.get(repo) === entry) void stop(repo, "exited")
    })
    if (!(await deps.ready(port, proc, READY_MS))) {
      proc.kill()
      return fail(502, "dev_failed", { log: logTail(logFile) })
    }
    const proxy = deps.proxy(port, () => { if (entry) entry.lastHit = deps.now() })
    const t = deps.now()
    const e: Live = { repo, branch, url: `https://${host}:${servePort}/`, servePort, proc, proxy, since: t, lastHit: t }
    entry = e
    const serve = await sh("tailscale", ["serve", "--bg", `--https=${servePort}`, `http://127.0.0.1:${e.proxy.port}`], "/", 30_000)
    if (!serve.ok) {
      proc.kill()
      e.proxy.stop()
      return fail(502, "serve_failed", { detail: redactSecrets(serve.err.trim()).slice(-300) })
    }
    live.set(repo, e)
    companionLog(`[preview] ${repo}@${branch} up at ${e.url} (dev 127.0.0.1:${port})`)
    return { status: 200, body: { ok: true, ...view(e), reused: false } }
  }

  async function start(repo: string, branch: string): Promise<Out> {
    const l = live.get(repo)
    if (l) return { status: 200, body: { ok: true, ...view(l), reused: true } }
    const pending = starting.get(repo)
    if (pending) return pending
    const p = launch(repo, branch).finally(() => starting.delete(repo))
    starting.set(repo, p)
    return p
  }

  async function stop(repo: string, why = "stopped"): Promise<Out> {
    const l = live.get(repo)
    if (!l) return fail(404, "not_running", { repo })
    live.delete(repo)
    l.proc.kill()
    l.proxy.stop()
    const off = await serveOff(l.servePort)
    companionLog(`[preview] ${repo} ${why}${off.ok ? "" : " (serve off failed)"}`)
    return { status: 200, body: { ok: true, stopped: true, repo, reason: why } }
  }

  return {
    start,
    stop: (repo: string) => stop(repo),
    list: () => [...live.values()].map(view),
    /** Stops every preview idle for IDLE_MS. */
    async sweepIdle(): Promise<string[]> {
      const idle = [...live.values()].filter((l) => deps.now() - l.lastHit >= IDLE_MS).map((l) => l.repo)
      for (const r of idle) await stop(r, "idle 2 h")
      return idle
    },
    /** Boot: a restart killed the dev servers; drop the serve mappings they left. */
    async clearStale(): Promise<void> {
      for (const port of Object.values(PREVIEW_REPOS)) await serveOff(port)
    },
  }
}

export type Previews = ReturnType<typeof createPreviews>

function realSpawn(cmd: string[], cwd: string, env: Record<string, string>, logFile: string, onExit: () => void): DevProc {
  const fd = openSync(logFile, "w")
  let child: ChildProcess
  try {
    child = spawn(cmd[0]!, cmd.slice(1), { cwd, env, detached: true, stdio: ["ignore", fd, fd] })
  } finally {
    closeSync(fd)
  }
  let exited = false
  const done = () => { if (!exited) { exited = true; onExit() } }
  child.on("exit", done)
  child.on("error", done)
  const signal = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig) } catch { /* gone */ } }
  return {
    pid: child.pid ?? 0,
    get exited() { return exited },
    kill() {
      signal("SIGTERM")
      setTimeout(() => { if (!exited) signal("SIGKILL") }, 5_000).unref?.()
    },
  }
}

async function realReady(port: number, proc: DevProc, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until && !proc.exited) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000), redirect: "manual" })
      return true
    } catch { /* not up yet */ }
    await Bun.sleep(500)
  }
  return false
}

function realFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const a = s.address()
      const port = typeof a === "object" && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

async function realTailnetHost(): Promise<string | null> {
  const r = await realSh("tailscale", ["status", "--json"], { cwd: "/", timeoutMs: 10_000 })
  if (!r.ok) return null
  try {
    const name = String((JSON.parse(r.out) as { Self?: { DNSName?: string } }).Self?.DNSName ?? "").replace(/\.$/, "")
    return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(name) ? name.toLowerCase() : null
  } catch {
    return null
  }
}

/** The first REPO_MAP checkout of `name` on this host. */
function realRepoPath(name: string): string | null {
  return repoEntriesSafe().find((e) => e.name === name && existsSync(join(e.path, ".git")))?.path ?? null
}

const previewsRoot = (): string => process.env.COMPANION_PREVIEWS_DIR || join(process.env.HOME || homedir(), ".claude-companion", "previews")

let shared: Previews | null = null
/** The host's preview manager (created on first use). */
export function previews(): Previews {
  shared ??= createPreviews({
    root: previewsRoot(),
    repoPath: realRepoPath,
    sh: realSh,
    tailnetHost: realTailnetHost,
    freePort: realFreePort,
    spawnDev: realSpawn,
    ready: realReady,
    proxy: startPreviewProxy,
    now: Date.now,
  })
  return shared
}

/** Brain host boot: clear stale serve mappings, then the idle sweep. */
export function startPreviews(): void {
  if (process.platform !== "linux") return
  const p = previews()
  void p.clearStale()
  setInterval(() => { void p.sweepIdle() }, SWEEP_MS).unref?.()
}
