import { basename } from "node:path"
import { BASE_DISALLOWED, type ReadonlyRun, type ReadonlySpec, readonlyArgs, runReadonlyClaude } from "./readonly-claude"
import { redactSecrets } from "./secret-redact"

// The front door's quick_look route: a factual question about one repo
// ("is chantalmasse.com on the latest nuxt?") answered by a READ-ONLY headless
// `claude -p` IN that repo. Same hardened runner as the Body investigator, with
// `--setting-sources ""`: no settings file loads, so the repo's own
// .claude/settings*.json allow rules never apply (verified 2.1.289: git log /
// status, ls | grep, Read ok; touch, git branch <name>, git commit, npm install,
// `> file`, curl -X POST all denied). Not an --add-dir from the empty cwd: dontAsk
// denies every `cd <repo> && …` compound. Read-only network for "latest
// version": `npm view`, `npm outdated`, `curl -s` GETs to registry.npmjs.org /
// api.github.com.

export const QUICK_LOOK_TIMEOUT_MS = 60_000
export const QUICK_LOOK_MODEL = "sonnet"
const TEXT_MAX = 600
const FACTS_MAX = 8

export const QUICK_LOOK_ALLOWED: readonly string[] = [
  "Read", "Grep", "Glob",
  "Bash(git log *)", "Bash(git log)", "Bash(git status *)", "Bash(git status)", "Bash(git diff *)", "Bash(git diff)",
  "Bash(git show *)", "Bash(git show)", "Bash(git describe *)", "Bash(git describe)", "Bash(git rev-parse *)",
  "Bash(git ls-files *)", "Bash(git ls-files)", "Bash(git remote -v)", "Bash(git branch --show-current)", "Bash(git branch -a)",
  "Bash(git tag --list*)", "Bash(git tag -l*)",
  "Bash(ls *)", "Bash(ls)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(stat *)", "Bash(wc *)", "Bash(which *)", "Bash(jq *)",
  "Bash(grep *)", "Bash(sort *)",
  "Bash(npm view *)", "Bash(npm ls *)", "Bash(npm ls)", "Bash(npm outdated *)", "Bash(npm outdated)",
  "Bash(curl -s https://registry.npmjs.org/*)", "Bash(curl -s https://api.github.com/*)",
]

export const QUICK_LOOK_DISALLOWED: readonly string[] = [
  ...BASE_DISALLOWED,
  // npm subcommands that write, whatever follows an allowlisted prefix.
  "Bash(npm * install*)", "Bash(npm * update*)", "Bash(npm * publish*)", "Bash(npm * --write*)",
  "Bash(git * --exec*)", "Bash(curl * -K*)", "Bash(curl * --config*)",
]

const SYSTEM =
  "You are a read-only code inspector for Jeremie's repositories. You may only read files and run the allowlisted read-only " +
  "commands; anything else is denied. Never edit, write, install, commit, push or delete anything. Never print secrets or token " +
  "values. Be fast: answer in as few tool calls as possible. Finish with ONE JSON object and nothing after it."

export function quickLookModel(env: Record<string, string | undefined> = process.env): string {
  return env.COMPANION_QUICKLOOK_MODEL?.trim() || QUICK_LOOK_MODEL
}

/** The repo is the cwd (runQuickLookCli), never an extra root. */
export function quickLookSpec(model: string): ReadonlySpec {
  return { model, system: SYSTEM, settingSources: "", tools: "Read,Grep,Glob,Bash", addDirs: [], allowed: QUICK_LOOK_ALLOWED, disallowed: QUICK_LOOK_DISALLOWED }
}

export function quickLookArgs(bin: string, model: string): string[] {
  return readonlyArgs(bin, quickLookSpec(model))
}

export interface QuickLookInput {
  question: string
  repo: string
  projectTitle: string
  noteId: string | null
  recent: { role: string; text: string }[]
}

export const OUTPUT_SCHEMA =
  '{"answer":"<1-3 sentence direct answer>","facts":["<fact, with the file or command it came from>"],' +
  '"needsChange":false,"proposal":null or {"title":"<short task title>","prompt":"<self-contained worker prompt>"}}'

export function buildQuickLookPrompt(q: QuickLookInput): string {
  const recent = q.recent.slice(-4).map((t) => `${t.role}: ${t.text.replace(/\s+/g, " ").slice(0, 240)}`)
  return [
    `Answer Jeremie's question about the code repository at ${q.repo} (project: ${q.projectTitle}${q.noteId ? `, note ${q.noteId}` : ""}).`,
    "", "Question:", q.question,
    ...(recent.length ? ["", "Recent thread (context only):", ...recent] : []),
    "",
    "Rules:",
    `- Read-only. Read/Grep/Glob work under ${q.repo}. Bash runs in the repo (it is the cwd — no cd): git log|status|diff|show|describe|rev-parse|ls-files, ls, cat, head, tail, stat, wc, which, jq, grep, sort (pipes allowed between these); \`npm view <pkg> version\`, \`npm ls\`, \`npm outdated\`; \`curl -s https://registry.npmjs.org/<pkg>/latest\` and \`curl -s https://api.github.com/…\` (GET only). Everything else is denied — don't retry a denied command.`,
    "- Be quick: at most ~6 tool calls. Installed versions come from the lockfile (bun.lock, package-lock.json, pnpm-lock.yaml, yarn.lock) or package.json; \"latest\" comes from the registry.",
    "- Facts only, each with where it came from. If you cannot tell, say so.",
    "- needsChange = true only when the facts show something should change for what was asked (e.g. asked whether it is on the latest version and it is not). Then proposal = a short title + a self-contained prompt a worker can run in that repo. Otherwise proposal = null.",
    "- Never include secret values.",
    "",
    "Reply with ONLY this JSON object (no prose, no code fence):",
    OUTPUT_SCHEMA,
  ].join("\n")
}

export interface QuickLookResult {
  answer: string
  facts: string[]
  needsChange: boolean
  proposal: { title: string; prompt: string } | null
}

const str = (v: unknown, max = TEXT_MAX): string => (typeof v === "string" ? redactSecrets(v.replace(/[ \t]+/g, " ").trim()).slice(0, max) : "")

function candidates(text: string): string[] {
  const t = text.trim()
  const out = [t]
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(m[1]!.trim())
  const a = t.indexOf("{"), b = t.lastIndexOf("}")
  if (a >= 0 && b > a) out.push(t.slice(a, b + 1))
  return out
}

/** Model text → result; fenced / prose-wrapped JSON accepted. Plain prose → an answer with no facts. */
export function parseQuickLook(text: string): QuickLookResult | null {
  for (const c of candidates(text)) {
    let v: unknown
    try { v = JSON.parse(c) } catch { continue }
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    const o = v as Record<string, unknown>
    const answer = str(o.answer)
    if (!answer) continue
    const facts = Array.isArray(o.facts) ? o.facts.map((f) => str(f, 300)).filter(Boolean).slice(0, FACTS_MAX) : []
    const p = o.proposal && typeof o.proposal === "object" ? (o.proposal as Record<string, unknown>) : null
    const proposal = p && str(p.prompt, 4000) ? { title: str(p.title, 120) || answer.slice(0, 80), prompt: str(p.prompt, 4000) } : null
    return { answer, facts, needsChange: o.needsChange === true && !!proposal, proposal: o.needsChange === true ? proposal : null }
  }
  const prose = str(text, 1200)
  return prose ? { answer: prose, facts: [], needsChange: false, proposal: null } : null
}

export const ackText = (repo: string): string => `🔎 checking ${basename(repo)}…`

export function answerTurnText(repo: string, r: QuickLookResult): string {
  return [`🔎 ${basename(repo)} — ${r.answer}`, ...r.facts.map((f) => `• ${f}`)].join("\n")
}

export function failureText(repo: string, error: string): string {
  return `🔎 ${basename(repo)} — couldn't check (${error}). Ask again, or say "dispatch it" to have a worker look.`
}

export type QuickLookRunner = (prompt: string, repo: string) => Promise<ReadonlyRun>

export const runQuickLookCli: QuickLookRunner = (prompt, repo) =>
  runReadonlyClaude(prompt, quickLookSpec(quickLookModel()), { timeoutMs: QUICK_LOOK_TIMEOUT_MS, cwd: repo })
