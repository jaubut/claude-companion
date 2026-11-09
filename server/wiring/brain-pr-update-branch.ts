import { BRAIN_AGENT, BRAIN_THREAD } from "../lib/brain"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { redactSecrets } from "../lib/secret-redact"
import { type GhFn, realGh } from "../lib/triage-pr"
import type { ExecFn } from "../lib/turso"
import { REASON_MAX } from "./brain-pr-close"
import { parked } from "./brain-pr-park"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

// bin/pr-update-branch (POST /hooks/brain/pr-update-branch): the brain refreshes
// a stale agent PR, because dispatch workers cannot create merge commits. Every
// check is made here from GitHub and Turso, never from the brain's word:
//   open (409 not_open) · head `dispatch/*` (403 not_agent_branch) ·
//   no client origin (403 client_origin), live shepherd park or hold (403 parked) ·
//   Turso must answer (503 turso_unreachable) ·
//   no conflict with the base (409 conflict, before or from the update).
// A failed update answers 502 update_failed, whatever the head does after.
// `gh pr update-branch` without --rebase: a merge commit on the PR branch, never
// a rebase, never a force. The new head is read back. It voids the reviewed-sha
// stamps, so bin/pr-merge answers not_approved until the cascade reviews it again.

export const PR_UPDATE_ACTION = "brain:pr-update-branch"
/** The new head can land just after gh returns: read it back this many times, a second apart. */
const READBACK_TRIES = 5
const READBACK_MS = 1_000

interface PrUpdateInput { repo: string; pr: number; reason: string }
interface PrUpdateDeps { gh: GhFn; exec: ExecFn; event(text: string): void; sleep(ms: number): Promise<unknown> }
interface Out { status: number; body: Record<string, unknown> }
interface PrView { state: string; headRefName: string; headRefOid: string; mergeable: string; url: string; title: string; labels: Array<{ name?: string }> }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { ok: false, error, ...extra } })

async function view(gh: GhFn, p: PrUpdateInput): Promise<PrView | Out> {
  let r: Awaited<ReturnType<GhFn>>
  try {
    r = await gh(["pr", "view", String(p.pr), "--repo", p.repo, "--json", "state,headRefName,headRefOid,mergeable,url,title,labels"])
  } catch (err) {
    return fail(503, "gh_unreachable", { detail: String((err as Error)?.message ?? "").slice(0, 200) })
  }
  if (r.code !== 0) return fail(404, "pr_not_found", { detail: r.stderr.trim().slice(0, 200) })
  try {
    const v = JSON.parse(r.stdout) as Partial<PrView>
    return {
      state: String(v.state ?? ""), headRefName: String(v.headRefName ?? ""), headRefOid: String(v.headRefOid ?? ""),
      mergeable: String(v.mergeable ?? ""), url: String(v.url ?? ""), title: String(v.title ?? ""),
      labels: Array.isArray(v.labels) ? v.labels : [],
    }
  } catch {
    return fail(502, "gh_bad_json")
  }
}

/** The head once it differs from `before`, null if it never does. */
async function newHead(deps: PrUpdateDeps, p: PrUpdateInput, before: string): Promise<string | null> {
  for (let i = 0; i < READBACK_TRIES; i++) {
    if (i) await deps.sleep(READBACK_MS)
    const v = await view(deps.gh, p)
    if (!("status" in v) && v.headRefOid && v.headRefOid !== before) return v.headRefOid
  }
  return null
}

export async function updateAgentPr(p: PrUpdateInput, deps: PrUpdateDeps = realDeps): Promise<Out> {
  const v = await view(deps.gh, p)
  if ("status" in v) return v
  if (v.state !== "OPEN") return fail(409, "not_open", { state: v.state })
  if (!/^dispatch\/[\w.-]+$/.test(v.headRefName)) return fail(403, "not_agent_branch", { branch: v.headRefName })
  let park: Awaited<ReturnType<typeof parked>>
  try {
    park = await parked(deps.exec, v)
  } catch (err) {
    companionLog(`[brain] pr-update-branch: turso ${(err as Error)?.name ?? "error"}`)
    return fail(503, "turso_unreachable")
  }
  if (park.clientOrigin) return fail(403, "client_origin")
  if (park.reasons.length) return fail(403, "parked", { reasons: park.reasons })
  if (v.mergeable === "CONFLICTING") return fail(409, "conflict")
  let run: Awaited<ReturnType<GhFn>>
  try {
    run = await deps.gh(["pr", "update-branch", String(p.pr), "--repo", p.repo])
  } catch (err) {
    return fail(503, "gh_unreachable", { detail: String((err as Error)?.message ?? "").slice(0, 200) })
  }
  const said = `${run.stderr}\n${run.stdout}`.trim()
  if (run.code !== 0 && /conflict/i.test(said)) return fail(409, "conflict")
  if (run.code === 0 && /up-to-date/i.test(said)) return fail(409, "up_to_date", { head: v.headRefOid })
  // A failed update stops here: a head that moves now is someone else's push.
  if (run.code !== 0) return fail(502, "update_failed", { head: v.headRefOid, detail: said.slice(0, 200) })
  const head = await newHead(deps, p, v.headRefOid)
  if (!head) return fail(502, "update_unverified", { head: v.headRefOid, detail: said.slice(0, 200) })
  const reason = redactSecrets(p.reason).slice(0, REASON_MAX)
  try {
    await deps.exec(
      "INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES (?, ?, ?, ?, ?, ?)",
      [BRAIN_AGENT, PR_UPDATE_ACTION, "pr", v.url, `${p.repo}#${p.pr} updated by the brain: ${reason}`.slice(0, 200),
        JSON.stringify({ repo: p.repo, pr: p.pr, url: v.url, branch: v.headRefName, from: v.headRefOid, head, reason, source: "companion" })],
    )
  } catch (err) {
    companionLog(`[brain] pr-update-branch: activity row failed (${(err as Error)?.name ?? "error"})`)
  }
  deps.event(`Brain updated ${p.repo}#${p.pr} (${v.title.slice(0, 80)}) to ${head.slice(0, 7)}: ${reason}`)
  companionLog(`[brain] pr-update-branch ${p.repo}#${p.pr} ${v.headRefOid.slice(0, 7)} → ${head.slice(0, 7)}`)
  return { status: 200, body: { ok: true, updated: true, url: v.url, head } }
}

const realDeps: PrUpdateDeps = {
  gh: realGh,
  exec: (sql, args) => dispatchWiring.exec(sql, args),
  event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
  sleep: (ms) => Bun.sleep(ms),
}
