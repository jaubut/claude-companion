import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { BRAIN_THREAD } from "../lib/brain"
import { type ShFn, realSh } from "../lib/live-repo"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { redactSecrets } from "../lib/secret-redact"
import { type ExecFn } from "../lib/turso"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

// Auto-deploy on the brain host (Zettlab): claude-companion and claude-config
// follow origin/main, so nobody runs pull + restart by hand after a merge.
//   - Only these two repos, at fixed paths; the git verbs are fixed (fetch,
//     merge --ff-only). Never a reset, a force, a checkout of a ref, or a
//     command from the caller.
//   - claude-companion: on main, HEAD an ancestor of origin/main → `git merge
//     --ff-only` (git refuses before touching anything if a local edit would be
//     overwritten; other local edits stay) → `bun install --frozen-lockfile`
//     when package.json / bun.lock changed → `systemctl --user restart
//     --no-block claude-companion.service`. The row and event go first (the
//     restart kills this process); the next boot confirms it (confirmBoot).
//   - claude-config: its deploy is claude-config-sync.service (pull --ff-only
//     with the memory/ + skills/ runtime edits set aside and restored, never a
//     stash), started early; the poll confirms when ~/.claude reaches the head.
//   - Debounce: a new origin/main deploys once it has stayed put for QUIET_MS,
//     so a burst of merges is one deploy. A refused head is not retried until
//     origin/main moves again. bin/deploy skips the wait, not the checks.
// Every deploy: an agent_activity row (action "deploy") + a brain-thread event.

export const DEPLOY_REPOS = ["claude-companion", "claude-config"] as const
export type DeployRepo = (typeof DEPLOY_REPOS)[number]
export const DEPLOY_ACTION = "deploy"
export const POLL_MS = 60_000
export const QUIET_MS = 120_000
/** claude-config-sync gets this long to land the head before the event says it is held. */
export const SYNC_GRACE_MS = 10 * 60_000

export interface DeployDeps {
  sh: ShFn
  exec: ExecFn
  event(text: string): void
  now(): number
  home: string
}

export type DeployResult =
  | { ok: true; repo: DeployRepo; result: "up_to_date"; head: string }
  | { ok: true; repo: DeployRepo; result: "restarting" | "sync_started"; from: string; to: string; commits: number }
  | { ok: false; repo: string; error: string; detail?: string; from?: string; to?: string }

export const isDeployRepo = (r: unknown): r is DeployRepo => typeof r === "string" && (DEPLOY_REPOS as readonly string[]).includes(r)

const dirOf = (repo: DeployRepo, home: string) => (repo === "claude-companion" ? join(home, "claude-companion") : join(home, ".claude"))
const UNIT: Record<DeployRepo, string> = { "claude-companion": "claude-companion.service", "claude-config": "claude-config-sync.service" }
const markerPath = (home: string) => join(home, ".claude-companion", "deploy-pending.json")
const short = (s: string) => s.slice(0, 7)

async function git(deps: DeployDeps, dir: string, args: string[], timeoutMs = 60_000) {
  return deps.sh("git", ["-C", dir, ...args], { cwd: dir, timeoutMs })
}

async function record(deps: DeployDeps, repo: DeployRepo, summary: string, meta: Record<string, unknown>): Promise<void> {
  try {
    await deps.exec("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
      ["auto-deploy", DEPLOY_ACTION, "repo", repo, summary.slice(0, 200), JSON.stringify({ repo, ...meta })])
  } catch (err) {
    companionLog(`[deploy] activity row failed (${(err as Error)?.name ?? "error"})`)
  }
  deps.event(summary)
  companionLog(`[deploy] ${summary}`)
}

/** Where a repo stands against origin/main, after a fetch. Refusals are final for that head. */
async function inspect(deps: DeployDeps, repo: DeployRepo): Promise<{ dir: string; from: string; to: string } | Extract<DeployResult, { ok: false }>> {
  const dir = dirOf(repo, deps.home)
  if (!existsSync(join(dir, ".git"))) return { ok: false, repo, error: "no_checkout", detail: dir }
  const branch = await git(deps, dir, ["symbolic-ref", "-q", "--short", "HEAD"])
  if (branch.out.trim() !== "main") return { ok: false, repo, error: "not_on_main", detail: branch.out.trim() || "detached" }
  const fetched = await git(deps, dir, ["fetch", "-q", "origin", "main"])
  if (!fetched.ok) return { ok: false, repo, error: "fetch_failed", detail: fetched.err.trim().slice(0, 200) }
  const from = (await git(deps, dir, ["rev-parse", "HEAD"])).out.trim()
  const to = (await git(deps, dir, ["rev-parse", "refs/remotes/origin/main"])).out.trim()
  if (!from || !to) return { ok: false, repo, error: "rev_parse_failed" }
  return { dir, from, to }
}

/** Deploy one repo now (the debounce lives in the poller). */
export async function deployRepo(repo: string, source: "auto" | "brain", deps: DeployDeps = realDeps()): Promise<DeployResult> {
  if (!isDeployRepo(repo)) return { ok: false, repo, error: "repo_not_allowed" }
  const at = await inspect(deps, repo)
  if ("ok" in at) return at
  const { dir, from, to } = at
  if (from === to) return { ok: true, repo, result: "up_to_date", head: to }
  if (!(await git(deps, dir, ["merge-base", "--is-ancestor", from, to])).ok) {
    const out: DeployResult = { ok: false, repo, error: "not_fast_forward", from, to, detail: "local main has commits origin/main does not — never reset; fix by hand" }
    await record(deps, repo, `Deploy of ${repo} refused: ${short(from)} is not an ancestor of origin/main ${short(to)} (local commits) — fix by hand`, { from, to, result: out.error, source })
    return out
  }
  const commits = Number((await git(deps, dir, ["rev-list", "--count", `${from}..${to}`])).out.trim()) || 0

  if (repo === "claude-config") {
    const started = await deps.sh("systemctl", ["--user", "start", "--no-block", UNIT[repo]], { cwd: dir, timeoutMs: 30_000 })
    if (!started.ok) {
      await record(deps, repo, `Deploy of claude-config ${short(from)}→${short(to)} failed: could not start ${UNIT[repo]}`, { from, to, commits, result: "sync_start_failed", source })
      return { ok: false, repo, error: "sync_start_failed", from, to, detail: started.err.trim().slice(0, 200) }
    }
    await record(deps, repo, `Deploying claude-config ${short(from)}→${short(to)} (${commits} commit${commits === 1 ? "" : "s"}): claude-config-sync started`, { from, to, commits, result: "sync_started", source })
    return { ok: true, repo, result: "sync_started", from, to, commits }
  }

  const lockChanged = (await git(deps, dir, ["diff", "--name-only", from, to, "--", "package.json", "bun.lock"])).out.trim() !== ""
  const ff = await git(deps, dir, ["merge", "--ff-only", "--quiet", "refs/remotes/origin/main"])
  if (!ff.ok) {
    const detail = redactSecrets(ff.err.trim()).slice(0, 300)
    await record(deps, repo, `Deploy of claude-companion ${short(from)}→${short(to)} refused: the fast-forward would overwrite local edits (nothing changed) — ${detail.slice(0, 120)}`, { from, to, commits, result: "dirty_overlap", source })
    return { ok: false, repo, error: "dirty_overlap", from, to, detail }
  }
  if (lockChanged) {
    const inst = await deps.sh("bun", ["install", "--frozen-lockfile"], { cwd: dir, timeoutMs: 300_000 })
    if (!inst.ok) {
      await record(deps, repo, `claude-companion fast-forwarded ${short(from)}→${short(to)} but bun install failed — NOT restarted (still running ${short(from)})`, { from, to, commits, result: "install_failed", source })
      return { ok: false, repo, error: "install_failed", from, to, detail: inst.err.trim().slice(0, 200) }
    }
  }
  // Row, event and marker before the restart: --no-block returns at once, then systemd stops this process.
  await record(deps, repo, `Deploying claude-companion ${short(from)}→${short(to)} (${commits} commit${commits === 1 ? "" : "s"}${lockChanged ? ", deps installed" : ""}): restarting`, { from, to, commits, result: "restarting", source })
  try {
    mkdirSync(dirname(markerPath(deps.home)), { recursive: true })
    writeFileSync(markerPath(deps.home), JSON.stringify({ from, to, at: deps.now() }))
  } catch { /* the boot confirmation is lost, the deploy is not */ }
  const restart = await deps.sh("systemctl", ["--user", "restart", "--no-block", UNIT[repo]], { cwd: dir, timeoutMs: 30_000 })
  if (!restart.ok) {
    rmSync(markerPath(deps.home), { force: true })
    await record(deps, repo, `claude-companion is at ${short(to)} on disk but the restart failed — still running ${short(from)}`, { from, to, commits, result: "restart_failed", source })
    return { ok: false, repo, error: "restart_failed", from, to, detail: restart.err.trim().slice(0, 200) }
  }
  return { ok: true, repo, result: "restarting", from, to, commits }
}

/** On boot: a restart this module asked for is confirmed with the head the new process runs. */
export async function confirmBoot(deps: DeployDeps = realDeps()): Promise<void> {
  const file = markerPath(deps.home)
  let m: { from?: string; to?: string }
  try { m = JSON.parse(readFileSync(file, "utf8")) as typeof m } catch { return }
  rmSync(file, { force: true })
  const head = (await git(deps, dirOf("claude-companion", deps.home), ["rev-parse", "HEAD"])).out.trim()
  const ok = head === m.to
  await record(deps, "claude-companion", ok ? `claude-companion restarted at ${short(head)} (deploy ${short(m.from ?? "")}→${short(m.to ?? "")} done)` : `claude-companion restarted at ${short(head)}, expected ${short(m.to ?? "")}`, { from: m.from, to: m.to, head, result: ok ? "restarted" : "restart_mismatch" })
}

interface RepoState { seen: string | null; seenAt: number; tried: string | null; syncTarget: string | null; syncSince: number; busy: boolean }

/** The poll loop: debounce per repo, one deploy at a time per repo, claude-config-sync confirmation. */
export function createAutoDeploy(deps: DeployDeps) {
  const st = Object.fromEntries(DEPLOY_REPOS.map((r) => [r, { seen: null, seenAt: 0, tried: null, syncTarget: null, syncSince: 0, busy: false }])) as Record<DeployRepo, RepoState>

  async function run(repo: DeployRepo, source: "auto" | "brain"): Promise<DeployResult> {
    const s = st[repo]
    if (s.busy) return { ok: false, repo, error: "deploy_in_progress" }
    s.busy = true
    try {
      const out = await deployRepo(repo, source, deps)
      if ("to" in out && out.to) s.tried = out.to
      if (out.ok && out.result === "sync_started") { s.syncTarget = out.to; s.syncSince = deps.now() }
      return out
    } finally {
      s.busy = false
    }
  }

  async function tick(repo: DeployRepo): Promise<void> {
    const s = st[repo]
    if (s.busy) return
    const at = await inspect(deps, repo)
    if ("ok" in at) return // no checkout / not on main / offline: nothing to deploy from here
    if (s.syncTarget) {
      if (at.from === s.syncTarget || (await git(deps, at.dir, ["merge-base", "--is-ancestor", s.syncTarget, at.from])).ok) {
        await record(deps, repo, `claude-config deployed: ~/.claude is at ${short(at.from)}`, { to: s.syncTarget, head: at.from, result: "synced" })
        s.syncTarget = null
      } else if (deps.now() - s.syncSince >= SYNC_GRACE_MS) {
        let flags = ""
        try { flags = readFileSync(join(deps.home, ".claude", "state", "claude-config-sync", "last-flags"), "utf8").trim().slice(0, 300) } catch { /* none */ }
        await record(deps, repo, `claude-config not deployed after ${SYNC_GRACE_MS / 60_000} min: ~/.claude still at ${short(at.from)}, target ${short(s.syncTarget)}${flags ? ` — sync flags: ${flags}` : ""}`, { to: s.syncTarget, head: at.from, result: "sync_held" })
        s.syncTarget = null
      }
    }
    if (at.from === at.to) { s.seen = at.to; return }
    if (at.to !== s.seen) { s.seen = at.to; s.seenAt = deps.now(); return } // moved: start the quiet period
    if (deps.now() - s.seenAt < QUIET_MS || at.to === s.tried || at.to === s.syncTarget) return
    await run(repo, "auto")
  }

  return {
    /** bin/deploy: the same checks, without the quiet period. */
    deployNow: (repo: string): Promise<DeployResult> => (isDeployRepo(repo) ? run(repo, "brain") : Promise.resolve({ ok: false, repo, error: "repo_not_allowed" })),
    tick: async (): Promise<void> => {
      for (const r of DEPLOY_REPOS) {
        try { await tick(r) } catch (err) { companionLog(`[deploy] ${r} tick failed: ${(err as Error)?.message ?? err}`) }
      }
    },
  }
}

function realDeps(): DeployDeps {
  return {
    sh: realSh,
    exec: (sql, args) => dispatchWiring.exec(sql, args),
    event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
    now: Date.now,
    home: homedir(),
  }
}

let live: ReturnType<typeof createAutoDeploy> | null = null
/** The brain host's deployer (started with the brain, Linux only); null elsewhere. */
export function autoDeploy(): ReturnType<typeof createAutoDeploy> | null { return live }

export function startAutoDeploy(): void {
  if (live || process.platform !== "linux") return
  const deps = realDeps()
  live = createAutoDeploy(deps)
  void confirmBoot(deps)
  const loop = live
  setInterval(() => { void loop.tick() }, POLL_MS).unref?.()
}
