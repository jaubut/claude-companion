import { consents } from "./resolver"
import { type TriageSource, clip } from "./triage"

// No on a repo card (docs/orchestrator-triage-api.md#repo-cards): ONE Opus
// call re-plans the repo's pending work from Jeremie's note. Pure: the prompt,
// parsing, and the policy that decides which of Opus's steps may run (the
// model only proposes). The runner (wiring/triage-repos.ts) executes the
// allowed steps through the triage engine's actOn, reviseProposal and the
// resolver.

export const NOTE_MAX = 2000

export type ReworkStep =
  | { id: string; kind: "keep" | "reject" | "cancel" | "close_pr"; why: string }
  | { id: string; kind: "revise"; title: string; prompt: string; why: string }
  | { id: string; kind: "answer"; text: string; why: string }
  | { id: string; kind: "ask_opus"; instruction: string; why: string }

export type ReworkKind = ReworkStep["kind"]

export interface ReworkOutput {
  summary: string
  /** Opus reads Jeremie's note as consent to drop work (cancel / close_pr). */
  consent: boolean
  steps: ReworkStep[]
}

/** One item of the card as Opus sees it. */
export interface ReworkMember {
  id: string
  source: TriageSource
  title: string
  problem: string
  /** The label of the card's recommended option. */
  recommended: string
  /** A held PR: Opus may not act on it. */
  held: boolean
  /** A blocked task (an answer applies). */
  blocked: boolean
}

export function reworkPrompt(repo: string, note: string, members: ReworkMember[]): string {
  return [
    "You are Opus, re-planning the pending work of ONE repository in Jeremie's work queue (Jeremie: one-person studio owner, reading on his phone).",
    `Jeremie looked at everything pending for "${repo}" and said No, with this note:`,
    `"${note}"`,
    "Rework the plan so the next card he sees matches what he asked. Decide per item:",
    "  keep — leave it as is",
    "  reject — drop a proposal (proposals only)",
    "  revise — replace a proposal with a rescoped one: give title + a self-contained worker prompt (proposals only)",
    "  answer — answer a blocked task's question with text (blocked tasks only)",
    "  cancel — drop a task (only when his note clearly says to drop it)",
    "  close_pr — close a PR without merging (only when his note clearly says to drop it)",
    "  ask_opus — hand the item to the Opus resolver with a precise instruction (anything else: a PR to rework, a task to redo differently)",
    "Items marked HELD stay with Jeremie: keep them.",
    "",
    "## Items",
    ...members.map((m) => `- ${m.id} (${m.source}${m.blocked ? ", blocked" : ""}${m.held ? ", HELD" : ""}): ${clip(m.title, 120)} — ${clip(m.problem, 300)} · recommended now: ${clip(m.recommended, 60)}`),
    "",
    "Reply with ONLY this JSON object (no prose, no code fence):",
    '{"summary":"<one line: what you changed and why>","consent":false,"steps":[{"id":"<item id>","kind":"keep|reject|revise|answer|cancel|close_pr|ask_opus","why":"<short>","title":"<revise>","prompt":"<revise>","text":"<answer>","instruction":"<ask_opus>"}]}',
    'Set "consent": true only when his note tells you to drop, cancel or close work.',
  ].join("\n")
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "")

function toStep(v: unknown): ReworkStep | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const id = str(o.id, 300)
  const why = str(o.why, 300)
  if (!id) return null
  switch (o.kind) {
    case "keep": case "reject": case "cancel": case "close_pr": return { id, kind: o.kind, why }
    case "revise": {
      const prompt = str(o.prompt, 4000)
      return prompt ? { id, kind: "revise", title: str(o.title, 120), prompt, why } : null
    }
    case "answer": {
      const text = str(o.text, 500)
      return text ? { id, kind: "answer", text, why } : null
    }
    case "ask_opus": {
      const instruction = str(o.instruction, 500)
      return instruction ? { id, kind: "ask_opus", instruction, why } : null
    }
    default: return null
  }
}

/** Model text → output; null when it is not the JSON we asked for. Malformed steps are dropped. */
export function parseRework(text: string): ReworkOutput | null {
  const t = text.trim()
  const candidates = [t, ...[...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]!.trim())]
  const a = t.indexOf("{"), b = t.lastIndexOf("}")
  if (a >= 0 && b > a) candidates.push(t.slice(a, b + 1))
  for (const c of candidates) {
    let v: unknown
    try { v = JSON.parse(c) } catch { continue }
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    const o = v as Record<string, unknown>
    if (!Array.isArray(o.steps)) continue
    const steps = o.steps.map(toStep).filter((s): s is ReworkStep => !!s)
    return { summary: str(o.summary, 400), consent: o.consent === true, steps }
  }
  return null
}

export interface Refused { id: string; kind: ReworkKind; reason: string }

/** Which of Opus's steps may run: source rules, consent for drops, never a held PR, one step per item. */
export function reworkPolicy(out: ReworkOutput, members: ReworkMember[], note: string): { run: ReworkStep[]; refused: Refused[] } {
  const byId = new Map(members.map((m) => [m.id, m]))
  const run: ReworkStep[] = []
  const refused: Refused[] = []
  const done = new Set<string>()
  const drop = consents(note, out.consent)
  for (const step of out.steps) {
    const m = byId.get(step.id)
    const no = (reason: string) => refused.push({ id: step.id, kind: step.kind, reason })
    if (!m) { no("not on the card"); continue }
    if (m.held) { no("stays with Jeremie"); continue }
    if (done.has(step.id)) { no("one step per item"); continue }
    const why = allowed(step.kind, m, drop)
    if (why) { no(why); continue }
    done.add(step.id)
    run.push(step)
  }
  return { run, refused }
}

function allowed(kind: ReworkKind, m: ReworkMember, drop: boolean): string | null {
  switch (kind) {
    case "keep": case "ask_opus": return null
    case "reject": case "revise": return m.source === "proposal" ? null : `${kind} is for proposals`
    case "answer": return m.source === "task" && m.blocked ? null : "answer is for blocked tasks"
    case "cancel": return m.source !== "task" ? "cancel is for tasks" : drop ? null : "cancel needs Jeremie's words"
    case "close_pr": return m.source !== "pr" ? "close_pr is for PRs" : drop ? null : "closing needs Jeremie's words"
  }
}

export interface ReworkCounts { rejected?: number; rescoped?: number; answered?: number; cancelled?: number; closed?: number; handed?: number; kept?: number; failed?: number }

const WORDS: [keyof ReworkCounts, string][] = [
  ["rejected", "rejected"], ["rescoped", "rescoped"], ["answered", "answered"], ["cancelled", "cancelled"], ["closed", "closed"],
  ["handed", "handed to Opus"], ["kept", "kept"], ["failed", "failed"],
]

/** "Opus re-planned after your No: rejected 2, rescoped 1, kept 1". */
export function reworkSummary(c: ReworkCounts): string {
  const parts = WORDS.filter(([k]) => (c[k] ?? 0) > 0).map(([k, w]) => `${w} ${c[k]}`)
  return `Opus re-planned after your No: ${parts.join(", ") || "kept everything"}`
}
