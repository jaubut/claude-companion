import { type BodyComponentDetail } from "./body"
import { type KnownPaths, buildInvestigationPrompt } from "./body-investigator"
import { type Autonomy, type ResolverActionKind, resolverActions } from "./resolver"
import { type ActionKind, KIND_HELP, type SourceItem, allowedActions } from "./triage"

// The Opus resolver's prompts (lib/resolver.ts decides what runs; this file
// only says what Opus may propose and what JSON it returns). Evidence the
// server gathered (Turso task / note / activity, `gh pr view|diff|checks`) is
// inlined; the run itself is read-only (wiring/resolver.ts → readonly-claude).

export interface EvidenceBlock { label: string; text: string }

export interface ResolverContext {
  /** Local checkout the run reads (its cwd), or null. */
  repo: string | null
  /** Extra readable roots (memory files). */
  readableDirs: string[]
  blocks: EvidenceBlock[]
  /** PR only. */
  sensitivePaths: string[]
  sensitive: boolean
  rescuedBefore: boolean
  /** PR only: what a fix run needs. */
  pr?: { head: string; base: string; number: number; title: string; taskText: string }
}

export interface ResolverJob { autonomy: Autonomy; instruction: string | null }

export const BLOCK_MAX = 12_000

const ACTION_HELP: Record<ResolverActionKind, string> = {
  none: '{"kind":"none"} — do nothing yourself; Jeremie gets your card',
  answer: '{"kind":"answer","text":"<the full answer the worker gets>"} — answer the blocker; the task restarts with it',
  requeue: '{"kind":"requeue"} — run the task again as is (the failure looks transient)',
  cancel: '{"kind":"cancel"} — drop the task',
  merge: '{"kind":"merge"} — squash-merge the PR',
  close_pr: '{"kind":"close_pr","reason":"<why, posted as a PR comment>"} — close the PR without merging',
  fix: '{"kind":"fix","instructions":"<precise, self-contained instructions for a builder working on the PR branch>"} — a fix run on the PR branch (never main)',
  approve: '{"kind":"approve"} — start the proposed work',
  reject: '{"kind":"reject","reason":"<why>"} — drop the proposal',
  revise: '{"kind":"revise","title":"<short title>","prompt":"<the rescoped, self-contained worker prompt>"} — replace the proposal with a rescoped one',
}

const ROLE = [
  "You are Opus, the resolver in Jeremie's work queue. Jeremie is a one-person studio owner (video production + software, Montréal) reading cards on his phone.",
  "An item is about to reach his \"needs you\" list. Work it as far as you safely can FROM EVIDENCE: the facts below, the repository (read-only),",
  "the memory files and STATE.md. Your output is a proposal; the server's policy decides what actually runs.",
]

const SOURCE_RULES: Record<string, string[]> = {
  task_blocked: [
    "A dispatch worker stopped and asked a question (the blocker). Decide whether the answer follows from evidence: the repo code, STATE.md decisions, the project note, earlier answers in the task description ([unblock …] lines), memory files.",
    "Answer it yourself (action answer, confidence ≥ 0.8, needsJeremie false, why \"none\") only when the evidence settles it. Quote where it comes from in the analysis.",
    "needsJeremie = true, with why = preference | money | client_wording | irreversible | ambiguous | insufficient_evidence, for a genuine preference, anything about money, client-facing wording, or anything irreversible. Then still give your best answer as action answer — it becomes the recommended option on his card.",
  ],
  task_failed: [
    "A dispatch run failed. Read the failure and the task. requeue only when the cause is transient (timeout, rate limit, flaky network, a since-fixed dependency); otherwise none, and explain what must change.",
  ],
  pr: [
    "The PR shepherd parked this pull request for Jeremie (the reason is below). Do the review he would otherwise ask for: read the diff, the CI checks and the task.",
    "Fill review: whatChanged, risk, prodFailure (what could go wrong in production), testsCover (do tests cover the risky part?), problems (concrete defects only), verdict safe | changes | unsafe.",
    "category: stale (no activity, no longer relevant) | superseded (another PR replaces it) | task_done (the task is done/cancelled elsewhere) | safe | needs_changes | ci_failing | ambiguous.",
    "Sensitive PRs (auth, payment, schema, secrets, migrations, CI config) are NEVER merged without Jeremie: if your review finds problems, action fix with precise instructions; otherwise none and recommend Merge on the card with the reason it is safe.",
    "Non-sensitive: close_pr for stale / superseded / task_done (say why); fix for one deeper rescue attempt when CI keeps failing and you can see the cause; none when it is truly ambiguous.",
  ],
  proposal: [
    "The brain (or the Body investigator) proposes this work and waits for Jeremie's OK. Sanity-check it: is it still needed (check the repo / recent tasks), is the scope right, is it a duplicate of another pending proposal or an open task?",
    "category: duplicate | stale | done (already done) | needed | rescope | ambiguous. reject a duplicate / stale / done one with the reason; otherwise none and recommend approve or reject on the card.",
  ],
}

function sourceKey(src: SourceItem): string {
  const ref = src.ref
  return ref.source === "task" ? `task_${ref.status}` : ref.source
}

function cardKinds(src: SourceItem): ActionKind[] {
  return [...allowedActions(src), "ask_opus"]
}

export const OUTPUT_SCHEMA =
  '{"analysis":"<3-8 short lines: what is going on and the evidence (file / command / note it came from)>",' +
  '"summary":"<one line for the card: what you did or recommend, and why>","confidence":0.0,"needsJeremie":true,' +
  '"why":"none|preference|money|client_wording|irreversible|ambiguous|insufficient_evidence","category":"<see rules>",' +
  '"action":{"kind":"none"},"review":null,' +
  '"card":{"title":"<= 80 chars","problem":"1-2 short sentences","action":"1 sentence: what you recommend","options":[{"label":"<= 32 chars, verb first","detail":"optional <= 90 chars","action":{}}]}}'

function block(b: EvidenceBlock): string {
  const t = b.text.trim()
  return `### ${b.label}\n${t.length > BLOCK_MAX ? `${t.slice(0, BLOCK_MAX)}\n…(truncated)` : t}`
}

export function buildResolverPrompt(src: SourceItem, ctx: ResolverContext, job: ResolverJob): string {
  const actions = resolverActions(src)
  const facts = Object.entries(src.facts).filter(([, v]) => v.trim()).map(([k, v]) => `${k}: ${v.slice(0, 2000)}`)
  return [
    ...ROLE,
    "",
    ...(job.autonomy === "elevated"
      ? [`Jeremie handed this item back to you himself${job.instruction ? ` with this instruction: "${job.instruction}"` : " (no instruction: finish it the way you recommend)"}.`,
        "Follow it: pick the action that does what he asked. \"do it\" = execute your recommended action. Set needsJeremie false when his words settle it.", ""]
      : []),
    `## Item (${src.source})`,
    `title: ${src.title}`,
    ...(src.project ? [`project: ${src.project}`] : []),
    ...(src.url ? [`url: ${src.url}`] : []),
    ...facts,
    ...(ctx.sensitive ? [`SENSITIVE: touches ${ctx.sensitivePaths.join(", ") || "a sensitive area (shepherd)"} — write the threat-model review.`] : []),
    ...(ctx.rescuedBefore ? ["Opus already ran one rescue on this PR; do not propose another fix unless Jeremie asked."] : []),
    "",
    "## Rules",
    ...(SOURCE_RULES[sourceKey(src)] ?? []),
    `- Read-only. ${ctx.repo ? `The cwd is the repository ${ctx.repo} (no cd): Read/Grep/Glob, git log|show|diff|status, ls, cat, head, tail, grep, wc, jq; gh pr view|diff|checks <url>, gh pr list, gh run view <id> (read-only).` : "No local checkout of this project here: use the evidence below."}`,
    ...(ctx.readableDirs.length ? [`- Memory files (Jeremie's standing rules and decisions) are readable under: ${ctx.readableDirs.join(", ")}. Read the index (MEMORY.md) first when a preference might be recorded.`] : []),
    "- Never edit, write, push, merge, close or comment yourself — the server does what your action says, if its policy allows. Never print secrets.",
    "- Write in the language the item is written in (French or English). Plain words, no ids or hashes on the card.",
    "",
    "## action — exactly one of",
    ...actions.map((k) => `  ${ACTION_HELP[k]}`),
    "",
    "## card — what Jeremie sees if it reaches him: 2 to 4 options, YOUR recommendation first; each option's action is one of",
    ...cardKinds(src).map((k) => `  ${KIND_HELP[k]}`),
    "",
    ...(ctx.blocks.length ? ["## Evidence", ...ctx.blocks.map(block), ""] : []),
    "Reply with ONLY this JSON object (no prose, no code fence):",
    OUTPUT_SCHEMA,
  ].join("\n")
}

/** Body failed twice: the investigator's prompt, run by Opus with more time and the earlier errors. */
export function buildBodyResolverPrompt(detail: BodyComponentDetail, paths: KnownPaths, errors: string[]): string {
  return [
    "You are Opus, called in after the automatic read-only diagnosis of this component failed twice" +
      (errors.length ? ` (errors: ${errors.map((e) => e.slice(0, 200)).join(" | ")})` : "") + ".",
    "You have more time than it had (up to 20 min). Go deeper: read the unit, its script and its repo, its full logs; check whether the component is still meant to exist.",
    "If the right outcome is a plain explanation (false positive, expected state, nothing to fix), set recommendedFix to null and explain it in rootCause + notes.",
    "",
    buildInvestigationPrompt({ detail, paths }),
  ].join("\n")
}
