import { type DispatchColumns, type DispatchTask, parseTs } from "./dispatch-tasks"
import { type InvestigationStore, MAX_ATTEMPTS } from "./body-investigate"
import type { Task } from "./orchestrator-chat"
import { type SourceItem, clip } from "./triage"
import type { QueryFn, Row, SqlArg } from "./turso"

// Triage collectors: one function per source, each pure over what it is given
// (the poller's task snapshot, local proposals, the PR rows, the investigation
// store). docs/orchestrator-triage-api.md#sources.

export const PR_SAFETY_NET_MS = 48 * 60 * 60_000
export const BODY_WINDOW_MS = 7 * 24 * 60 * 60_000
export const NEEDS_HUMAN = "pr:needs-human"

// A failure no retry can fix: these stay out of triage (Jeremie sees them in the task list).
const NOT_RETRYABLE = /\b(unknown agent|unknown_agent|no such (note|project|repo)|not found|invalid|forbidden|permission denied|refused)\b/i

/** Version of a task row: any status or updated_at move makes a new item version. */
export const taskVersion = (t: Pick<DispatchTask, "status" | "updatedAtRaw">): string => `${t.status ?? "none"}|${t.updatedAtRaw}`

/** Does this dispatch task need Jeremie (blocked, or failed with a retryable cause)? */
export function taskNeedsHuman(t: DispatchTask): boolean {
  if (t.done) return false
  if (t.status === "blocked") return true
  return t.status === "failed" && !NOT_RETRYABLE.test(t.blocker ?? "")
}

export function taskSource(t: DispatchTask, channel: string | null): SourceItem | null {
  if (!taskNeedsHuman(t)) return null
  const status = t.status as "blocked" | "failed"
  return {
    source: "task", refId: t.id, version: taskVersion(t), title: t.title, project: t.projectTitle,
    createdAt: t.updatedAt || t.createdAt, updatedAt: t.updatedAt || t.createdAt,
    facts: { status, agent: t.agent ?? "agent", blocker: t.blocker ?? "" },
    url: null, ref: { source: "task", taskId: t.id, status, channel },
  }
}

export function taskSources(tasks: DispatchTask[], channelOf: (t: DispatchTask) => string | null): SourceItem[] {
  return tasks.map((t) => taskSource(t, channelOf(t))).filter((s): s is SourceItem => !!s)
}

export interface ProposalInfo { channelName: string | null; project: string | null; macFix: boolean }

export function proposalSource(t: Task, info: ProposalInfo): SourceItem | null {
  if (t.status !== "proposed") return null
  const title = (t.title?.trim() || t.prompt.split("\n").find((l) => l.trim()) || t.prompt).trim()
  return {
    source: "proposal", refId: t.taskId, version: String(t.updatedAt), title: clip(title, 120), project: info.project,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
    facts: { channel: info.channelName ?? t.threadId, reasoning: t.reasoning ?? "", prompt: t.prompt, ...(info.macFix ? { host: "runs live on the Mac" } : {}) },
    url: null, ref: { source: "proposal", taskId: t.taskId, macFix: info.macFix },
  }
}

// ── PRs ──────────────────────────────────────────────────────────────────────

export interface PrRef { owner: string; repo: string; number: number; url: string }

export function parsePrUrl(url: string | null | undefined): PrRef | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\/?$/.exec(url?.trim() ?? "")
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` } : null
}

export interface PrRows { tasks: Row[]; activity: Row[] }

/** Open dispatch PRs (done=0) and their pr:* / outcome:* ledger rows. Column list from a fixed vocabulary only. */
export async function queryPrRows(query: QueryFn, cols: DispatchColumns): Promise<PrRows> {
  const prCol = cols.prUrl ? "t.dispatch_pr_url" : "NULL"
  const prFilter = cols.prUrl ? "t.dispatch_pr_url LIKE 'https://github.com/%' OR " : ""
  const tasks = await query(
    `SELECT t.id, t.text, t.created_at, t.updated_at, t.dispatch_status, t.dispatch_blocker, ${prCol} AS dispatch_pr_url, n.title AS note_title ` +
      "FROM tasks t LEFT JOIN notes n ON n.id = t.note_id " +
      "WHERE t.done = 0 AND t.assignee LIKE 'agent:%' AND t.dispatch_status IN ('pr', 'completed') " +
      `AND (${prFilter}t.id IN (SELECT target_id FROM agent_activity WHERE target_kind = 'task' AND action = ?)) LIMIT 200`,
    [NEEDS_HUMAN],
  )
  if (!tasks.length) return { tasks, activity: [] }
  const ids: SqlArg[] = tasks.map((r) => String(r.id))
  const activity = await query(
    "SELECT id, target_id, action, meta, ts FROM agent_activity WHERE target_kind = 'task' " +
      `AND (action LIKE 'pr:%' OR action IN ('outcome:merged', 'outcome:rejected')) AND target_id IN (${ids.map(() => "?").join(", ")}) ` +
      "ORDER BY id DESC LIMIT 2000",
    ids,
  )
  return { tasks, activity }
}

function meta(r: Row | undefined): Record<string, unknown> {
  try {
    const m = JSON.parse(String(r?.meta ?? "{}")) as unknown
    return m && typeof m === "object" && !Array.isArray(m) ? m as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "")

/**
 * A PR needs Jeremie when its newest pr:* row is the shepherd's `pr:needs-human`
 * (and no outcome row came after it), or — safety net — when it has no pr:* row
 * at all and has been open more than 48 h.
 */
export function prSources(rows: PrRows, now: number): SourceItem[] {
  const byTask = new Map<string, Row[]>()
  for (const a of rows.activity) {
    const list = byTask.get(String(a.target_id)) ?? []
    list.push(a)
    byTask.set(String(a.target_id), list)
  }
  const out: SourceItem[] = []
  for (const t of rows.tasks) {
    const id = String(t.id)
    const acts = (byTask.get(id) ?? []).sort((a, b) => Number(b.id) - Number(a.id))
    const lastPr = acts.find((a) => s(a.action).startsWith("pr:"))
    const outcome = acts.find((a) => s(a.action).startsWith("outcome:"))
    if (outcome && (!lastPr || Number(outcome.id) > Number(lastPr.id))) continue
    const updatedAt = parseTs(t.updated_at)
    const parked = lastPr?.action === NEEDS_HUMAN
    const safetyNet = !lastPr && updatedAt > 0 && now - updatedAt > PR_SAFETY_NET_MS
    if (!parked && !safetyNet) continue
    const m = parked ? meta(lastPr) : {}
    const pr = parsePrUrl(s(m.url)) ?? parsePrUrl(s(t.dispatch_pr_url))
    if (!pr) continue
    const since = parked ? parseTs(lastPr!.ts) || updatedAt : updatedAt
    out.push({
      source: "pr", refId: `${pr.owner}/${pr.repo}#${pr.number}`, version: `${s(t.updated_at)}|${lastPr ? s(lastPr.id) : "none"}`,
      title: clip(s(t.text) || `PR #${pr.number}`, 120), project: s(t.note_title) || pr.repo,
      createdAt: since, updatedAt: Math.max(updatedAt, since),
      facts: {
        reason: parked ? s(m.reason) || "The PR shepherd could not finish this PR alone." : "Open for more than 2 days with no review activity.",
        review: s(t.dispatch_blocker), repo: `${pr.owner}/${pr.repo}`,
      },
      url: pr.url, hints: { safetyNet },
      ref: { source: "pr", taskId: id, prUrl: pr.url, repo: `${pr.owner}/${pr.repo}`, number: pr.number },
    })
  }
  return out
}

// ── Body ─────────────────────────────────────────────────────────────────────

export const bodyComponentUrl = (componentId: string): string => `companion://body/${encodeURIComponent(componentId)}`

export interface BodyLookup {
  /** false = the component is healthy again (drop it); null = unknown (keep). */
  isProblem: (componentId: string) => boolean | null
  criticality: (componentId: string) => string | null
}

/** Components whose latest investigation failed twice in a row with no proposal and nothing open. */
export function bodySources(store: InvestigationStore, now: number, lookup: BodyLookup): SourceItem[] {
  const seen = new Set<string>()
  const out: SourceItem[] = []
  for (const r of store.listRecent(now - BODY_WINDOW_MS, 200)) {
    if (seen.has(r.componentId)) continue
    seen.add(r.componentId)
    const latest = store.latest(r.componentId)
    if (!latest || latest.status !== "failed" || latest.proposalId || store.open(r.componentId)) continue
    if (store.consecutiveFailures(r.componentId, latest.state) < MAX_ATTEMPTS) continue
    if (lookup.isProblem(r.componentId) === false) continue
    const at = latest.finishedAt ?? latest.createdAt
    out.push({
      source: "body", refId: r.componentId, version: latest.id, title: `${r.componentId} is ${latest.state}`, project: "Body",
      createdAt: at, updatedAt: at,
      facts: {
        problem: `${r.componentId} is ${latest.state} and its automatic diagnosis failed ${MAX_ATTEMPTS} times.`,
        error: latest.error ?? "", host: latest.host,
      },
      url: bodyComponentUrl(r.componentId), hints: { criticality: lookup.criticality(r.componentId) },
      ref: { source: "body", componentId: r.componentId, investigationId: latest.id },
    })
  }
  return out
}
