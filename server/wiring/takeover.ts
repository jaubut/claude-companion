import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { localBodyHost } from "../lib/body-investigate"
import { type PeerConfig, bodyPeer } from "../lib/body-investigate-engine"
import { type TakeoverOutcome, claimTakeover, detectPrUrl, finishTakeover, takeoverOwner } from "../lib/dispatch-live"
import { type DispatchTask, type LiveIdentity, type WriteOutcome, getDispatchTask } from "../lib/dispatch-tasks"
import { type Herdr, closeHerdrWorkspaceWhenIdle, forgetHerdrAgent, realHerdr } from "../lib/herdr"
import { type HerdrDelivery, deliverViaHerdr } from "../lib/herdr-inject"
import { pumpPrompt } from "../lib/herdr-seed"
import { type RepoEntry, hostCan, isDir, repoEntriesSafe } from "../lib/live-repo"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { db } from "../lib/orchestrator-db"
import { type ShFn, realSh } from "../lib/resolver-fix"
import { listSessions } from "../lib/sessions"
import { type SpawnResult, spawnCompanionSession } from "../lib/spawn-session"
import {
  NO_CHANGES_BLOCKER, type TakeoverHost, doneLine, endedBlocker, entryByName, failedBlocker, howToRef, logSection, seedPrompt,
  takeoverBranch, takeoverName, taskId8,
} from "../lib/takeover"
import { OPEN_STATUSES, type TakeoverRow, type TakeoverStatus, type TakeoverStore, createTakeoverStore } from "../lib/takeover-store"
import { taskVersion } from "../lib/triage-sources"
import { TursoUnreachable } from "../lib/turso"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { createLiveness } from "./takeover-liveness"
import { orchEmit, writeCtx } from "./orchestrator"

// Blocked-task takeover, live (docs/orchestrator-triage-api.md#takeover). The choose
// is claim-then-async: re-read + checks + store row + the Turso claim, then 200;
// worktree, herdr start and seed run in the background (a failure → the task
// blocked again with why). The run ends from ground truth: a PR on its branch (or
// a `TAKEOVER DONE:` line) at a Stop → completed; SessionEnd or a dead pane →
// one last PR check, else blocked "Takeover ended without a PR…". Wrong host →
// forwarded to the peer (never re-forwarded). Turso down mid-finish → the run
// stays `finishing`; the 60 s tick retries.

export const TAKEOVER_HOP = "x-companion-takeover-hop"
export const TICK_MS = 60_000
const GH_EVERY_MS = 30_000
/** A run never seen with a registered session may take this long to show one before the tick counts misses. */
const RELEASE_TRIES = 4

export interface TakeoverDeps {
  dispatch: () => DispatchWiring
  store: () => TakeoverStore
  localHost: () => TakeoverHost
  entries: () => RepoEntry[]
  canRun: (e: RepoEntry) => boolean
  isDir: (p: string) => boolean
  herdr: Herdr
  spawn: typeof spawnCompanionSession
  deliver: (pane: string, text: string) => Promise<HerdrDelivery>
  sh: ShFn
  peer: () => PeerConfig | null
  fetchFn: typeof fetch
  sessions: () => { key: string; taskId: string }[]
  /** Dispatch-run logs, newest first (≤ 20 files, ≤ 3 days). */
  logs: () => string[]
  /** Where worktrees go: ~/.claude-companion/takeover. */
  root: () => string
  turn: (text: string, taskId: string, channelId: string) => void
  writeCtx: (dispatch: DispatchWiring, channel: string | null) => Promise<Parameters<typeof claimTakeover>[0]>
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (msg: string) => void
}

function dispatchLogs(): string[] {
  const dir = join(process.env.HOME || homedir(), ".claude", "logs", "dispatch")
  try {
    const since = Date.now() - 3 * 86_400_000
    return readdirSync(dir).filter((f) => f.endsWith(".log"))
      .map((f) => ({ f: join(dir, f), at: statSync(join(dir, f)).mtimeMs })).filter((x) => x.at >= since)
      .sort((a, b) => b.at - a.at).slice(0, 20).map((x) => readFileSync(x.f, "utf8"))
  } catch {
    return []
  }
}

let liveStore: TakeoverStore | null = null

const defaults = (): TakeoverDeps => ({
  // Lazy (deps are built on first use): wiring/dispatch imports this module (liveIdentity).
  dispatch: () => dispatchWiring,
  store: () => (liveStore ??= createTakeoverStore(db)),
  localHost: () => localBodyHost(),
  entries: () => repoEntriesSafe(),
  canRun: (e) => hostCan(e),
  isDir,
  herdr: realHerdr,
  spawn: spawnCompanionSession,
  deliver: (pane, text) => deliverViaHerdr(pane, text),
  sh: realSh,
  peer: () => bodyPeer(),
  fetchFn: fetch,
  sessions: () => listSessions(),
  logs: dispatchLogs,
  root: () => join(process.env.HOME || homedir(), ".claude-companion", "takeover"),
  turn: (text, taskId, channelId) => orchEmit(appendTurn("orchestrator", text, taskId, channelId)),
  writeCtx,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: companionLog,
})

let deps: TakeoverDeps | null = null
const d = (): TakeoverDeps => (deps ??= defaults())
/** The live deps (wiring/takeover-choose.ts). */
export const takeoverDeps = d
const running = new Map<string, Promise<void>>()
/** Pending seeds (in memory: a Companion restart drops them), apart from `running` so the tick keeps checking the run. */
const seeding = new Map<string, Promise<void>>()
/** Names a reconcile or a tick row is working on right now (taken before the first await). */
const held = new Set<string>()
let tickStartedAt = 0
let skipLoggedAt = 0
const misses = new Map<string, number>()
const ghAt = new Map<string, number>()

/** Test seam: override some deps (and forget the in-memory run state); returns the previous set. */
export function setTakeoverDeps(patch: Partial<TakeoverDeps>): TakeoverDeps {
  const prev = d()
  deps = { ...prev, ...patch }
  misses.clear()
  live.reset()
  ghAt.clear()
  return prev
}

/** Test seam: every background start finished. */
export async function takeoverIdle(): Promise<void> {
  while (running.size || seeding.size) await Promise.all([...running.values(), ...seeding.values()])
}

export interface TakeoverDetail {
  host: TakeoverHost; session: string; cwd: string; branch: string; dispatchTaskId: string; status: TakeoverStatus; replay?: boolean
}

export type StartResult = { ok: true; detail: TakeoverDetail } | { ok: false; status: number; error: string; extra?: Record<string, unknown> }

export interface StartInput { taskId: string; version: string; repo: string; by: string; logTail?: string | null }

const detailOf = (r: TakeoverRow, replay = false): TakeoverDetail => ({
  host: r.host, session: r.name, cwd: r.cwd, branch: r.branch, dispatchTaskId: r.taskId, status: r.status, ...(replay ? { replay: true } : {}),
})

const refuse = (error: string, extra?: Record<string, unknown>): StartResult => ({ ok: false, status: 409, error, ...(extra ? { extra } : {}) })
const hostLabel = (h: TakeoverHost): string => (h === "mac" ? "the Mac" : "Zettlab")
const who = (t: Pick<DispatchTask, "id" | "title">): string => `[${taskId8(t.id)}] ${t.title}`

const live = createLiveness(() => d())
const sessionLive = live.sessionLive

/** Close a finished run's own single-pane workspace (labelled with its name) once the pane is at the shell; true = herdr has no agent left. */
async function releaseWorkspace(name: string): Promise<boolean> {
  const found = await live.agentOf(name)
  if (found.kind === "absent") return true
  if (found.kind === "error" || !found.ref.pane || sessionLive(name)) return false
  const agent = found.ref
  const ws = await closeHerdrWorkspaceWhenIdle(agent.pane, {
    h: d().herdr, tries: RELEASE_TRIES, sleep: d().sleep, stillFree: () => !sessionLive(name),
    owner: { name, workspaceId: agent.workspaceId, terminalId: agent.terminalId },
  })
  if (!ws) return false
  forgetHerdrAgent(agent.pane)
  d().log(`[takeover] ${name}: herdr workspace ${ws} closed (run finished, session gone)`)
  return true
}

const FINISHED: readonly TakeoverStatus[] = ["done", "ended", "failed"]

/** A herdr agent holds the name: free when it is a finished run's leftover (released here), else taken. */
async function nameTaken(name: string): Promise<boolean> {
  const found = await live.agentOf(name)
  if (found.kind === "absent") return false
  if (found.kind === "error") return true // herdr could not say: never risk a second agent of that name
  const last = d().store().get(name)
  if (!last || !FINISHED.includes(last.status) || sessionLive(name)) return true
  return !(await releaseWorkspace(name))
}

/** The local start (choose on this host, or the peer endpoint). Throws TursoUnreachable before the claim lands. */
export async function startTakeover(input: StartInput): Promise<StartResult> {
  const store = d().store()
  const open = store.openFor(input.taskId)
  if (open && uncertain(open)) {
    const r = await locked(open.name, () => reconcileClaim(open))
    if (r === "unknown") throw new TursoUnreachable("claim still uncertain")
    if (r !== "failed") return { ok: true, detail: detailOf(store.get(open.name)!, true) } // ours, or a reconcile already on it
  } else if (open) return { ok: true, detail: detailOf(open, true) }
  const dispatch = d().dispatch()
  const found = await getDispatchTask(dispatch.query, await dispatch.columns(), input.taskId)
  if (!found) return refuse("stale")
  const t = found.task
  if (t.status !== "blocked" || t.done || taskVersion(t) !== input.version) return refuse("stale")
  const entry = entryByName(input.repo, d().entries())
  if (!entry?.name || !d().isDir(entry.path) || !d().canRun(entry)) return refuse("no_checkout", { repo: input.repo })
  const gate = await d().herdr.gate()
  if (gate) return refuse("herdr_unavailable", { reason: gate })
  const host = d().localHost()
  const name = takeoverName(host, t.id)
  if (await nameTaken(name)) return refuse("name_taken", { session: name })
  // The original blocker is saved before the claim clears it on the row.
  const { row, created } = store.create({
    name, taskId: t.id, host, repo: entry.name, cwd: join(d().root(), name), branch: takeoverBranch(t.id),
    origBlocker: t.blocker ?? "", taskVersion: input.version,
  }, d().now())
  if (!created) return { ok: true, detail: detailOf(row, true) }
  const channel = dispatch.threadIdFor(t)
  const runId = `tko_${createHash("sha256").update(`${name}:${d().now()}`).digest("hex").slice(0, 16)}`
  let claim: WriteOutcome
  try {
    claim = await claimTakeover(await d().writeCtx(dispatch, channel), t.id, t.updatedAtRaw, name, runId)
  } catch (err) {
    // The UPDATE may have landed with its answer lost: the run stays `starting`, marked, and the
    // tick (or a retried choose) reads the row back before anything else happens.
    if (err instanceof TursoUnreachable) store.move(name, ["starting"], "starting", d().now(), { outcome: CLAIM_UNCERTAIN })
    else store.move(name, ["starting"], "failed", d().now(), { outcome: `claim failed: ${(err as Error)?.message ?? err}` })
    throw err
  }
  if (!claim.ok) {
    store.move(name, ["starting"], "failed", d().now(), { outcome: `claim lost (${claim.error})` })
    if (claim.error !== "no_such_task") dispatch.applyLocal(claim.task)
    return refuse("stale")
  }
  dispatch.applyLocal(claim.task)
  d().turn(`🧑‍💻 Takeover: session ${name} starting on ${hostLabel(host)} for ${who(t)} (${input.by})`, t.id, channel)
  launch(row, entry, t, found.description, input.logTail ?? null)
  return { ok: true, detail: detailOf(row) }
}

function launch(row: TakeoverRow, entry: RepoEntry, t: DispatchTask, description: string, logTail: string | null): void {
  const p = continueStart(row, entry, t, description, logTail)
    .catch((err) => d().log(`[takeover] ${row.name}: start failed and could not be closed (${(err as Error)?.message ?? err}) — the tick retries`))
    .finally(() => running.delete(row.name))
  running.set(row.name, p)
}

/** Run `fn` holding `name`; null (nothing run) when another reconcile / tick row holds it. */
async function locked<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  if (held.has(name)) return null
  held.add(name)
  try {
    return await fn()
  } finally {
    held.delete(name)
  }
}

const CLAIM_UNCERTAIN = JSON.stringify({ claim: "uncertain" })
const uncertain = (row: TakeoverRow): boolean => row.status === "starting" && row.outcome === CLAIM_UNCERTAIN

/** A claim whose answer was lost: ours (running, our owner) → the start goes on; else failed (never landed); unknown = Turso still down. */
async function reconcileClaim(seen: TakeoverRow): Promise<"ours" | "failed" | "unknown"> {
  // Re-read under the lock: a reconcile that just finished already settled it.
  const row = d().store().get(seen.name)
  if (!row || !uncertain(row)) return row?.status === "failed" ? "failed" : "ours"
  const dispatch = d().dispatch()
  let found: Awaited<ReturnType<typeof getDispatchTask>>
  try {
    found = await getDispatchTask(dispatch.query, await dispatch.columns(), row.taskId)
  } catch (err) {
    if (err instanceof TursoUnreachable) return "unknown"
    throw err
  }
  const store = d().store()
  if (!found || found.task.status !== "running" || found.task.owner !== takeoverOwner(row.name)) {
    store.move(row.name, ["starting"], "failed", d().now(), { outcome: "claim never landed" })
    return "failed"
  }
  // Lost the CAS: another path already settled this run.
  if (!store.move(row.name, ["starting"], "starting", d().now(), { outcome: null })) return "ours"
  dispatch.applyLocal(found.task)
  const entry = entryByName(row.repo, d().entries())
  if (!entry) {
    await finish(row.name, { status: "blocked", blocker: failedBlocker("claim uncertain, repo gone", row.origBlocker) }, "failed")
    return "ours"
  }
  d().log(`[takeover] ${row.name}: claim confirmed after a lost answer — starting the session`)
  launch(store.get(row.name)!, entry, found.task, found.description, null)
  return "ours"
}

async function worktree(row: TakeoverRow, repo: string): Promise<string | null> {
  if (d().isDir(row.cwd)) return null // kept from an earlier takeover of this task
  const git = (args: string[], timeoutMs = 60_000) => d().sh("git", ["-C", repo, ...args], { cwd: repo, timeoutMs })
  const fetched = await git(["fetch", "origin"], 120_000)
  if (!fetched.ok) return `git fetch: ${fetched.err.trim().slice(0, 120) || `exit ${fetched.code}`}`
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  const base = head.ok && head.out.trim() ? head.out.trim() : "origin/main"
  const has = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${row.branch}`])
  const add = await git(has.ok ? ["worktree", "add", row.cwd, row.branch] : ["worktree", "add", "-b", row.branch, row.cwd, base])
  return add.ok ? null : `git worktree add: ${add.err.trim().slice(0, 120) || `exit ${add.code}`}`
}

export function localLog(title: string, blocker: string): string | null {
  if (!NO_CHANGES_BLOCKER.test(blocker)) return null
  const ref = howToRef(blocker)
  for (const text of d().logs()) {
    const hit = logSection(text, title, ref)
    if (hit) return hit
  }
  return null
}

async function howTo(ref: string | null): Promise<{ ref: string; body: string } | null> {
  if (!ref) return null
  const rows = await d().dispatch().query("SELECT body FROM notes WHERE ref_code = ? LIMIT 1", [ref]).catch(() => [])
  const body = rows[0]?.body
  return typeof body === "string" && body.trim() ? { ref, body } : null
}

interface SeedJob { row: TakeoverRow; pane: string; text: string; taskId: string; channel: string }

/** Deliver the seed once nothing is in the way, while the run is active (lib/herdr-seed.ts); a dialog in the way is named in the task's channel once. */
async function pumpSeed(j: SeedJob): Promise<void> {
  const { name } = j.row
  const out = await pumpPrompt({
    gate: () => live.seedGate(name, j.pane),
    deliver: () => d().deliver(j.pane, j.text),
    stillWanted: () => d().store().get(name)?.status === "active",
    onDialog: (title) => d().turn(`⏸️ Takeover ${name} is waiting on ${title ? `"${title}"` : "a dialog"} — answer it in Sessions (Remote Control: ${name}); the task prompt goes in once it clears`, j.taskId, j.channel),
    now: () => d().now(),
    sleep: (ms) => d().sleep(ms),
  })
  if (out.kind === "dropped") return d().log(`[takeover] ${name}: run settled before its seed went in — seed dropped`)
  if (out.kind === "delivered") return d().turn(`Takeover ${name} is ready on ${hostLabel(j.row.host)} — open it in Sessions (Remote Control: ${name})`, j.taskId, j.channel)
  d().turn(`Takeover ${name}: the session runs but the seed prompt was not delivered — tell it the task yourself`, j.taskId, j.channel)
}

async function continueStart(row: TakeoverRow, entry: RepoEntry, t: DispatchTask, description: string, logTail: string | null): Promise<void> {
  const channel = d().dispatch().threadIdFor(t)
  try {
    const why = await worktree(row, entry.path)
    if (why) return await finish(row.name, { status: "blocked", blocker: failedBlocker(why, row.origBlocker) }, "failed")
    const r: SpawnResult = await d().spawn({ cwd: row.cwd, agent: "claude", env: { COMPANION_TASK_ID: row.name }, herdr: { name: row.name, args: ["--remote-control", row.name] }, mcpFrom: entry.path })
    if (!r.ok || !r.herdrPane) return await finish(row.name, { status: "blocked", blocker: failedBlocker(r.error ?? "no herdr pane", row.origBlocker) }, "failed")
    if (!d().store().move(row.name, ["starting"], "active", d().now())) {
      d().log(`[takeover] ${row.name}: run settled while its session started — no seed`)
      return
    }
    const seed = seedPrompt({
      name: row.name, taskId: t.id, title: t.title, project: t.projectTitle, repo: row.repo, host: row.host, cwd: row.cwd, branch: row.branch,
      origBlocker: row.origBlocker, description, howTo: await howTo(howToRef(row.origBlocker) ?? howToRef(description)),
      log: logTail ?? localLog(t.title, row.origBlocker),
    })
    const p = pumpSeed({ row, pane: r.herdrPane, text: seed, taskId: t.id, channel })
      .catch((err) => d().log(`[takeover] ${row.name}: seed failed (${(err as Error)?.message ?? err})`))
      .finally(() => seeding.delete(row.name))
    seeding.set(row.name, p)
  } catch (err) {
    await finish(row.name, { status: "blocked", blocker: failedBlocker((err as Error)?.message ?? "error", row.origBlocker) }, "failed")
  }
}

// ── finishing ────────────────────────────────────────────────────────────────

type Final = Extract<TakeoverStatus, "done" | "ended" | "failed">
interface Pending { outcome: TakeoverOutcome; final: Final }

function pendingOf(raw: string | null): Pending | null {
  try {
    const p = JSON.parse(raw ?? "") as Pending
    return p && typeof p === "object" && p.outcome && p.final ? p : null
  } catch {
    return null
  }
}

/** First caller wins (starting|active → finishing CAS), then the Turso write; the rest are no-ops. */
async function finish(name: string, outcome: TakeoverOutcome, final: Final): Promise<void> {
  const prUrl = outcome.status === "completed" ? outcome.prUrl ?? null : undefined
  if (!d().store().move(name, ["starting", "active"], "finishing", d().now(), { outcome: JSON.stringify({ outcome, final }), prUrl })) return
  const row = d().store().get(name)
  if (row) await flush(row)
}

function finishTurn(row: TakeoverRow, p: Pending, t: DispatchTask): string {
  const o = p.outcome
  if (o.status === "completed") return `✅ Takeover ${row.name} ${o.prUrl ? `opened ${o.prUrl}` : `done: ${o.what ?? "no PR needed"}`} — ${who(t)} → completed`
  if (p.final === "failed") return `⚠️ ${o.blocker.split(" — ")[0]} — ${who(t)} is blocked again`
  return `Takeover ${row.name} ended without a PR — ${who(t)} is blocked again`
}

async function flush(row: TakeoverRow): Promise<void> {
  const p = pendingOf(row.outcome)
  if (!p) {
    d().store().move(row.name, ["finishing"], "failed", d().now())
    return
  }
  const dispatch = d().dispatch()
  const cached = dispatch.cached(row.taskId)
  let out: WriteOutcome
  try {
    out = await finishTakeover(await d().writeCtx(dispatch, cached ? dispatch.threadIdFor(cached) : null), row.taskId, row.name, p.outcome)
  } catch (err) {
    if (!(err instanceof TursoUnreachable)) throw err
    d().log(`[takeover] ${row.name}: Turso unreachable — finish retried on the next tick`)
    return
  }
  d().store().move(row.name, ["finishing"], p.final, d().now())
  if (out.ok || out.error !== "no_such_task") dispatch.applyLocal(out.task)
  if (out.ok) d().turn(finishTurn(row, p, out.task), out.task.id, dispatch.threadIdFor(out.task))
  else d().log(`[takeover] ${row.name}: task ${taskId8(row.taskId)} no longer ours (${out.error}) — nothing written`)
  // A finished-with-PR session may keep going: its worktree and workspace wait for it to end.
  d().store().setCleanup(row.name, true, d().now())
  await tidy(row.name)
}

/** Remove a finished run's worktree and workspace once its session is gone; else leave it pending (the tick retries). */
async function tidy(name: string): Promise<void> {
  const row = d().store().get(name)
  if (!row?.cleanupPending || OPEN_STATUSES.includes(row.status) || await live.alive(name)) return
  await cleanup(row)
  await releaseWorkspace(name).catch(() => false)
  d().store().setCleanup(name, false, d().now())
}

/** Remove the worktree only when it is clean and every commit is on a remote; else keep it and say so. */
async function cleanup(row: TakeoverRow): Promise<void> {
  const repo = entryByName(row.repo, d().entries())?.path
  if (!repo || !d().isDir(row.cwd)) return
  const git = (args: string[]) => d().sh("git", ["-C", row.cwd, ...args], { cwd: row.cwd, timeoutMs: 30_000 })
  const dirty = await git(["status", "--porcelain"])
  const unpushed = await git(["log", "--oneline", "HEAD", "--not", "--remotes"])
  if (!dirty.ok || !unpushed.ok || dirty.out.trim() || unpushed.out.trim()) {
    d().log(`[takeover] ${row.name}: worktree kept at ${row.cwd} (uncommitted or unpushed work)`)
    return
  }
  const rm = await d().sh("git", ["-C", repo, "worktree", "remove", row.cwd], { cwd: repo, timeoutMs: 30_000 })
  if (!rm.ok) d().log(`[takeover] ${row.name}: worktree remove failed (${rm.err.trim().slice(0, 120)}) — kept`)
}

/** The run's PR, any state (≤ 1 check / 30 s unless forced): a URL from the turn only when gh says its head is our branch, else the branch's listing. */
async function branchPr(row: TakeoverRow, force: boolean, text = ""): Promise<string | null> {
  const last = ghAt.get(row.name) ?? 0
  if (!force && d().now() - last < GH_EVERY_MS) return null
  ghAt.set(row.name, d().now())
  const cwd = d().isDir(row.cwd) ? row.cwd : entryByName(row.repo, d().entries())?.path
  if (!cwd) return null
  // The branch name repeats across takeovers of one task: only a PR opened during this run counts.
  const ours = (createdAt: unknown): boolean => typeof createdAt === "string" && Date.parse(createdAt) >= row.createdAt
  const said = detectPrUrl(text)
  if (said) {
    const v = await d().sh("gh", ["pr", "view", said, "--json", "headRefName,createdAt"], { cwd, timeoutMs: 30_000 })
    try {
      const pr = JSON.parse(v.out) as { headRefName?: unknown; createdAt?: unknown }
      if (v.ok && pr.headRefName === row.branch && ours(pr.createdAt)) return said
    } catch { /* fall through to the branch listing */ }
  }
  const r = await d().sh("gh", ["pr", "list", "--head", row.branch, "--state", "all", "--json", "url,createdAt", "--limit", "10"], { cwd, timeoutMs: 30_000 })
  if (!r.ok) return null
  try {
    const hit = (JSON.parse(r.out) as { url?: unknown; createdAt?: unknown }[]).find((p) => typeof p.url === "string" && ours(p.createdAt))
    return typeof hit?.url === "string" ? detectPrUrl(hit.url) : null
  } catch {
    return null
  }
}

const openRow = (name: string): TakeoverRow | null => {
  const row = d().store().get(name)
  return row && (row.status === "starting" || row.status === "active") ? row : null
}

/** Stop hook of a `tko-` session: its PR (named in the turn and confirmed by gh, or on the branch) or a `TAKEOVER DONE:` line → completed. */
export async function takeoverStop(name: string, lastMessage: string): Promise<void> {
  const row = openRow(name)
  if (!row) return
  live.seen(name)
  const pr = await branchPr(row, false, lastMessage)
  if (pr) return finish(name, { status: "completed", prUrl: pr }, "done")
  const what = doneLine(lastMessage)
  if (what) return finish(name, { status: "completed", what }, "done")
}

/** SessionEnd / dead pane: one last PR check, else blocked "Takeover ended without a PR…". */
export async function takeoverEnded(name: string): Promise<void> {
  const row = openRow(name)
  if (!row) return tidy(name) // a finished run whose session just ended
  const pr = await branchPr(row, true)
  if (pr) return finish(name, { status: "completed", prUrl: pr }, "done")
  return finish(name, { status: "blocked", blocker: endedBlocker(row.origBlocker) }, "ended")
}

/** One pass over this host's open runs: retry pending finishes, end runs whose session is gone (2 ticks). */
export async function takeoverTick(): Promise<void> {
  // setInterval has no in-flight guard: skip while the previous tick runs, and say so (≤ 1 line / min).
  if (tickStartedAt) {
    if (d().now() - skipLoggedAt >= 60_000) {
      skipLoggedAt = d().now()
      d().log(`[takeover] tick skipped: the previous tick has been running for ${Math.round((d().now() - tickStartedAt) / 1000)} s`)
    }
    return
  }
  tickStartedAt = d().now()
  try {
    const here = d().localHost()
    let rows: TakeoverRow[] = []
    try {
      rows = [...d().store().listOpen(), ...d().store().listCleanup()]
    } catch (err) {
      d().log(`[takeover] tick: run list unreadable (${(err as Error)?.message ?? err})`)
    }
    for (const row of rows) {
      if (row.host !== here || running.has(row.name)) continue
      try {
        await locked(row.name, () => tickRow(row))
      } catch (err) {
        d().log(`[takeover] tick: ${row.name} failed (${(err as Error)?.message ?? err}) — retried next tick`)
      }
    }
  } finally {
    tickStartedAt = 0
  }
}

async function tickRow(row: TakeoverRow): Promise<void> {
  if (!OPEN_STATUSES.includes(row.status)) return tidy(row.name)
  if (uncertain(row)) {
    await reconcileClaim(row)
    return
  }
  if (row.status === "finishing") return flush(row)
  if (!(await live.missing(row.name, row.createdAt))) {
    misses.delete(row.name)
    return
  }
  const n = (misses.get(row.name) ?? 0) + 1
  misses.set(row.name, n)
  if (n >= 2) {
    misses.delete(row.name)
    live.forget(row.name)
    await takeoverEnded(row.name)
  }
}

/** Boot: the tick only (herdr sessions survive a Companion restart; nothing is failed at boot). */
export function startTakeoverTick(): () => void {
  const tick = setInterval(() => void takeoverTick().catch((err) => d().log(`[takeover] tick failed: ${(err as Error)?.message ?? err}`)), TICK_MS)
  ;(tick as unknown as { unref?: () => void }).unref?.()
  return () => clearInterval(tick)
}

/** The `orchestrator_task` frame's session for a running takeover on this host (wiring/dispatch.ts liveIdentity). */
export function takeoverIdentity(dispatchTaskId: string): LiveIdentity | null {
  const row = d().store().openFor(dispatchTaskId)
  if (!row) return null
  const session = d().sessions().find((s) => s.taskId === row.name)
  return { localTaskId: row.name, tmuxSession: null, tmuxSocket: null, sessionKey: session?.key ?? null, logTail: null }
}
