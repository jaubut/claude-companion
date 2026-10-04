import type { LogRow } from "./trip-store"

// `bun cli.ts trip-report`: how the trip classifier is doing, from companion.db
// trip_classify_log. Auto-file rate over uploads; human overrides of filed
// trips (the errors that matter: they were filed without asking); agreement
// of the review guesses with Jeremie's answers. Pure.

export interface TripReport {
  uploads: number
  filed: number
  review: number
  byRule: Record<string, number>
  answered: number
  filedAnswered: number
  filedOverridden: number
  guessAnswered: number
  guessClassAgree: number
  guessFullAgree: number
  overrides: { tripKey: string; was: string; now: string }[]
}

const label = (cls: string, slug: string | null): string => (cls === "business" && slug ? `business/${slug}` : cls)
const same = (r: LogRow, client: boolean): boolean =>
  r.classification === r.humanClassification && (!client || r.classification !== "business" || (r.clientSlug ?? null) === (r.humanClientSlug ?? null))

export function buildTripReport(rows: LogRow[]): TripReport {
  const rep: TripReport = { uploads: 0, filed: 0, review: 0, byRule: {}, answered: 0, filedAnswered: 0, filedOverridden: 0, guessAnswered: 0, guessClassAgree: 0, guessFullAgree: 0, overrides: [] }
  for (const r of rows) {
    if (r.mode === "upload") {
      rep.uploads++
      if (r.decision === "filed") rep.filed++
      else rep.review++
      const key = r.rule ?? r.classifiedBy
      rep.byRule[key] = (rep.byRule[key] ?? 0) + 1
    }
    if (r.humanAt === null || !r.humanClassification) continue
    rep.answered++
    if (r.decision === "filed") {
      rep.filedAnswered++
      if (!same(r, true)) {
        rep.filedOverridden++
        rep.overrides.push({ tripKey: r.tripId ?? r.tripKey, was: label(r.classification, r.clientSlug), now: label(r.humanClassification, r.humanClientSlug) })
      }
    } else if (r.classification !== "unclassified") {
      rep.guessAnswered++
      if (same(r, false)) rep.guessClassAgree++
      if (same(r, true)) rep.guessFullAgree++
    }
  }
  return rep
}

const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)} %` : "n/a")

export function formatTripReport(r: TripReport, days: number, threshold: number): string {
  const lines = [
    `Trip classifier — last ${days} days (auto-file at ≥ ${threshold})`,
    `  uploads classified: ${r.uploads} · filed ${r.filed} · to review ${r.review} · auto-file rate ${pct(r.filed, r.uploads)}`,
    `  by path: ${Object.entries(r.byRule).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`,
    `  human answers: ${r.answered}`,
    `  filed then corrected by Jeremie: ${r.filedOverridden} of ${r.filedAnswered} answered (${pct(r.filedAnswered - r.filedOverridden, r.filedAnswered)} kept)`,
    `  review guesses vs Jeremie: class ${pct(r.guessClassAgree, r.guessAnswered)}, class+client ${pct(r.guessFullAgree, r.guessAnswered)} (${r.guessAnswered} answered)`,
  ]
  if (r.overrides.length) {
    lines.push("  overrides:")
    for (const o of r.overrides.slice(-15)) lines.push(`    ${o.tripKey}: ${o.was} → ${o.now}`)
  }
  return lines.join("\n")
}
