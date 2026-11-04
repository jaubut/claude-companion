import { BRAIN_AGENT, BRAIN_THREAD } from "../lib/brain"
import { shepherdOf } from "../lib/dispatch-stage"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { redactSecrets } from "../lib/secret-redact"
import { type GhFn, realGh } from "../lib/triage-pr"
import { NEEDS_HUMAN } from "../lib/triage-sources"
import { type ExecFn, TursoUnreachable } from "../lib/turso"
import { REASON_MAX } from "./brain-pr-close"
import { HOLD_LABEL } from "./brain-pr-merge"
import { dispatchWiring } from "./dispatch"
import { orchEmit } from "./orchestrator"

// bin/pr-unpark (POST /hooks/brain/pr-unpark): the brain hands a PR the shepherd
// parked back to it, with guidance for the next fix run. Checked here, from
// GitHub and Turso, in order:
//   open · head `dispatch/*` (403 not_agent_branch)
//   not_parked (409): no park newer than every pr:unpark and every live
//     pr:approved-merge for the PR url (an expired approval lifts nothing)
//   label_park (409): a do-not-merge/wip label on the PR or in the park reason
//     (only Jeremie lifts those)
//   unpark_cap (429): the brain already unparked this PR UNPARK_CAP times
//   ledger_changed (409): a park, unpark or approval landed during the call
// The row is the contract claude-config tools/pr-shepherd*.ts reads: action
// `pr:unpark`, meta {url, reason, guidance, source: "brain"}; no `by` and no
// `category`, so the shepherd treats it as a hand unpark (fix budget resets).

export const UNPARK_ACTION = "pr:unpark"
export const UNPARK_SOURCE = "brain"
export const UNPARK_CAP = 2
export const GUIDANCE_MAX = 2_000

interface PrUnparkInput { repo: string; pr: number; reason: string; guidance: string }
interface PrUnparkDeps { gh: GhFn; exec: ExecFn; event(text: string): void }
type Out = { status: number; body: Record<string, unknown> }

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { ok: false, error, ...extra } })

interface PrView { state: string; headRefName: string; headRefOid: string; url: string; title: string; labels: Array<{ name?: string }> }

async function view(gh: GhFn, p: PrUnparkInput): Promise<PrView | Out> {
  let r: Awaited<ReturnType<GhFn>>
  try {
    r = await gh(["pr", "view", String(p.pr), "--repo", p.repo, "--json", "state,headRefName,headRefOid,url,title,labels"])
  } catch (err) {
    return fail(503, "gh_unreachable", { detail: String((err as Error)?.message ?? "").slice(0, 200) })
  }
  if (r.code !== 0) return fail(404, "pr_not_found", { detail: r.stderr.trim().slice(0, 200) })
  try {
    const v = JSON.parse(r.stdout) as Partial<PrView>
    return {
      state: String(v.state ?? ""), headRefName: String(v.headRefName ?? ""), headRefOid: String(v.headRefOid ?? ""),
      url: String(v.url ?? ""), title: String(v.title ?? ""), labels: Array.isArray(v.labels) ? v.labels : [],
    }
  } catch {
    return fail(502, "gh_bad_json")
  }
}

interface Ledger { park: { id: number; reason: string } | null; headId: number; brainUnparks: number; taskId: string | null }

const LEDGER_ROWS = "action IN ('pr:needs-human', 'pr:unpark', 'pr:approved-merge') AND json_extract(meta, '$.url') = ?"
const BRAIN_UNPARKS = "SELECT COUNT(*) AS n FROM agent_activity WHERE action = ? AND json_extract(meta, '$.url') = ? AND json_extract(meta, '$.source') = ?"

/** The PR's live park, the newest ledger id, the brain's past unparks and its task, all keyed on the PR url. Turso errors propagate. */
async function ledger(exec: ExecFn, url: string): Promise<Ledger> {
  const { rows } = await exec(`SELECT id, action, meta, ts FROM agent_activity WHERE ${LEDGER_ROWS} ORDER BY id DESC`, [url])
  let park: Ledger["park"] = null
  // shepherdOf holds the shared rule: an expired approval lifts nothing.
  const row = shepherdOf(rows, Date.now()).parked ? rows.find((r) => r.action === NEEDS_HUMAN) : undefined
  if (row) {
    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(String(row.meta ?? "{}")) as Record<string, unknown> } catch { /* unreadable → no reason */ }
    park = { id: Number(row.id), reason: typeof meta.reason === "string" ? meta.reason : "" }
  }
  const c = await exec(BRAIN_UNPARKS, [UNPARK_ACTION, url, UNPARK_SOURCE])
  const t = await exec("SELECT id FROM tasks WHERE dispatch_pr_url = ? LIMIT 1", [url])
  return { park, headId: Number(rows[0]?.id ?? 0), brainUnparks: Number(c.rows[0]?.n ?? NaN), taskId: t.rows[0] ? String(t.rows[0].id) : null }
}

export async function unparkAgentPr(p: PrUnparkInput, deps: PrUnparkDeps = realDeps): Promise<Out> {
  const v = await view(deps.gh, p)
  if ("status" in v) return v
  if (v.state !== "OPEN") return fail(409, "not_open", { state: v.state })
  if (!/^dispatch\/[\w.-]+$/.test(v.headRefName)) return fail(403, "not_agent_branch", { branch: v.headRefName })
  let l: Ledger
  try {
    l = await ledger(deps.exec, v.url)
  } catch (err) {
    companionLog(`[brain] pr-unpark: turso ${err instanceof TursoUnreachable ? err.message : (err as Error)?.name ?? "error"}`)
    return fail(503, "turso_unreachable")
  }
  if (!l.park) return fail(409, "not_parked")
  const labels = v.labels.map((x) => String(x.name ?? "")).filter((x) => HOLD_LABEL.test(x))
  if (labels.length || HOLD_LABEL.test(l.park.reason)) return fail(409, "label_park", { labels, park: l.park.reason.slice(0, 200) })
  if (!(l.brainUnparks < UNPARK_CAP)) return fail(429, "unpark_cap", { cap: UNPARK_CAP })
  const reason = redactSecrets(p.reason).slice(0, REASON_MAX)
  const guidance = redactSecrets(p.guidance).slice(0, GUIDANCE_MAX)
  const label = `${p.repo}#${p.pr}`
  try {
    // Atomic: the row lands only if no ledger row arrived since the read and the cap still holds.
    const { affected } = await deps.exec(
      `INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM agent_activity WHERE ${LEDGER_ROWS} AND id > ?)
         AND (${BRAIN_UNPARKS}) < ?`,
      [BRAIN_AGENT, UNPARK_ACTION, l.taskId ? "task" : "pr", l.taskId ?? v.url, `${label} unparked by the brain: ${reason}`.slice(0, 200),
        JSON.stringify({ url: v.url, repo: p.repo, pr: p.pr, reason, guidance, source: UNPARK_SOURCE, head_sha: v.headRefOid, prior_reason: l.park.reason.slice(0, 300), prior_park_id: l.park.id, unpark_no: l.brainUnparks + 1 }),
        v.url, l.headId, UNPARK_ACTION, v.url, UNPARK_SOURCE, UNPARK_CAP],
    )
    if (affected === 0) return fail(409, "ledger_changed")
  } catch (err) {
    companionLog(`[brain] pr-unpark: activity row failed (${(err as Error)?.name ?? "error"})`)
    return fail(503, "turso_unreachable")
  }
  deps.event(`Brain unparked ${label} (${v.title.slice(0, 80)}), ${l.brainUnparks + 1}/${UNPARK_CAP}: ${reason}\nGuidance: ${guidance.slice(0, 300)}`)
  companionLog(`[brain] pr-unpark ${label} (${l.brainUnparks + 1}/${UNPARK_CAP})`)
  return { status: 200, body: { ok: true, unparked: true, url: v.url, unparks: l.brainUnparks + 1, cap: UNPARK_CAP } }
}

const realDeps: PrUnparkDeps = {
  gh: realGh,
  exec: (sql, args) => dispatchWiring.exec(sql, args),
  event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
}
