import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  type ActionKind, type Phrase, type ResolverInfo, type ResolverOutcome, type SourceItem, type TriageAction, type TriageOption,
  ACTION_MAX, ANSWER_TEXT_MAX, INSTRUCTION_MAX, PROBLEM_MAX, clip, fallbackPhrase, finishOptions, validatePhraseObject,
} from "./triage"

// The Opus resolver (docs/orchestrator-triage-api.md#opus-resolver): before a
// triage item reaches Jeremie, Opus works it as far as it safely can. Pure:
// config, routing, sensitivity, the prompt, output parsing, the POLICY (the
// model only proposes; this file decides what may run without Jeremie), the
// card Opus prepares, the digest. Scheduling is lib/resolver-engine.ts, the
// live seams wiring/resolver.ts.

export const DEFAULT_MODEL = "claude-opus-5-5"
export const DEFAULT_MAX_CONCURRENT = 2
export const DEFAULT_MAX_PER_DAY = 60
export const DEFAULT_TIMEOUT_MS = 20 * 60_000
/** A normal run still queued after this long (the backlog did not drain) falls through to the normal card. */
export const QUEUE_MAX_MS = 3 * 60 * 60_000
/** A fix run on a PR branch (the shepherd's budget); it may start up to the analysis deadline. */
export const FIX_RUN_MS = 30 * 60_000
export const CONFIDENT = 0.8
export const RESOLVER_CONTEXT_MAX = 1500
export const SUMMARY_MAX = 200
export const RESOLVER_SLUG = "opus-resolver"

export type Autonomy = "normal" | "elevated"

export interface ResolverConfig {
  enabled: boolean
  model: string
  maxConcurrent: number
  maxPerDay: number
  timeoutMs: number
  queueMaxMs: number
  /** Analyse for real, execute nothing (the dry-run smoke). */
  dryRun: boolean
}

export const disabledFlag = (home: string = process.env.HOME || homedir()): string => join(home, ".claude-companion", ".resolver-disabled")

const posInt = (v: string | undefined, dflt: number): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt
}

export function resolverConfig(
  env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync, home?: string,
): ResolverConfig {
  const off = /^(0|off|false|no)$/i.test(env.COMPANION_RESOLVER?.trim() ?? "")
  return {
    enabled: !off && !exists(disabledFlag(home ?? env.HOME ?? homedir())),
    model: env.COMPANION_RESOLVER_MODEL?.trim() || DEFAULT_MODEL,
    maxConcurrent: posInt(env.COMPANION_RESOLVER_MAX_CONCURRENT, DEFAULT_MAX_CONCURRENT),
    maxPerDay: posInt(env.COMPANION_RESOLVER_DAILY ?? env.COMPANION_RESOLVER_MAX_PER_DAY, DEFAULT_MAX_PER_DAY),
    timeoutMs: posInt(env.COMPANION_RESOLVER_TIMEOUT_MIN, DEFAULT_TIMEOUT_MS / 60_000) * 60_000,
    queueMaxMs: QUEUE_MAX_MS,
    dryRun: /^(1|true|yes)$/i.test(env.COMPANION_RESOLVER_DRY_RUN?.trim() ?? ""),
  }
}

/** Which items the resolver takes. Trips are Jev + the human; a proposal Opus wrote itself is never re-resolved. */
export function routable(src: SourceItem, opts: { createdByResolver?: (taskId: string) => boolean; bodyLocal?: (componentId: string) => boolean } = {}): boolean {
  const ref = src.ref
  switch (ref.source) {
    case "trip": return false
    case "proposal": return !opts.createdByResolver?.(ref.taskId)
    case "body": return opts.bodyLocal?.(ref.componentId) ?? true
    default: return true
  }
}

/**
 * The resolver's own key for an item: a new key = a new run. Not the triage
 * version — an `updated_at` bump on a still-blocked task must not burn budget.
 */
export function resolverKey(src: SourceItem): string {
  const ref = src.ref
  switch (ref.source) {
    case "task": return `${ref.status}|${hash(src.facts.blocker ?? "")}`
    case "pr": return src.version.split("|").pop() ?? src.version
    case "body": return ref.investigationId
    default: return src.version
  }
}

function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16)
}

// ── sensitivity ──────────────────────────────────────────────────────────────

/** Same list as the shepherd's (claude-config tools/dep-lane.ts SENSITIVE_RE); keep in sync. */
export const SENSITIVE_RE = /auth|login|password|token|secret|payment|stripe|crypto|hmac|\.env|migration|schema\.sql|\.github\/|dockerfile|docker-compose|middleware/i

export function sensitivePaths(paths: string[]): string[] {
  return paths.filter((p) => SENSITIVE_RE.test(p))
}

/** A PR is sensitive when it touches a sensitive path, or the shepherd parked it for exactly that. */
export function isSensitivePr(paths: string[], parkReason: string): boolean {
  return sensitivePaths(paths).length > 0 || /^touches\b/i.test(parkReason.trim())
}

// ── consent (ask_opus) ───────────────────────────────────────────────────────
// Jeremie's ask_opus instruction on THIS item. An imperative to act ("fix it",
// "vas-y") = consent to Opus's recommended action, merge / cancel / close /
// approve included. Words that limit Opus ("don't merge", "just look",
// "explain") = Opus only prepares. No instruction = his one-tap rule holds:
// a merge or cancel waits for him.

/** "explicit": a short obvious go (the matcher alone is enough) · "imperative": a longer order (Opus's `consent` must agree) · "prepare": he limited Opus · "other" / "none". */
export type Consent = "explicit" | "imperative" | "prepare" | "other" | "none"

const FILLER = /\b(?:please|pls|plz|now|then|thanks|thank you|merci|stp|svp|s'il te pla[iî]t|maintenant|alors|juste|just)\b/gi
const GO_PHRASES = [
  "fix it", "fix", "do it", "go", "go ahead", "go for it", "handle it", "ok", "okay", "yes", "yep", "yup", "sure", "ship it", "proceed",
  "merge", "merge it", "close", "close it", "cancel", "cancel it", "approve", "approve it", "drop it", "retry", "try again", "do that",
  "oui", "vas-y", "vasy", "vas y", "go vas-y", "fais-le", "fais le", "fais-ça", "fais ça", "fais ca", "règle ça", "regle ca", "règle-le", "règle le",
  "d'accord", "c'est bon", "ferme", "ferme-le", "annule", "annule-le", "approuve", "approuve-le", "merge-le", "corrige", "corrige-le",
  "corrige ça", "répare", "répare-le", "réessaie", "lance", "lance-le",
]
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const GO_RE = new RegExp(`^(?:(?:${GO_PHRASES.sort((a, b) => b.length - a.length).map(esc).join("|")})\\s*)+$`, "i")
const LIMIT_RE = /\?|\b(?:don'?t|do not|never|no merge|not (?:merge|close|cancel)|(?:just|only) (?:look|check|review|explain|tell)|look only|explain|why|wait|hold off|hold)\b|\bne\b[^.]*\bpas\b|\bn'[a-zà-ÿ]+\b[^.]*\bpas\b|\bpas (?:de|encore)\b|\bjuste (?:regarde|regarder|vérifie|vérifier|explique|expliquer)\b|\bexplique|\bpourquoi\b|\battends?\b|\bsans (?:merger|merge|fermer|annuler)\b/i
export const FIX_PREFILL = "Fix on the PR branch:"
export const RETRY_PREFILL = "Try the fix again on the PR branch:"
const PREFILLED_RE = /^(?:Fix on the PR branch|Try the fix again on the PR branch):/i
const IMPERATIVE_RE = /\b(?:fix|do|handle|merge|close|cancel|approve|ship|go|proceed|retry|rebase|vas-?y|fais|règle|regle|ferme|annule|approuve|corrige|répare|repare|réessaie|lance)\b/i

export function consentOf(instruction: string | null | undefined): Consent {
  const raw = (instruction ?? "").trim()
  if (!raw) return "none"
  // The card's own prefilled orders (the problem list after the colon is Opus's text, not Jeremie's words).
  if (PREFILLED_RE.test(raw)) return "imperative"
  if (LIMIT_RE.test(raw)) return "prepare"
  const words = raw.toLowerCase().replace(/[!.,;:]+/g, " ").replace(FILLER, " ").replace(/\s+/g, " ").trim()
  if (words && words.split(" ").length <= 5 && GO_RE.test(words)) return "explicit"
  return IMPERATIVE_RE.test(raw) ? "imperative" : "other"
}

/** Consent to Opus's recommended action: the short obvious words alone, or an imperative Opus also read as consent. */
export function consents(instruction: string | null | undefined, opusConsent = false): boolean {
  const c = consentOf(instruction)
  return c === "explicit" || (c === "imperative" && opusConsent)
}

/** Jeremie's explicit retry words lift the loop guard once. */
export const RETRY_RE = /\b(?:retry|try again|réessaie|essaie encore|encore une fois)\b/i

// ── output ───────────────────────────────────────────────────────────────────

export type ResolverAction =
  | { kind: "none" }
  | { kind: "answer"; text: string }
  | { kind: "requeue" }
  | { kind: "cancel" }
  | { kind: "merge" }
  | { kind: "close_pr"; reason: string }
  | { kind: "fix"; instructions: string }
  | { kind: "approve" }
  | { kind: "reject"; reason: string }
  | { kind: "revise"; title: string; prompt: string }

export type ResolverActionKind = ResolverAction["kind"]

export interface PrReview {
  whatChanged: string
  risk: string
  prodFailure: string
  testsCover: string
  problems: string[]
  verdict: "safe" | "changes" | "unsafe"
}

export interface ResolverOutput {
  analysis: string
  summary: string
  confidence: number
  needsJeremie: boolean
  /** none | preference | money | client_wording | irreversible | ambiguous | insufficient_evidence */
  why: string
  /** Source-specific: pr stale|superseded|task_done|safe|needs_changes|ci_failing|ambiguous; proposal duplicate|stale|done|needed|rescope|ambiguous. */
  category: string
  action: ResolverAction
  review: PrReview | null
  /** The raw card object (validated against the source when the card is built). */
  card: Record<string, unknown> | null
  /** ask_opus only: Opus reads Jeremie's instruction as consent to act (merge / cancel included). */
  consent?: boolean
}

/** The actions Opus may name for a source (the policy below still decides what runs). */
export function resolverActions(src: Pick<SourceItem, "ref">): ResolverActionKind[] {
  const ref = src.ref
  switch (ref.source) {
    case "task": return ref.status === "blocked" ? ["none", "answer", "requeue", "cancel"] : ["none", "requeue", "cancel"]
    case "pr": return ["none", "merge", "close_pr", "fix"]
    case "proposal": return ["none", "approve", "reject", "revise"]
    default: return ["none"]
  }
}

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : "")

function jsonCandidates(text: string): string[] {
  const t = text.trim()
  const out = [t]
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(m[1]!.trim())
  const a = t.indexOf("{"), b = t.lastIndexOf("}")
  if (a >= 0 && b > a) out.push(t.slice(a, b + 1))
  return out
}

function toResolverAction(v: unknown, allowed: readonly ResolverActionKind[]): ResolverAction | null {
  if (!v || typeof v !== "object") return { kind: "none" }
  const o = v as Record<string, unknown>
  const kind = String(o.kind ?? "none") as ResolverActionKind
  if (!allowed.includes(kind)) return null
  switch (kind) {
    case "answer": { const text = str(o.text, ANSWER_TEXT_MAX); return text ? { kind, text } : null }
    case "close_pr": return { kind, reason: str(o.reason, 300) || "closed by the Opus resolver" }
    case "reject": return { kind, reason: str(o.reason, 300) || "rejected by the Opus resolver" }
    case "fix": { const instructions = str(o.instructions, 4000); return instructions ? { kind, instructions } : null }
    case "revise": {
      const prompt = str(o.prompt, 4000)
      return prompt ? { kind, title: str(o.title, 120), prompt } : null
    }
    default: return { kind } as ResolverAction
  }
}

function toReview(v: unknown): PrReview | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const verdict = o.verdict === "safe" || o.verdict === "changes" || o.verdict === "unsafe" ? o.verdict : "changes"
  const problems = Array.isArray(o.problems) ? o.problems.map((p) => str(p, 300)).filter(Boolean).slice(0, 8) : []
  return { whatChanged: str(o.whatChanged, 400), risk: str(o.risk, 400), prodFailure: str(o.prodFailure, 400), testsCover: str(o.testsCover, 300), problems, verdict }
}

/** Model text → output; null when it is not the JSON object we asked for. A disallowed action reads as none. */
export function parseResolverOutput(text: string, src: Pick<SourceItem, "ref">): ResolverOutput | null {
  for (const c of jsonCandidates(text)) {
    let v: unknown
    try { v = JSON.parse(c) } catch { continue }
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    const o = v as Record<string, unknown>
    const analysis = str(o.analysis, 4000)
    const summary = str(o.summary, 400)
    if (!analysis && !summary) continue
    let confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0
    if (confidence > 1 && confidence <= 100) confidence /= 100
    const action = toResolverAction(o.action, resolverActions(src)) ?? { kind: "none" }
    return {
      analysis, summary: summary || clip(analysis, SUMMARY_MAX), confidence: Math.min(1, Math.max(0, confidence)),
      needsJeremie: o.needsJeremie !== false, why: str(o.why, 40).toLowerCase() || "ambiguous",
      category: str(o.category, 40).toLowerCase(), action,
      review: src.ref.source === "pr" ? toReview(o.review) : null,
      card: o.card && typeof o.card === "object" && !Array.isArray(o.card) ? o.card as Record<string, unknown> : null,
      consent: o.consent === true,
    }
  }
  return null
}

// ── policy ───────────────────────────────────────────────────────────────────

export interface PolicyCtx {
  autonomy: Autonomy
  instruction: string | null
  /** PR: touches a sensitive path (or parked for it). */
  sensitive: boolean
  /** PR: Opus already ran a rescue on this PR URL once. */
  rescuedBefore: boolean
  /** The item came back after Opus resolved it: a card, never a second autonomous action. */
  repeat?: boolean
}

/**
 * What happens next. `act` runs `action` (then: "resolved" hides the item,
 * "card" still shows Jeremie a card, "unpark" hands the PR back to the shepherd).
 */
export type Plan =
  | { kind: "act"; action: Exclude<ResolverAction, { kind: "none" }>; then: "resolved" | "card" | "unpark"; reason: string }
  | { kind: "card"; reason: string }

const card = (reason: string): Plan => ({ kind: "card", reason })
const CLOSABLE = new Set(["stale", "superseded", "task_done"])
const REJECTABLE = new Set(["duplicate", "stale", "done"])

/** The one place that decides what may run without Jeremie. */
export function decide(src: Pick<SourceItem, "ref">, out: ResolverOutput, ctx: PolicyCtx): Plan {
  const a = out.action
  if (a.kind === "none") return card(out.needsJeremie ? `needs Jeremie (${out.why})` : "nothing to do without Jeremie")
  const isPr = src.ref.source === "pr"
  if (ctx.autonomy === "elevated") {
    const c = consentOf(ctx.instruction)
    if (c === "prepare") return card("Jeremie asked Opus to look, not act")
    if ((a.kind === "merge" || a.kind === "cancel") && !consents(ctx.instruction, out.consent)) {
      return card(c === "imperative" ? `${a.kind}: Opus did not read "${clip(ctx.instruction ?? "", 60)}" as consent` : `${a.kind} needs Jeremie's explicit words`)
    }
    if (a.kind === "fix") return { kind: "act", action: a, then: ctx.sensitive ? "card" : "unpark", reason: "Jeremie asked Opus" }
    return { kind: "act", action: a, then: "resolved", reason: "Jeremie asked Opus" }
  }
  if (ctx.repeat) return card("came back after Opus handled it once")
  const sure = out.confidence >= CONFIDENT && !out.needsJeremie
  switch (a.kind) {
    case "answer":
      return sure && out.why === "none" ? { kind: "act", action: a, then: "resolved", reason: `confident (${pct(out.confidence)})` } : card(`not confident enough to answer (${pct(out.confidence)}, ${out.why})`)
    case "requeue":
      return sure ? { kind: "act", action: a, then: "resolved", reason: `transient failure (${pct(out.confidence)})` } : card("not sure a retry helps")
    case "close_pr":
      if (ctx.sensitive) return card("sensitive PR: Jeremie decides")
      return sure && CLOSABLE.has(out.category) ? { kind: "act", action: a, then: "resolved", reason: out.category } : card("not clearly stale, superseded or done")
    case "fix":
      if (!isPr) return card("fix is a PR action")
      if (ctx.sensitive) {
        return out.review?.problems.length ? { kind: "act", action: a, then: "card", reason: "review found problems" } : card("no problem to fix")
      }
      return ctx.rescuedBefore ? card("already rescued once") : { kind: "act", action: a, then: "unpark", reason: "one rescue attempt" }
    case "reject":
      return sure && REJECTABLE.has(out.category) ? { kind: "act", action: a, then: "resolved", reason: out.category } : card("not clearly a duplicate or stale")
    case "merge": return card(ctx.sensitive ? "sensitive merge is Jeremie's one tap" : "merges stay with Jeremie or the shepherd")
    case "cancel": return card("cancelling is Jeremie's call")
    case "approve": return card("approving is Jeremie's call")
    case "revise": return card("a rescoped proposal needs Jeremie's OK")
  }
}

const pct = (c: number): string => `${Math.round(c * 100)} %`

// ── the prepared card ────────────────────────────────────────────────────────

export function reviewLines(r: PrReview): string[] {
  return [
    r.whatChanged && `What changed: ${r.whatChanged}`,
    r.risk && `Risk: ${r.risk}`,
    r.prodFailure && `Could fail in prod: ${r.prodFailure}`,
    r.testsCover && `Tests: ${r.testsCover}`,
    ...r.problems.map((p) => `Problem: ${p}`),
  ].filter((l): l is string => !!l)
}

/** Opus's analysis + review lines; line breaks kept, clipped to RESOLVER_CONTEXT_MAX. */
export function contextText(out: ResolverOutput, extra: string[] = []): string {
  const text = [out.analysis, ...(out.review ? reviewLines(out.review) : []), ...extra]
    .map((l) => l.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim()).filter(Boolean).join("\n")
  return text.length <= RESOLVER_CONTEXT_MAX ? text : `${text.slice(0, RESOLVER_CONTEXT_MAX - 1).trimEnd()}…`
}

const ASK: ActionKind[] = ["ask_opus"]

function prepend(phrase: Phrase, first: Omit<TriageOption, "id">, same: (o: TriageOption) => boolean): Phrase {
  const rest = phrase.options.filter((o) => !same(o)).map(({ id: _id, ...o }) => o)
  const done = finishOptions([first, ...rest])
  return { ...phrase, ...done }
}

/** Opus's card: its own phrasing when valid, else the deterministic one; context = its analysis. */
export function preparedPhrase(src: SourceItem, out: ResolverOutput, ctx: Pick<PolicyCtx, "sensitive">, extra: string[] = []): Phrase {
  const context = contextText(out, extra)
  let phrase = (out.card && validatePhraseObject(out.card, src, { extraKinds: ASK, contextMax: RESOLVER_CONTEXT_MAX })) || fallbackPhrase(src)
  phrase = { ...phrase, context }
  // A blocked task: Opus's best answer is the recommended option.
  if (out.action.kind === "answer" && src.ref.source === "task" && src.ref.status === "blocked") {
    const text = out.action.text
    phrase = prepend(phrase, { label: "Use Opus's answer", detail: clip(text, 90), action: { kind: "answer", text } }, (o) => o.action.kind === "answer" && o.action.text === text)
  }
  if (src.ref.source === "pr") phrase = prCardOrder(phrase, out, ctx.sensitive)
  return phrase
}

/** A PR card always offers Merge; it is recommended only when the review reads safe. */
function prCardOrder(phrase: Phrase, out: ResolverOutput, sensitive: boolean): Phrase {
  const safe = out.review?.verdict === "safe"
  const merge = phrase.options.find((o) => o.action.kind === "merge")
  const others = phrase.options.filter((o) => o.action.kind !== "merge").map(({ id: _id, ...o }) => o)
  const m: Omit<TriageOption, "id"> = merge ? (({ id: _id, ...o }) => o)(merge) : { label: "Merge", action: { kind: "merge" } as TriageAction }
  if (safe) return { ...phrase, ...finishOptions([m, ...others]) }
  const ask = out.review?.problems.length
    ? [{ label: "Ask for changes", detail: clip(out.review.problems.join("; "), 90), action: { kind: "ask_opus", instruction: `${FIX_PREFILL} ${out.review.problems.join("; ")}` } as TriageAction }]
    : []
  const rest = others.filter((o) => !(o.action.kind === "ask_opus" && ask.length))
  return { ...phrase, ...finishOptions([...ask, ...rest, ...(sensitive || merge ? [m] : [])].slice(0, 4)) }
}

export function resolverInfo(
  status: ResolverInfo["status"], summary: string, model: string, finishedAt: number | null,
  extra: { outcome?: ResolverOutcome | null; queuePosition?: number | null } = {},
): ResolverInfo {
  return {
    status, summary: clip(summary, SUMMARY_MAX), model, finishedAt,
    ...(extra.outcome ? { outcome: extra.outcome } : {}),
    ...(extra.queuePosition ? { queuePosition: extra.queuePosition } : {}),
  }
}

// ── the outcome, first ───────────────────────────────────────────────────────
// A card after Opus ACTED (or tried to) says what happened before anything
// else, and its recommended option follows from it: never "Ask for changes"
// right after Opus pushed changes, never a silent re-run of what just failed.

export interface OutcomeNote {
  outcome: ResolverOutcome
  /** "Fix failed: …" / "Fix pushed 1a2b3c4d: …; CI re-running" / "No change needed: …". */
  headline: string
  /** failed: the same action failed twice — no retry offered. */
  gaveUp?: boolean
  /** failed (not given up): the ask_opus instruction behind "Ask Opus to retry". */
  retry?: string | null
}

const isFixAsk = (o: TriageOption): boolean => o.action.kind === "ask_opus" && /^(?:Fix on the PR branch|Try the fix again on the PR branch):/i.test(o.action.instruction ?? "")
const strip = ({ id: _id, ...o }: TriageOption): Omit<TriageOption, "id"> => o

/** The card after an action: outcome first in `problem`, options consistent with it. `planned` = unchanged. */
export function outcomePhrase(src: Pick<SourceItem, "ref" | "url">, phrase: Phrase, note: OutcomeNote): Phrase {
  if (note.outcome === "planned") return phrase
  const rest = phrase.options.filter((o) => !isFixAsk(o)).map(strip)
  const first: Omit<TriageOption, "id">[] = []
  let action = phrase.action
  const openPr = src.ref.source === "pr" && src.url ? [{ label: "Open the PR", detail: "Look at it yourself", action: { kind: "open_url", url: src.url } as TriageAction }] : []
  if (note.outcome === "failed") {
    if (!note.gaveUp && note.retry) {
      first.push({ label: "Ask Opus to retry", detail: clip(note.headline, 90), action: { kind: "ask_opus", instruction: clip(note.retry, INSTRUCTION_MAX) } })
      action = "Let Opus try again, or handle it yourself."
    } else {
      first.push(...openPr)
      action = "Opus stopped retrying: handle it yourself, or tell Opus what to change."
    }
  } else if (note.outcome === "done") {
    if (src.ref.source === "pr") {
      first.push({ label: "Wait for CI", detail: "Snooze 1 h, then merge once CI is green", action: { kind: "snooze", hours: 1 } })
      const merge = rest.find((o) => o.action.kind === "merge")
      if (merge) merge.detail = "Only once CI is green on the new commit"
      action = "Wait for CI on the new commit, then merge."
    }
  } else if (note.outcome === "no_change") {
    first.push(...openPr)
    action = "Nothing was changed: look at it yourself or close it."
  }
  const seen = new Set(first.map((o) => o.action.kind === "open_url" ? "open_url" : ""))
  const options = [...first, ...rest.filter((o) => !(o.action.kind === "open_url" && seen.has("open_url")))]
  const problem = clip(`${note.headline.replace(/[.\s]+$/, "")}. ${phrase.problem}`, PROBLEM_MAX)
  return { ...phrase, problem, action: clip(action, ACTION_MAX), ...finishOptions(options.slice(0, 4)) }
}

/** The card's one-line summary: a sensitive PR reads "Opus reviewed: …". */
export function cardSummary(src: Pick<SourceItem, "ref">, out: ResolverOutput, sensitive: boolean): string {
  if (src.ref.source === "pr" && sensitive && !/^opus reviewed/i.test(out.summary)) return `Opus reviewed: ${out.summary}`
  return out.summary
}

// ── digest ───────────────────────────────────────────────────────────────────

/** The day's resolver work for #General; null when nothing happened. */
export function digestText(counts: Record<string, number>): string | null {
  const n = (k: string) => counts[k] ?? 0
  const answered = n("answer")
  const closed = n("close_pr") + n("reject")
  const prepared = n("prepared")
  const fixed = n("fix")
  const other = n("requeue") + n("merge") + n("approve") + n("cancel") + n("revise") + n("propose") + n("explain")
  const total = answered + closed + prepared + fixed + other
  if (!total) return null
  const parts = [`answered ${answered}`, `closed ${closed}`, `prepared ${prepared} for you`]
  if (fixed) parts.push(`fixed ${fixed} PR${fixed === 1 ? "" : "s"}`)
  if (other) parts.push(`${other} other`)
  const failed = n("failed")
  return `🤖 Opus handled ${total} item${total === 1 ? "" : "s"} today: ${parts.join(", ")}${failed ? ` (${failed} fell through to you)` : ""}.`
}
