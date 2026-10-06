import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { addDays } from "./my-tasks"

// Tasks agent (PRJ-CT4M WP5) — the deterministic proposal rules, pure:
//   slip   → a task whose date slipped >= SLIP_MIN times: "reschedule or drop"
//   assign → an unassigned open task matching a pm-assign.py agent route: "assign to agent:<x>"
//   merge  → exact / near-duplicate open tasks in the same note: "merge"
//   split  → a vague task (> VAGUE_WORDS words, doesn't open with an action verb): "split into subtasks"
// No model call here. Contract: docs/tasks-agent-api.md.

export const SLIP_MIN = 2
export const VAGUE_WORDS = 12
export const NEAR_JACCARD = 0.8
export const NEAR_EDIT_RATIO = 0.9
/** A slip proposal re-appears after a decision only once the date slipped this many more times. */
export const SLIP_REPROPOSE = 2
export const RESCHEDULE_DAYS = 7

export type ProposalKind = "reschedule" | "assign" | "merge" | "split"

/** An open task in the agent's scope: Jeremie's own, or unassigned. */
export interface ScopeTask {
  id: string
  noteId: string
  parentId: string | null
  text: string
  description: string | null
  due: string | null
  position: number
  /** null = unassigned (NULL or ''). */
  assignee: string | null
  mine: boolean
  project: string
  folder: string | null
}

export interface Proposal {
  id: string
  kind: ProposalKind
  title: string
  detail: string
  /** The tasks it touches; for merge [keep, duplicate]. */
  taskIds: string[]
  project: string
  /** Kind-specific: reschedule {slips, suggestedDue} · assign {assignee, rule} · merge {keepId, duplicateId, match} · split {words}. */
  suggestion: Record<string, unknown>
  /** What a stored decision is matched against (see hiddenBy). */
  version: string
}

export interface DueChange { taskId: string; from: string | null; to: string | null }

// ── text helpers ─────────────────────────────────────────────────────────────

/** Lowercase, accents stripped, punctuation → space, whitespace collapsed. */
export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean)

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]!
}

/** "exact" (same normalized text), "near" (token Jaccard >= 0.8 on 4+ tokens, or edit ratio >= 0.9), else null. */
export function duplicateMatch(a: string, b: string): "exact" | "near" | null {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return null
  if (na === nb) return "exact"
  // "Invoice 1041" vs "Invoice 1042", "[Week 3]" vs "[Week 4]": a different number is a different task.
  const nums = (x: string): string => (x.match(/\d+/g) ?? []).join(" ")
  if (nums(na) !== nums(nb)) return null
  const ta = new Set(na.split(" "))
  const tb = new Set(nb.split(" "))
  if (ta.size >= 4 && tb.size >= 4) {
    const inter = [...ta].filter((t) => tb.has(t)).length
    if (inter / (ta.size + tb.size - inter) >= NEAR_JACCARD) return "near"
  }
  const longest = Math.max(na.length, nb.length)
  if (longest <= 160 && longest >= 8 && 1 - levenshtein(na, nb) / longest >= NEAR_EDIT_RATIO) return "near"
  return null
}

// Imperative verbs (EN + FR, accents stripped by normalizeText) a concrete task opens with.
export const ACTION_VERBS: ReadonlySet<string> = new Set([
  "add", "ask", "book", "build", "buy", "call", "cancel", "change", "check", "clean", "close", "confirm", "create", "deliver", "deploy",
  "design", "draft", "edit", "email", "export", "file", "finish", "fix", "follow", "get", "install", "invoice", "make", "merge",
  "migrate", "move", "order", "pay", "plan", "post", "prepare", "print", "publish", "record", "refactor", "remove", "rename", "renew",
  "reply", "review", "schedule", "send", "set", "setup", "ship", "shoot", "sign", "submit", "test", "text", "update", "upload", "write",
  "connect", "contact", "draw", "find", "help", "implement", "integrate", "launch", "organize", "port", "redraw", "research", "translate",
  "acheter", "ajouter", "annuler", "appeler", "changer", "commander", "confirmer", "creer", "envoyer", "ecrire", "faire", "facturer",
  "finir", "installer", "livrer", "mettre", "monter", "payer", "planifier", "preparer", "publier", "relancer", "renouveler", "repondre",
  "reserver", "reviser", "signer", "soumettre", "tourner", "verifier",
])

/** Leading "[Week 3 — copy]" style tags are labels, not the task. */
const stripTags = (s: string): string => s.replace(/^\s*(?:\[[^\]]*\]\s*)+/, "")

/** > VAGUE_WORDS words and the first word (after any leading [tags]) is no action verb. */
export function isVague(text: string): boolean {
  const ws = words(stripTags(text))
  if (ws.length <= VAGUE_WORDS) return false
  const first = normalizeText(ws[0] ?? "").split(" ")[0] ?? ""
  return !ACTION_VERBS.has(first)
}

// ── pm-assign.py routes (read-only) ─────────────────────────────────────────

export interface AssignRule { pattern: string; re: RegExp; agent: string }

export function pmAssignPath(env: Record<string, string | undefined> = process.env): string {
  return env.COMPANION_PM_ASSIGN || join(homedir(), ".claude", "tools", "pm-assign.py")
}

/** The ROUTES list of pm-assign.py → JS regexes (case-insensitive, first match wins). Unparseable entries are skipped. */
export function parseAssignRules(source: string): AssignRule[] {
  const start = source.indexOf("ROUTES")
  if (start < 0) return []
  const open = source.indexOf("[", source.indexOf("=", start))
  const close = source.indexOf("\n]", open)
  if (open < 0 || close < 0) return []
  const block = source.slice(open, close)
  const rules: AssignRule[] = []
  for (const m of block.matchAll(/\(\s*r"((?:[^"\\]|\\.)*)"\s*,\s*"([\w:-]+)"\s*\)/g)) {
    try {
      rules.push({ pattern: m[1]!, re: new RegExp(m[1]!, "i"), agent: m[2]! })
    } catch { /* a Python-only construct: skip that rule */ }
  }
  return rules
}

let ruleCache: { path: string; rules: AssignRule[] } | null = null

/** Rules from the live pm-assign.py, read once per process. Missing file → [] (no assign proposals). */
export function loadAssignRules(path = pmAssignPath()): AssignRule[] {
  if (ruleCache?.path === path) return ruleCache.rules
  let rules: AssignRule[] = []
  try { rules = parseAssignRules(readFileSync(path, "utf8")) } catch { /* not on this host */ }
  ruleCache = { path, rules }
  return rules
}

/** pm-assign's assign_for: first matching route; "human" → null (no proposal). */
export function agentFor(text: string, rules: AssignRule[]): { assignee: string; rule: string } | null {
  for (const r of rules) {
    if (!r.re.test(text)) continue
    return r.agent === "human" || r.agent.startsWith("human:") ? null : { assignee: r.agent.startsWith("agent:") ? r.agent : `agent:${r.agent}`, rule: r.pattern }
  }
  return null
}

// ── slip history ─────────────────────────────────────────────────────────────

/** A slip = a date pushed later, or dropped. A first date (from null) or a date pulled earlier is not one. */
export const isSlip = (c: DueChange): boolean => c.from !== null && (c.to === null || c.to > c.from)

export function slipCounts(changes: DueChange[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of changes) if (isSlip(c)) out.set(c.taskId, (out.get(c.taskId) ?? 0) + 1)
  return out
}

// ── the rules ────────────────────────────────────────────────────────────────

const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface RuleInput {
  tasks: ScopeTask[]
  slips: Map<string, number>
  rules: AssignRule[]
  today: string
}

export function slipProposals(i: RuleInput): Proposal[] {
  const out: Proposal[] = []
  for (const t of i.tasks) {
    const n = i.slips.get(t.id) ?? 0
    if (!t.mine || n < SLIP_MIN) continue
    const suggestedDue = addDays(i.today, RESCHEDULE_DAYS)
    out.push({
      id: `slip:${t.id}`, kind: "reschedule", title: `Reschedule or drop: ${clip(t.text)}`,
      detail: `The date moved ${n} times${t.due ? ` (now ${t.due})` : ""}. Pick a date you'll keep, or drop the date.`,
      taskIds: [t.id], project: t.project, suggestion: { slips: n, due: t.due, suggestedDue }, version: String(n),
    })
  }
  return out
}

export function assignProposals(i: RuleInput): Proposal[] {
  const out: Proposal[] = []
  for (const t of i.tasks) {
    if (t.assignee !== null) continue
    const hit = agentFor(t.text, i.rules)
    if (!hit) continue
    out.push({
      id: `assign:${t.id}`, kind: "assign", title: `Assign to ${hit.assignee}: ${clip(t.text)}`,
      detail: `Unassigned. Matches the pm-assign route ${hit.rule}. Accepting sets the assignee only; nothing is queued.`,
      taskIds: [t.id], project: t.project, suggestion: { assignee: hit.assignee, rule: hit.rule }, version: `${hit.assignee}|${normalizeText(t.text)}`,
    })
  }
  return out
}

export function mergeProposals(i: RuleInput): Proposal[] {
  const parents = new Set(i.tasks.map((t) => t.parentId).filter((p): p is string => !!p))
  const byNote = new Map<string, ScopeTask[]>()
  for (const t of i.tasks) if (!parents.has(t.id)) byNote.set(t.noteId, [...(byNote.get(t.noteId) ?? []), t])
  const out: Proposal[] = []
  for (const list of byNote.values()) {
    list.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
    const merged = new Set<string>()
    for (let a = 0; a < list.length; a++) {
      const keep = list[a]!
      if (merged.has(keep.id)) continue
      for (let b = a + 1; b < list.length; b++) {
        const dup = list[b]!
        if (merged.has(dup.id)) continue
        const match = duplicateMatch(keep.text, dup.text)
        if (!match) continue
        merged.add(dup.id)
        out.push({
          id: `merge:${keep.id}:${dup.id}`, kind: "merge", title: `Merge duplicate: ${clip(dup.text)}`,
          detail: `${match === "exact" ? "Same text" : "Nearly the same text"} as "${clip(keep.text, 60)}" in ${keep.project}. Accepting closes the duplicate and keeps the first.`,
          taskIds: [keep.id, dup.id], project: keep.project, suggestion: { keepId: keep.id, duplicateId: dup.id, match },
          version: `${normalizeText(keep.text)}|${normalizeText(dup.text)}`,
        })
      }
    }
  }
  return out
}

export function splitProposals(i: RuleInput): Proposal[] {
  const parents = new Set(i.tasks.map((t) => t.parentId).filter((p): p is string => !!p))
  const out: Proposal[] = []
  for (const t of i.tasks) {
    if (!t.mine || parents.has(t.id) || !isVague(t.text)) continue
    out.push({
      id: `split:${t.id}`, kind: "split", title: `Split into subtasks: ${clip(t.text)}`,
      detail: `${words(t.text).length} words and no clear first action. Accepting asks for 2-5 subtasks you confirm before anything is written.`,
      taskIds: [t.id], project: t.project, suggestion: { words: words(t.text).length }, version: normalizeText(t.text),
    })
  }
  return out
}

export function allProposals(i: RuleInput): Proposal[] {
  return [...slipProposals(i), ...mergeProposals(i), ...assignProposals(i), ...splitProposals(i)]
}

/** A stored decision hides a proposal while its version still matches (a slip: until it slipped SLIP_REPROPOSE more times). */
export function hiddenBy(p: Proposal, decided: { version: string } | undefined): boolean {
  if (!decided) return false
  if (p.kind === "reschedule") return Number(p.version) - Number(decided.version) < SLIP_REPROPOSE
  return p.version === decided.version
}
