import { existsSync } from "node:fs"
import type { ExecOutcome } from "./triage-engine"
import type { ExecFn } from "./turso"

// Triage merge / close on a dispatch PR, by its FULL URL (numbers collide across
// repos — dispatch-reconcile.ts). The state is read back from GitHub before
// anything is recorded: merge must read MERGED, close must read CLOSED. Then the
// same ledger rows dispatch-reconcile writes: merged → task done=1 +
// outcome:merged; closed → outcome:rejected "PR #N closed unmerged".

export interface GhResult { code: number; stdout: string; stderr: string }
/** Runs `gh <args>`; throws when gh cannot be started at all. */
export type GhFn = (args: string[]) => Promise<GhResult>

export class GhUnreachable extends Error {
  constructor(reason: string) {
    super(`gh unreachable: ${reason}`)
    this.name = "GhUnreachable"
  }
}

export interface PrTarget { taskId: string; prUrl: string; number: number }
export interface PrActionDeps { gh: GhFn; exec: ExecFn; host: string }

export type PrState = "OPEN" | "MERGED" | "CLOSED" | "unknown"

export async function prState(gh: GhFn, url: string): Promise<PrState> {
  const r = await gh(["pr", "view", url, "--json", "state"])
  if (r.code !== 0) return "unknown"
  try {
    const s = (JSON.parse(r.stdout) as { state?: string }).state
    return s === "OPEN" || s === "MERGED" || s === "CLOSED" ? s : "unknown"
  } catch {
    return "unknown"
  }
}

const unreachable = (detail: string): ExecOutcome => ({ kind: "error", status: 503, error: "gh_unreachable", extra: { detail: detail.slice(0, 200) } })

async function agentOf(exec: ExecFn, taskId: string): Promise<string> {
  const { rows } = await exec("SELECT assignee FROM tasks WHERE id = ?", [taskId])
  return String(rows[0]?.assignee ?? "").replace(/^(agent:)+/, "") || "unknown"
}

async function ledger(deps: PrActionDeps, t: PrTarget, action: string, summary: string): Promise<void> {
  const meta = JSON.stringify({ source: "companion", via: "triage", host: deps.host, pr_url: t.prUrl })
  await deps.exec(
    "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, 'task', ?, ?, ?)",
    [await agentOf(deps.exec, t.taskId), action, t.taskId, summary, meta],
  )
}

async function act(deps: PrActionDeps, t: PrTarget, verb: "merge" | "close", want: PrState): Promise<ExecOutcome> {
  let before: PrState
  try {
    before = await prState(deps.gh, t.prUrl)
  } catch (err) {
    return unreachable((err as Error)?.message ?? "gh failed")
  }
  if (before === "unknown") return unreachable("gh pr view failed")
  if (before !== "OPEN") return { kind: "stale", reason: `PR is ${before.toLowerCase()}` }
  const run = await deps.gh(verb === "merge" ? ["pr", "merge", t.prUrl, "--squash"] : ["pr", "close", t.prUrl])
  const after = await prState(deps.gh, t.prUrl)
  if (after !== want) {
    const detail = (run.stderr || run.stdout).trim().slice(0, 200)
    return { kind: "error", status: 502, error: `${verb}_unverified`, extra: { state: after, detail } }
  }
  return { kind: "done", detail: { state: after } }
}

/** gh pr merge --squash, verified MERGED, then the task is done (guarded) and outcome:merged recorded. */
export async function mergePr(deps: PrActionDeps, t: PrTarget): Promise<ExecOutcome> {
  const out = await act(deps, t, "merge", "MERGED")
  if (out.kind !== "done") return out
  await deps.exec(
    "UPDATE tasks SET done = 1, updated_at = datetime('now') WHERE id = ? AND done = 0 AND dispatch_status IN ('completed', 'pr')",
    [t.taskId],
  )
  await ledger(deps, t, "outcome:merged", `PR #${t.number} merged`)
  return out
}

/** gh pr close, verified CLOSED, then outcome:rejected (dispatch-reconcile's wording, so it never logs it twice). */
export async function closePr(deps: PrActionDeps, t: PrTarget): Promise<ExecOutcome> {
  const out = await act(deps, t, "close", "CLOSED")
  if (out.kind !== "done") return out
  await ledger(deps, t, "outcome:rejected", `PR #${t.number} closed unmerged`)
  return out
}

function ghBin(): string {
  return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"].find((p) => existsSync(p)) ?? "gh"
}

export const GH_TIMEOUT_MS = 60_000

/** The real `gh` (absolute path: the launchd PATH is minimal). Throws GhUnreachable when it cannot start. */
export const realGh: GhFn = async (args) => {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([ghBin(), ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GH_PROMPT_DISABLED: "1" } })
  } catch (err) {
    throw new GhUnreachable((err as Error)?.message ?? "spawn failed")
  }
  const timer = setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, GH_TIMEOUT_MS)
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()])
    return { code: await proc.exited, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}
