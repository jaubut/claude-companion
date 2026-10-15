import type { LogRow } from "./trip-store"

// `bun cli.ts trip-report`: how the trip classifier is doing, from companion.db
// trip_classify_log. Every classified trip is auto-filed (no confidence gate),
// so the measure is Jeremie's flips (quarterly review, phone) by confidence
// band: a band that gets flipped often is a band the review must look at. Pure.

export const CONF_BANDS: [number, number][] = [[0, 0.6], [0.6, 0.85], [0.85, 1.01]]

export interface BandFlips { min: number; max: number; answered: number; flipped: number }

export interface TripReport {
  classified: number
  byMode: Record<string, number>
  unclassified: number
  byRule: Record<string, number>
  answered: number
  bands: BandFlips[]
  overrides: { tripKey: string; confidence: number; was: string; now: string }[]
}

export function buildTripReport(rows: LogRow[]): TripReport {
  const rep: TripReport = {
    classified: 0, byMode: {}, unclassified: 0, byRule: {}, answered: 0,
    bands: CONF_BANDS.map(([min, max]) => ({ min, max, answered: 0, flipped: 0 })), overrides: [],
  }
  for (const r of rows) {
    if (r.mode === "upload" || r.mode === "backfill") {
      if (r.classification === "unclassified") rep.unclassified++
      else rep.classified++
      rep.byMode[r.mode] = (rep.byMode[r.mode] ?? 0) + 1
      const key = r.rule ?? r.classifiedBy
      rep.byRule[key] = (rep.byRule[key] ?? 0) + 1
    }
    if (r.humanAt === null || !r.humanClassification) continue
    rep.answered++
    if (r.classification === "unclassified") continue
    const band = rep.bands.find((b) => r.confidence >= b.min && r.confidence < b.max)
    if (!band) continue
    band.answered++
    if (r.classification !== r.humanClassification) {
      band.flipped++
      rep.overrides.push({ tripKey: r.tripId ?? r.tripKey, confidence: r.confidence, was: r.classification, now: r.humanClassification })
    }
  }
  return rep
}

const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)} %` : "n/a")
const bandLabel = (b: BandFlips): string => `${Math.round(b.min * 100)}–${Math.min(100, Math.round(b.max * 100))} %`

export function formatTripReport(r: TripReport, days: number): string {
  const lines = [
    `Trip classifier — last ${days} days (auto-filed, human flips by confidence band)`,
    `  classified: ${r.classified} (${Object.entries(r.byMode).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}) · unclassified ${r.unclassified}`,
    `  by path: ${Object.entries(r.byRule).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`,
    `  human answers: ${r.answered}`,
    ...r.bands.map((b) => `  confidence ${bandLabel(b)}: flipped ${b.flipped} of ${b.answered} answered (${pct(b.flipped, b.answered)})`),
  ]
  if (r.overrides.length) {
    lines.push("  flips:")
    for (const o of r.overrides.slice(-15)) lines.push(`    ${o.tripKey} (${Math.round(o.confidence * 100)} %): ${o.was} → ${o.now}`)
  }
  return lines.join("\n")
}
