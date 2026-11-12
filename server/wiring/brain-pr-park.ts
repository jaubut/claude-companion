import type { ExecFn } from "../lib/turso"

// The shepherd's client-origin / sensitive-path human-review parks are retired, except tainted or human-merge parks.
// Every other park (conflict unresolved, fix budget spent, infra hold, no CI…) means the work is broken: refuse.
// C-017's tainted parks and `human merge` hard stops survive whatever prefix clientPark puts on them.
const RETIRED_PARK = /^(client(-origin)? PR|touches .+ — needs your review)/
export const hardStopPark = (why: string): boolean => /tainted \(|human merge/i.test(why)
export const retiredPark = (why: string): boolean => RETIRED_PARK.test(why) && !hardStopPark(why)

/** Why this PR is parked as broken or held (empty = mergeable). Turso errors propagate. */
export async function parked(exec: ExecFn, v: { url: string; labels: Array<{ name?: string }> }, humanApproved = false): Promise<{ reasons: string[]; taskIds: string[]; clientOrigin: boolean }> {
  const reasons: string[] = []
  // Tasks linked by the PR url (a branch-name match is guessable): park rows and the digest row key on them.
  const { rows } = await exec("SELECT id, origin FROM tasks WHERE dispatch_pr_url = ?", [v.url])
  const taskIds = rows.map((r) => String(r.id))
  // The PR read doesn't carry origin: tasks.origin is the authority, the label is advisory (forgeable, so it can only tighten).
  const clientOrigin = rows.some((r) => r.origin === "client") || v.labels.some((l) => l.name === "client-origin")
  // The newest shepherd park / hold / unpark for this PR: a live one refuses unless it is a retired human-review park
  // or Jeremie explicitly ordered the merge in the Brain thread (never lifting pr:hold or tainted/human-merge hard stops).
  const last = await exec(
    "SELECT action, meta FROM agent_activity WHERE action IN ('pr:needs-human', 'pr:hold', 'pr:unpark') AND target_id IN (" + [v.url, ...taskIds].map(() => "?").join(", ") + ") ORDER BY id DESC LIMIT 20",
    [v.url, ...taskIds],
  )
  for (const row of last.rows) {
    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(String(row.meta ?? "{}")) as Record<string, unknown> } catch { /* unreadable → counts */ }
    if (meta.url !== undefined && meta.url !== v.url) continue
    const why = typeof meta.reason === "string" ? meta.reason : ""
    const liftedByHuman = humanApproved && row.action === "pr:needs-human" && why.length > 0 && !/human merge/i.test(why)
    if (row.action === "pr:hold" || (row.action === "pr:needs-human" && !retiredPark(why) && !liftedByHuman)) {
      reasons.push(`${row.action === "pr:hold" ? "held" : "parked"} by the shepherd${why ? `: ${why.slice(0, 120)}` : ""}`)
    }
    break
  }
  return { reasons, taskIds, clientOrigin }
}
