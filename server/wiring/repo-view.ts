import { approveUrl } from "../lib/dispatch-tasks"
import { companionLog } from "../lib/log"
import { createProposal, getTask, setTaskStatus } from "../lib/orchestrator-chat"
import { GENERAL_CHANNEL } from "../lib/orchestrator-db"
import { type RepoPr, PR_LIST_FIELDS, PR_LIST_LIMIT, agentPrompt, agentTaskTitle, isBlocked, parsePrList, repoPrs } from "../lib/repo-view"
import type { TriageItem } from "../lib/triage"
import { type GhFn, realGh } from "../lib/triage-pr"
import { prSources, queryPrRows } from "../lib/triage-sources"
import { type RepoEntry, githubName, isDir, repoEntriesSafe } from "../lib/live-repo"
import { HOST_INFO } from "../state"
import { type DispatchWiring, dispatchWiring } from "./dispatch"
import { fileProposal } from "./orchestrator"
import { PR_ROWS_TTL_MS, triageEngine } from "./triage"

// Repo view (docs/orchestrator-triage-api.md#repo-view):
//   view(repo)  → the repo's open PRs (gh, cached PR_ROWS_TTL_MS) in plain words, its Needs you count, the agent
//   agent(repo) → "Get an agent on it": ONE builder task for the blocked PRs, filed as Jeremie's tap (byHand:
//                 origin jeremie → queued, herdr runner), exactly like wiring/body-agent.ts. Idempotent: an
//                 open task with the same title is returned instead of a second one.
// <repo> must be a REPO_MAP entry with a `github` slug; gh only ever sees that slug, in an argv array.

/** A task in one of these states is "the agent on it": a tap returns it instead of filing again. */
const OPEN_AGENT_STATES = ["pending", "queued", "running", "blocked", "pr"] as const
const AGENT = "builder"

export interface RepoAgent { taskId: string; status: string }

export interface RepoViewBody { ok: true; repo: string; github: string; prs: RepoPr[]; blocked: number; needsYou: number; agent: RepoAgent | null; generatedAt: number }

export type RepoViewOutcome = { status: number; body: Record<string, unknown> }

export interface RepoViewDeps {
  dispatch: DispatchWiring
  gh: GhFn
  entries: () => RepoEntry[]
  /** Needs you right now (the triage engine's items). */
  items: () => Promise<TriageItem[]>
  now: () => number
}

interface KnownRepo { name: string; slug: string; project: string | null; path: string | null }

export interface RepoView {
  view: (repo: string) => Promise<RepoViewOutcome>
  agent: (repo: string) => Promise<RepoViewOutcome>
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): RepoViewOutcome => ({ status, body: { ok: false, error, ...extra } })

export function createRepoView(deps: RepoViewDeps): RepoView {
  const prCache = new Map<string, { at: number; prs: RepoPr[] }>()
  // Repos with an agent filing in flight: a double tap never files two tasks.
  const filing = new Set<string>()

  /** The REPO_MAP entry the card key names (its GitHub name, any case); null = unknown here. */
  function known(repo: string): KnownRepo | null {
    const hits = deps.entries().filter((e) => e.github && githubName(e)?.toLowerCase() === repo.toLowerCase())
    if (!hits.length) return null
    const e = hits[0]!
    return { name: githubName(e)!, slug: e.github!, project: e.project ?? null, path: hits.find((h) => isDir(h.path))?.path ?? null }
  }

  /** The shepherd's park reason per PR number (its Turso ledger); Turso down → no parks, the view still renders. */
  async function parks(slug: string): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    try {
      const rows = await queryPrRows(deps.dispatch.query, await deps.dispatch.columns())
      for (const s of prSources(rows, deps.now())) {
        if (s.ref.source !== "pr" || s.ref.repo.toLowerCase() !== slug.toLowerCase() || s.hints?.parked === undefined) continue
        out.set(s.ref.number, s.hints.parked)
      }
    } catch (e) {
      companionLog(`[repo-view] park rows unavailable (${(e as Error)?.message ?? "error"})`)
    }
    return out
  }

  /** Open PRs in plain words; null = gh could not answer (and nothing cached). */
  async function prsOf(r: KnownRepo, fresh: boolean): Promise<RepoPr[] | null> {
    const hit = prCache.get(r.slug)
    if (!fresh && hit && deps.now() - hit.at < PR_ROWS_TTL_MS) return hit.prs
    let list: ReturnType<typeof parsePrList> = null
    try {
      const out = await deps.gh(["pr", "list", "--repo", r.slug, "--state", "open", "--limit", String(PR_LIST_LIMIT), "--json", PR_LIST_FIELDS])
      list = out.code === 0 ? parsePrList(out.stdout) : null
      if (!list) companionLog(`[repo-view] gh pr list ${r.slug} failed (exit ${out.code}): ${out.stderr.trim().slice(0, 160)}`)
    } catch (e) {
      companionLog(`[repo-view] gh unreachable (${(e as Error)?.message ?? "error"})`)
    }
    if (!list) return hit?.prs ?? null
    const parked = await parks(r.slug)
    const prs = repoPrs(list, (n) => parked.get(n) ?? null)
    prCache.set(r.slug, { at: deps.now(), prs })
    return prs
  }

  /** The open resolve task for this repo (exact title), newest first; throws when Turso is down. */
  async function openAgent(r: KnownRepo): Promise<RepoAgent | null> {
    const rows = await deps.dispatch.query(
      `SELECT id, dispatch_status FROM tasks WHERE text = ? AND done = 0 AND dispatch_status IN (${OPEN_AGENT_STATES.map(() => "?").join(", ")}) ORDER BY created_at DESC LIMIT 1`,
      [agentTaskTitle(r.name), ...OPEN_AGENT_STATES],
    )
    const row = rows[0]
    return row ? { taskId: String(row.id), status: String(row.dispatch_status) } : null
  }

  async function needsYou(r: KnownRepo): Promise<number> {
    const items = await deps.items().catch(() => [] as TriageItem[])
    return items.filter((i) => i.repo?.toLowerCase() === r.name.toLowerCase()).length
  }

  /** The repo's project note id (REPO_MAP `project` is a note id or a ref_code); null = none in Turso. */
  async function noteOf(r: KnownRepo): Promise<string | null> {
    if (!r.project) return null
    const rows = await deps.dispatch.query("SELECT id FROM notes WHERE id = ? OR ref_code = ? LIMIT 1", [r.project, r.project])
    return rows[0] ? String(rows[0].id) : null
  }

  async function view(repo: string): Promise<RepoViewOutcome> {
    const r = known(repo)
    if (!r) return fail(404, "no_such_repo")
    const prs = await prsOf(r, false)
    if (!prs) return fail(503, "gh_unreachable")
    const agent = await openAgent(r).catch((e: unknown) => {
      companionLog(`[repo-view] agent lookup failed (${(e as Error)?.message ?? "error"})`)
      return null
    })
    const body: RepoViewBody = {
      ok: true, repo: r.name, github: r.slug, prs, blocked: prs.filter((p) => isBlocked(p.status)).length,
      needsYou: await needsYou(r), agent, generatedAt: deps.now(),
    }
    return { status: 200, body: { ...body } }
  }

  async function file(r: KnownRepo, blocked: RepoPr[], noteId: string): Promise<RepoViewOutcome> {
    const title = agentTaskTitle(r.name)
    const t = createProposal(agentPrompt(r.slug, blocked), r.path ?? "", `Repo view: resolve ${blocked.length} blocked PR(s) in ${r.name} (tapped "Get an agent on it")`, GENERAL_CHANNEL, {
      noteId, agent: AGENT, title,
    })
    const out = await fileProposal(t.taskId, { noteId, agent: AGENT, byHand: true, runner: "herdr" }, deps.dispatch)
    if (!out.ok) {
      // The tap was the approval: never leave a stray card to approve a second time.
      if (getTask(t.taskId)?.status === "proposed") setTaskStatus(t.taskId, "cancelled")
      return fail(out.status, out.error)
    }
    const status = out.queued ? "queued" : "pending"
    try {
      await deps.dispatch.exec(
        "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
        [AGENT, "repo:agent", "repo", r.slug, `${AGENT} filed to resolve ${blocked.length} blocked PR(s) in ${r.name}`.slice(0, 200),
          JSON.stringify({ source: "companion", host: HOST_INFO.name, dispatchTaskId: out.dispatchTaskId, prs: blocked.map((p) => p.number) })],
      )
    } catch (e) {
      companionLog(`[repo-view] agent_activity insert failed (${(e as Error)?.message ?? "error"})`)
    }
    companionLog(`[repo-view] ${r.name} → ${AGENT} for ${blocked.length} blocked PR(s) as ${out.dispatchTaskId.slice(0, 8)} (${status})`)
    return {
      status: 200,
      body: { ok: true, repo: r.name, result: "filed", agent: { taskId: out.dispatchTaskId, status }, ...(out.queued ? {} : { approveUrl: approveUrl(out.dispatchTaskId) }) },
    }
  }

  async function agent(repo: string): Promise<RepoViewOutcome> {
    const r = known(repo)
    if (!r) return fail(404, "no_such_repo")
    if (filing.has(r.slug)) return fail(409, "already_filing")
    filing.add(r.slug)
    try {
      let open: RepoAgent | null
      let noteId: string | null
      try {
        open = await openAgent(r)
        if (open) return { status: 200, body: { ok: true, repo: r.name, result: "existing", agent: open } }
        noteId = await noteOf(r)
      } catch (e) {
        companionLog(`[repo-view] turso: ${(e as Error)?.message ?? e}`)
        return fail(503, "turso_unreachable")
      }
      // Fresh from GitHub: the brief names exactly what is blocked now.
      const prs = await prsOf(r, true)
      if (!prs) return fail(503, "gh_unreachable")
      const blocked = prs.filter((p) => isBlocked(p.status))
      if (!blocked.length) return fail(409, "nothing_blocked")
      if (!noteId) return fail(422, "no_project")
      return await file(r, blocked, noteId)
    } finally {
      filing.delete(r.slug)
    }
  }

  return { view, agent }
}

let live: RepoView | null = null
/** The wired instance (built on first use). */
export function repoView(): RepoView {
  live ??= createRepoView({
    dispatch: dispatchWiring, gh: realGh, entries: () => repoEntriesSafe(), now: Date.now,
    items: async () => (await triageEngine().list()).items,
  })
  return live
}
