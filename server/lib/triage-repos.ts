import { createHash } from "node:crypto"
import { type ResolvingItem, type SourceItem, type TriageItem, type TriageSource, clip } from "./triage"

// Repo cards (docs/orchestrator-triage-api.md#repo-cards): Needs you as one
// card per repo, a plain overview of what is pending and one Yes / No. Pure
// and derived on every render from the per-item cards (never stored); runs
// (triage_repo_runs, lib/triage-store.ts) only add their state. What Yes does
// per member is decided here (memberDoes), never by the client; Yes acts on
// the client's member snapshot only (yesPlan). The runner is
// wiring/triage-repos.ts.

/** Task / proposal / PR items with no known repo fold into this card ("Other work"). */
export const REPO_OTHER = "_other"
const OTHER_NAME = "Other work"
const OVERVIEW_MAX = 6
/** A Yes posts at most this many members (routes/triage.ts). */
export const MEMBERS_MAX = 100

/** What Yes does to a member: approve a proposal, hand it to Opus (delegated), or hand a parked PR back to the shepherd. */
type MemberDoes = "approve" | "ask_opus" | "hand_back"

export interface RepoMember { id: string; version: string; does: MemberDoes }

type RunResultKind = "done" | "with_opus" | "handed_back" | "kept" | "failed" | "skipped"

export interface RepoRunResult { id: string; result: RunResultKind; reason?: string }

export type RepoRunStatus = "running" | "done" | "failed" | "interrupted"

export interface RepoRun {
  id: number
  repoKey: string
  cardVersion: string
  decision: "yes" | "no"
  note: string | null
  idemKey: string
  status: RepoRunStatus
  results: RepoRunResult[]
  summary: string | null
  createdAt: number
  finishedAt: number | null
}

/** A run as the card carries it (no idempotency key, no card version). */
export interface RepoRunView {
  id: number
  decision: "yes" | "no"
  status: RepoRunStatus
  note: string | null
  summary: string | null
  results: RepoRunResult[]
  createdAt: number
  finishedAt: number | null
}

interface RepoCounts { members: number; held: number; resolving: number; proposals: number; tasks: number; prs: number }

export interface RepoCard {
  /** `repo:<key>`; the key (repo name or "_other") is the `<repo>` path segment of Yes / No. */
  id: string
  repo: string | null
  name: string
  version: string
  overview: string[]
  counts: RepoCounts
  members: RepoMember[]
  /** Items Yes never touches (sensitive / client / stale PRs…): they stay individual cards. */
  held: string[]
  run?: RepoRunView
  createdAt: number
  updatedAt: number
}

/** One per-item card and the source it came from (version + hints never reach the wire). */
export interface CardInput { item: TriageItem; src: Pick<SourceItem, "version" | "hints" | "ref"> }

export interface MemberPlan { act: RepoMember[]; skipped: { id: string; reason: "changed" | "gone" | "held" }[] }

const MEMBER_SOURCES: ReadonlySet<TriageSource> = new Set(["task", "proposal", "pr"])

/** The card an item belongs to; null = never on a repo card (body, mytask). */
export function repoKeyOf(x: { source: TriageSource; repo: string | null }): string | null {
  if (!MEMBER_SOURCES.has(x.source)) return null
  return x.repo || REPO_OTHER
}

// Parks a Yes must never lift: Jeremie's own review, client work, or parks the shepherd re-parks at once (a loop).
const HELD_PARK = /^(?:dep lane: )?(?:touches |sensitive path)|needs your review|^client|^stale \(no activity|^dep auto-merge off/i
// Parks Opus decides on (it may close the PR when sure): the work is done or replaced elsewhere.
const OPUS_PARK = /^(?:superseded|task already)/i

/** Why a PR stays out of a Yes (it keeps its own card); null = Yes may act on it. */
export function heldReason(src: Pick<SourceItem, "hints" | "ref">): string | null {
  if (src.ref.source !== "pr") return null
  const parked = src.hints?.parked
  if (parked === undefined) return "not reviewed yet" // the 48 h safety net: never parked, never reviewed
  return HELD_PARK.test(parked.trim()) ? clip(parked, 80) : null
}

/** What Yes does to this item; null = held (or not a member at all). */
export function memberDoes(src: Pick<SourceItem, "hints" | "ref">): MemberDoes | null {
  switch (src.ref.source) {
    case "proposal": return "approve"
    case "task": return heldReason(src) === null ? "ask_opus" : null
    case "pr":
      if (heldReason(src) !== null) return null
      return OPUS_PARK.test(src.hints?.parked?.trim() ?? "") ? "ask_opus" : "hand_back"
    default: return null
  }
}

function verb(does: MemberDoes, src: Pick<SourceItem, "ref">): string {
  if (does === "approve") return "Start"
  if (does === "hand_back") return "Back to the shepherd"
  if (src.ref.source === "task") return src.ref.status === "blocked" ? "Opus answers" : "Opus retries"
  return "Opus decides"
}

/** At most OVERVIEW_MAX lines; the last one says how many more. */
export function overviewLines(lines: string[]): string[] {
  if (lines.length <= OVERVIEW_MAX) return lines
  const keep = lines.slice(0, OVERVIEW_MAX - 1)
  return [...keep, `+${lines.length - keep.length} more`]
}

const runView = (r: RepoRun): RepoRunView => ({
  id: r.id, decision: r.decision, status: r.status, note: r.note, summary: r.summary, results: r.results, createdAt: r.createdAt, finishedAt: r.finishedAt,
})

/** Values, never counts: a member's version edit moves it even when every count stays the same. */
function cardVersion(members: RepoMember[], held: string[], run: RepoRun | undefined): string {
  const parts = [members.map((m) => `${m.id}@${m.version}`).sort(), [...held].sort(), run ? `${run.id}:${run.status}` : ""]
  return createHash("sha1").update(JSON.stringify(parts)).digest("hex").slice(0, 16)
}

interface Group { key: string; inputs: CardInput[]; busy: ResolvingItem[] }

function groupOf(groups: Map<string, Group>, key: string): Group {
  let g = groups.get(key)
  if (!g) {
    g = { key, inputs: [], busy: [] }
    groups.set(key, g)
  }
  return g
}

function buildCard(g: Group, run: RepoRun | undefined): RepoCard {
  const members: RepoMember[] = []
  const held: string[] = []
  const lines: string[] = []
  const heldLines: string[] = []
  const count = (s: TriageSource) => g.inputs.filter((i) => i.item.source === s).length
  for (const { item, src } of g.inputs) {
    const does = memberDoes(src)
    if (does) {
      members.push({ id: item.id, version: src.version, does })
      lines.push(`${verb(does, src)}: ${clip(item.title, 70)}`)
    } else {
      held.push(item.id)
      heldLines.push(`Stays with you: ${clip(item.title, 70)}`)
    }
  }
  if (g.busy.length) heldLines.push(`Opus is on ${g.busy.length} more`)
  const created = g.inputs.length ? Math.min(...g.inputs.map((i) => i.item.createdAt)) : run?.createdAt ?? 0
  const updated = Math.max(created, ...g.inputs.map((i) => i.item.updatedAt), run?.finishedAt ?? run?.createdAt ?? 0)
  return {
    id: `repo:${g.key}`, repo: g.key === REPO_OTHER ? null : g.key, name: g.key === REPO_OTHER ? OTHER_NAME : g.key,
    version: cardVersion(members, held, run),
    overview: overviewLines([...lines, ...heldLines]),
    counts: { members: members.length, held: held.length, resolving: g.busy.length, proposals: count("proposal"), tasks: count("task"), prs: count("pr") },
    members, held,
    ...(run ? { run: runView(run) } : {}),
    createdAt: created, updatedAt: updated,
  }
}

/**
 * One card per repo, in the order its first item appears (items come ordered: urgent first, then oldest).
 * A repo with only Opus's work (resolving / approved merges) keeps its card; a repo with only a finished
 * run does not. `runs` = the latest run per repo key.
 */
export function buildRepoCards(inputs: CardInput[], resolving: ResolvingItem[], runs: Map<string, RepoRun>): RepoCard[] {
  const groups = new Map<string, Group>()
  for (const input of inputs) {
    const key = repoKeyOf(input.item)
    if (key) groupOf(groups, key).inputs.push(input)
  }
  for (const r of resolving) {
    const key = repoKeyOf(r)
    if (key) groupOf(groups, key).busy.push(r)
  }
  for (const [key, run] of runs) if (run.status === "running") groupOf(groups, key)
  return [...groups.values()].map((g) => buildCard(g, runs.get(g.key)))
}

/** Yes acts on the intersection of the posted snapshot with the card's members at the same version. */
export function yesPlan(card: RepoCard, posted: { id: string; version: string }[]): MemberPlan {
  const byId = new Map(card.members.map((m) => [m.id, m]))
  const held = new Set(card.held)
  const plan: MemberPlan = { act: [], skipped: [] }
  const seen = new Set<string>()
  for (const p of posted) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    const m = byId.get(p.id)
    if (m && m.version === p.version) continue
    plan.skipped.push({ id: p.id, reason: m ? "changed" : held.has(p.id) ? "held" : "gone" })
  }
  // Card order, not the client's: the overview reads in the same order the work runs.
  plan.act = card.members.filter((m) => seen.has(m.id) && !plan.skipped.some((s) => s.id === m.id))
  return plan
}

const RESULT_WORDS: [RunResultKind, string][] = [["done", "started"], ["with_opus", "with Opus"], ["handed_back", "handed back"], ["kept", "kept"], ["failed", "failed"], ["skipped", "skipped"]]

/** "2 started · 1 with Opus · 1 failed (live cap) · 1 skipped (changed)". */
export function runSummary(results: RepoRunResult[]): string {
  const parts: string[] = []
  for (const [kind, word] of RESULT_WORDS) {
    const hits = results.filter((r) => r.result === kind)
    if (!hits.length) continue
    const reasons = [...new Set(hits.map((r) => r.reason).filter((x): x is string => !!x))]
    parts.push(`${hits.length} ${word}${reasons.length && (kind === "failed" || kind === "skipped") ? ` (${reasons.join(", ")})` : ""}`)
  }
  return parts.join(" · ") || "nothing to do"
}
