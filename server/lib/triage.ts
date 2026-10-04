// Brain triage (docs/orchestrator-triage-api.md): what in the queue needs
// Jeremie, phrased as problem / action / options. Pure: types, the allowed
// actions per source, the phrasing prompt, validation of the model's JSON,
// the deterministic fallback, severity heuristics and ordering. Collection is
// lib/triage-sources.ts, the cache lib/triage-store.ts, the loop
// lib/triage-engine.ts, the live instance wiring/triage.ts.

export type TriageSource = "task" | "proposal" | "pr" | "body"
export type Severity = "urgent" | "normal" | "low"

export type TriageAction =
  | { kind: "answer"; text: string }
  | { kind: "answer_custom" }
  | { kind: "requeue" }
  | { kind: "cancel" }
  | { kind: "approve"; mode?: "headless" | "live" }
  | { kind: "reject" }
  | { kind: "merge" }
  | { kind: "close_pr" }
  | { kind: "open_url"; url: string }
  | { kind: "snooze"; hours: number }

export type ActionKind = TriageAction["kind"]

export interface TriageOption {
  id: string
  label: string
  detail?: string
  action: TriageAction
  destructive?: boolean
}

export interface TriageItem {
  id: string
  source: TriageSource
  refId: string
  title: string
  project: string | null
  severity: Severity
  problem: string
  action: string
  recommended: string
  options: TriageOption[]
  context?: string
  createdAt: number
  updatedAt: number
}

/** What the executor needs to act on an item (never on the wire). */
export type SourceRef =
  | { source: "task"; taskId: string; status: "blocked" | "failed"; channel: string | null }
  | { source: "proposal"; taskId: string; macFix: boolean }
  | { source: "pr"; taskId: string; prUrl: string; repo: string; number: number }
  | { source: "body"; componentId: string; investigationId: string }

/** One thing that needs Jeremie, before phrasing. */
export interface SourceItem {
  source: TriageSource
  refId: string
  /** The underlying state's version: a new version = re-phrase, and a choose against an old one is stale. */
  version: string
  title: string
  project: string | null
  /** When it started needing Jeremie (ordering: oldest first). */
  createdAt: number
  updatedAt: number
  /** Plain facts for the prompt and the fallback (blocker, description, reason…). */
  facts: Record<string, string>
  url: string | null
  /** Heuristic hints (criticality, body severity) the severity rule reads. */
  hints?: { criticality?: string | null; bodySeverity?: string | null; safetyNet?: boolean }
  ref: SourceRef
}

export interface Phrase {
  title: string
  problem: string
  action: string
  options: TriageOption[]
  recommended: string
  context?: string
}

export const TITLE_MAX = 80
export const LABEL_MAX = 32
export const DETAIL_MAX = 90
export const PROBLEM_MAX = 280
export const ACTION_MAX = 200
export const CONTEXT_MAX = 300
export const ANSWER_TEXT_MAX = 500
export const SNOOZE_MAX_HOURS = 168
const OPTION_IDS = ["a", "b", "c", "d"] as const
const DESTRUCTIVE: ReadonlySet<ActionKind> = new Set(["cancel", "close_pr", "reject"])

export const itemId = (source: TriageSource, refId: string): string => `${source}:${refId}`

/** The actions an option may map to, per source (a failed task cannot be unblocked). */
export function allowedActions(src: Pick<SourceItem, "source" | "ref" | "url">): ActionKind[] {
  switch (src.ref.source) {
    case "task": return src.ref.status === "blocked" ? ["answer", "answer_custom", "requeue", "cancel", "snooze"] : ["requeue", "cancel", "snooze"]
    case "proposal": return ["approve", "reject", "snooze"]
    case "pr": return ["merge", "close_pr", "open_url", "snooze"]
    case "body": return src.url ? ["requeue", "open_url", "snooze"] : ["requeue", "snooze"]
  }
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

// ── prompt ───────────────────────────────────────────────────────────────────

const KIND_HELP: Record<ActionKind, string> = {
  answer: '{"kind":"answer","text":"<the concrete answer the worker gets>"} — answer the blocker question; the task restarts with it',
  answer_custom: '{"kind":"answer_custom"} — Jeremie types his own answer',
  requeue: '{"kind":"requeue"} — run it again as is',
  cancel: '{"kind":"cancel"} — drop the task',
  approve: '{"kind":"approve"} — start the proposed work',
  reject: '{"kind":"reject"} — do not do it',
  merge: '{"kind":"merge"} — squash-merge the PR',
  close_pr: '{"kind":"close_pr"} — close the PR without merging',
  open_url: '{"kind":"open_url"} — open it to look first (the server fills the link)',
  snooze: '{"kind":"snooze","hours":24} — hide it for a while',
}

/** The one sonnet prompt for an item: strict JSON in the contract shape. */
export function phrasePrompt(src: SourceItem): string {
  const allowed = allowedActions(src)
  const facts = Object.entries(src.facts).filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v.slice(0, 1500)}`)
  return [
    "You triage Jeremie's work queue. Jeremie is a busy one-person operator reading this on his phone.",
    "Phrase ONE item as a decision he can make in a few seconds. Plain words, no jargon, no ids, no hashes.",
    "Write in the language the item is written in (French or English).",
    "",
    "Return ONLY minified JSON, no markdown:",
    '{"title":"<= 80 chars","problem":"1-2 short sentences: what is wrong and why it matters","action":"1 sentence: what you recommend","context":"optional, 1-3 short lines of evidence","options":[{"label":"<= 32 chars, verb first","detail":"optional, <= 90 chars","action":{...}}]}',
    "",
    "Rules:",
    "- 2 to 4 options. The FIRST option is your recommendation.",
    "- Every option's action must be one of these, exactly:",
    ...allowed.map((k) => `  ${KIND_HELP[k]}`),
    ...(allowed.includes("answer")
      ? ["- If the blocker is a question, offer 1-2 concrete answers (kind answer, with the full answer text) plus answer_custom."]
      : []),
    "",
    `Item (${src.source}):`,
    `title: ${src.title}`,
    ...(src.project ? [`project: ${src.project}`] : []),
    ...facts,
  ].join("\n")
}

// ── validation ───────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
  for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    try {
      const o = JSON.parse(candidate) as unknown
      if (o && typeof o === "object" && !Array.isArray(o)) return o as Record<string, unknown>
    } catch { /* next */ }
  }
  return null
}

/** One model action → a valid TriageAction for this source, or null. */
function toAction(v: unknown, src: SourceItem, allowed: readonly ActionKind[]): TriageAction | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const kind = o.kind as ActionKind
  if (!allowed.includes(kind)) return null
  switch (kind) {
    case "answer": {
      const text = str(o.text)
      return text ? { kind, text: text.slice(0, ANSWER_TEXT_MAX) } : null
    }
    case "open_url": return src.url ? { kind, url: src.url } : null
    case "snooze": {
      const h = typeof o.hours === "number" && Number.isFinite(o.hours) ? Math.round(o.hours) : 24
      return { kind, hours: Math.min(SNOOZE_MAX_HOURS, Math.max(1, h)) }
    }
    case "approve": return o.mode === "live" || o.mode === "headless" ? { kind, mode: o.mode } : { kind }
    default: return { kind } as TriageAction
  }
}

const FRENCH = /[àâçéèêëîïôûùœ]|\b(le|la|les|des|une|est|pas|pour|avec|tâche)\b/i
/** Good enough to pick the language of a label the model left out. */
export const looksFrench = (text: string): boolean => FRENCH.test(text)

const actionKey = (a: TriageAction): string => (a.kind === "answer" ? `answer:${a.text}` : a.kind)

/** Re-id a..d in order, mark destructive by code; the first option is the recommendation. */
export function finishOptions(options: Omit<TriageOption, "id">[]): { options: TriageOption[]; recommended: string } {
  const out = options.slice(0, OPTION_IDS.length).map((o, i) => {
    const opt: TriageOption = { id: OPTION_IDS[i]!, label: clip(o.label, LABEL_MAX), action: o.action }
    if (o.detail?.trim()) opt.detail = clip(o.detail, DETAIL_MAX)
    if (DESTRUCTIVE.has(o.action.kind)) opt.destructive = true
    return opt
  })
  return { options: out, recommended: out[0]?.id ?? "a" }
}

/** The model's text → a Phrase that only uses this source's allowed actions; null = use the fallback. */
export function validatePhrase(raw: string | null, src: SourceItem): Phrase | null {
  if (!raw) return null
  const o = parseJsonObject(raw)
  if (!o) return null
  const problem = str(o.problem)
  const action = str(o.action)
  if (!problem || !action || !Array.isArray(o.options)) return null
  const allowed = allowedActions(src)
  const seen = new Set<string>()
  const options: Omit<TriageOption, "id">[] = []
  for (const raw of o.options) {
    if (!raw || typeof raw !== "object") return null
    const opt = raw as Record<string, unknown>
    const label = str(opt.label)
    const act = toAction(opt.action, src, allowed)
    if (!label || !act) return null
    if (seen.has(actionKey(act))) continue
    seen.add(actionKey(act))
    options.push({ label, detail: str(opt.detail) || undefined, action: act })
  }
  if (options.length < 2 || options.length > 4) return null
  // A question always leaves room for Jeremie's own words.
  if (allowed.includes("answer_custom") && !seen.has("answer_custom")) {
    const custom = { label: looksFrench(`${problem} ${action}`) ? "Répondre moi-même" : "Write my own answer", action: { kind: "answer_custom" } as TriageAction }
    if (options.length < 4) options.push(custom)
    else options[3] = custom
  }
  const { options: finished, recommended } = finishOptions(options)
  const context = str(o.context)
  return {
    title: clip(str(o.title) || src.title, TITLE_MAX),
    problem: clip(problem, PROBLEM_MAX),
    action: clip(action, ACTION_MAX),
    options: finished,
    recommended,
    ...(context ? { context: clip(context, CONTEXT_MAX) } : {}),
  }
}

// ── fallback ─────────────────────────────────────────────────────────────────

const snooze = { label: "Snooze for a day", action: { kind: "snooze", hours: 24 } as TriageAction }

/** Deterministic phrasing when the model is unavailable or its output is invalid. */
export function fallbackPhrase(src: SourceItem): Phrase {
  const f = src.facts
  const title = clip(src.title || src.refId, TITLE_MAX)
  const why = (k: string, dflt: string) => clip(f[k]?.trim() || dflt, PROBLEM_MAX)
  const make = (problem: string, action: string, options: Omit<TriageOption, "id">[], context?: string): Phrase => {
    const done = finishOptions(options)
    return { title, problem, action, ...done, ...(context ? { context: clip(context, CONTEXT_MAX) } : {}) }
  }
  const ref = src.ref
  if (ref.source === "task" && ref.status === "blocked") {
    return make(why("blocker", "The task is blocked without a reason."), "Answer it so the task restarts, or retry or cancel it.", [
      { label: "Answer it", action: { kind: "answer_custom" } },
      { label: "Retry as is", action: { kind: "requeue" } },
      { label: "Cancel the task", action: { kind: "cancel" } },
    ])
  }
  if (ref.source === "task") {
    return make(why("blocker", "The run failed."), "Retry it; cancel it if it keeps failing.", [
      { label: "Retry it", action: { kind: "requeue" } },
      { label: "Cancel the task", action: { kind: "cancel" } },
      snooze,
    ])
  }
  if (ref.source === "proposal") {
    const where = ref.macFix ? "Run the fix on the Mac" : "Approve and start it"
    return make(why("reasoning", "The brain proposes this work and waits for your OK."), "Approve it if it still makes sense.", [
      { label: where, action: { kind: "approve" } },
      { label: "Reject it", action: { kind: "reject" } },
      snooze,
    ], f.prompt)
  }
  if (ref.source === "pr") {
    return make(why("reason", "This PR waits for your review."), "Look at the PR, then merge or close it.", [
      { label: "Review it on GitHub", action: { kind: "open_url", url: ref.prUrl } },
      { label: "Merge it", action: { kind: "merge" } },
      { label: "Close without merging", action: { kind: "close_pr" } },
    ], f.review)
  }
  const options: Omit<TriageOption, "id">[] = [{ label: "Investigate again", action: { kind: "requeue" } }]
  if (src.url) options.push({ label: "Open the component", action: { kind: "open_url", url: src.url } })
  options.push(snooze)
  return make(why("problem", "This component is down and its diagnosis failed twice."), "Run the diagnosis again, or look at it yourself.", options, f.error)
}

// ── severity + order ─────────────────────────────────────────────────────────

const URGENT_WORDS = /\b(prod(uction)?|outage|down|client|invoice|facture|payment|paiement|deadline|urgent|security|cve|data loss)\b/i

/** Heuristic severity when Jev gives none. */
export function heuristicSeverity(src: SourceItem): Severity {
  const h = src.hints ?? {}
  if (src.ref.source === "body") return /^(critical|high)$/i.test(h.criticality ?? "") ? "urgent" : "normal"
  if (src.ref.source === "proposal" && /^(critical|high)$/i.test(h.bodySeverity ?? "")) return "urgent"
  if (src.ref.source === "pr" && h.safetyNet) return "low"
  if (src.ref.source === "task" && src.ref.status === "failed") return "low"
  const text = `${src.title} ${src.facts.blocker ?? ""} ${src.facts.reason ?? ""}`
  return URGENT_WORDS.test(text) ? "urgent" : "normal"
}

const RANK: Record<Severity, number> = { urgent: 0, normal: 1, low: 2 }

/** Urgent first, then oldest. */
export function orderItems(items: TriageItem[]): TriageItem[] {
  return [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
}

export function buildItem(src: SourceItem, phrase: Phrase, severity: Severity): TriageItem {
  return {
    id: itemId(src.source, src.refId), source: src.source, refId: src.refId, title: phrase.title, project: src.project,
    severity, problem: phrase.problem, action: phrase.action, recommended: phrase.recommended, options: phrase.options,
    ...(phrase.context ? { context: phrase.context } : {}),
    createdAt: src.createdAt, updatedAt: src.updatedAt,
  }
}

/** One line for the brain's #General / #Body context; null when nothing waits. */
export function triageDigest(items: TriageItem[]): string | null {
  if (!items.length) return null
  const urgent = items.filter((i) => i.severity === "urgent").length
  const top = items.slice(0, 3).map((i) => i.title).join(" · ")
  return `Triage: ${items.length} item${items.length === 1 ? "" : "s"} wait for Jeremie${urgent ? ` (${urgent} urgent)` : ""} — ${clip(top, 240)}`
}
