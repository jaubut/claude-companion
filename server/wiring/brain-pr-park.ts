import type { ExecFn } from "../lib/turso"

// The shepherd's client-origin / sensitive-path human-review parks are retired, except tainted or human-merge parks.
// Every other park (conflict unresolved, fix budget spent, infra hold, no CI…) means the work is broken: refuse.
// C-017's tainted parks and `human merge` hard stops survive whatever prefix clientPark puts on them.
const RETIRED_PARK = /^(client(-origin)? PR|touches .+ — needs your review)/
export const hardStopPark = (why: string): boolean => /tainted \(|human merge/i.test(why)
export const retiredPark = (why: string): boolean => RETIRED_PARK.test(why) && !hardStopPark(why)

/** Why this PR is parked as broken or held (empty = mergeable). Notes DB errors propagate. */
export async function parked(
  exec: ExecFn,
  v: { url: string; labels: Array<{ name?: string }> },
  humanApproved = false,
  cardApproved = false,
): Promise<{ reasons: string[]; taskIds: string[]; clientOrigin: boolean }> {
  const reasons: string[] = []
  // Tasks linked by the PR url (a branch-name match is guessable) and the newest shepherd park / hold / unpark
  // rows for this PR or its linked tasks, queried in parallel so cold-start GCP tls-sqld latency doesn't double up.
  const [{ rows }, last] = await Promise.all([
    exec("SELECT id, origin FROM tasks WHERE dispatch_pr_url = ?", [v.url]),
    exec(
      "SELECT action, meta FROM agent_activity WHERE action IN ('pr:needs-human', 'pr:hold', 'pr:unpark') AND (target_id = ? OR target_id IN (SELECT CAST(id AS TEXT) FROM tasks WHERE dispatch_pr_url = ?)) ORDER BY id DESC LIMIT 20",
      [v.url, v.url],
    ),
  ])
  const taskIds = rows.map((r) => String(r.id))
  // The PR read doesn't carry origin: tasks.origin is the authority, the label is advisory (forgeable, so it can only tighten).
  const clientOrigin = rows.some((r) => r.origin === "client") || v.labels.some((l) => l.name === "client-origin")
  for (const row of last.rows) {
    let meta: Record<string, unknown> = {}
    try { meta = JSON.parse(String(row.meta ?? "{}")) as Record<string, unknown> } catch { /* unreadable → counts */ }
    if (meta.url !== undefined && meta.url !== v.url) continue
    const why = typeof meta.reason === "string" ? meta.reason : ""
    const taintedHumanMerge = /tainted \(/i.test(why) && /human merge/i.test(why)
    const liftedByHuman = row.action === "pr:needs-human" && why.length > 0 && (
      cardApproved
        ? !taintedHumanMerge
        : humanApproved && !/human merge/i.test(why)
    )
    if (row.action === "pr:hold" || (row.action === "pr:needs-human" && !retiredPark(why) && !liftedByHuman)) {
      reasons.push(`${row.action === "pr:hold" ? "held" : "parked"} by the shepherd${why ? `: ${why.slice(0, 120)}` : ""}`)
    }
    break
  }
  return { reasons, taskIds, clientOrigin }
}
