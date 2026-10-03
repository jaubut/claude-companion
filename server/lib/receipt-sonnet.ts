import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BOOKS_RULES, checkArithmetic, checkTaxRates, isPersonalPurpose, parseMoney } from "./receipt-checks"
import type { ChartEntry } from "./receipt-jev"
import type { ExpenseFields, QaIssue } from "./receipt-qa-store"

// Second QA pass: `claude -p --model sonnet` headless (Max OAuth), answer-only.
// Every work tool is disallowed, no MCP server is loaded, and the only thing
// it may do is Read the one receipt image we name. It returns
// {resolved, patch, reason}; `validatePatch` decides — in code — whether the
// patch may touch the books. Same shape as lib/orchestrator-brain.ts.

export const PATCH_ALLOWLIST = ["category_code", "category", "purpose", "reimbursable", "tps", "tvq", "tip", "subtotal", "date", "merchant", "notes"] as const
const MONEY_FIELDS = new Set(["tps", "tvq", "tip", "subtotal", "total"])
const MAX_VALUE = 500
const CALL_TIMEOUT_MS = 180_000
const SONNET_CWD = join(homedir(), ".claude-companion")
const DENY_TOOLS = ["Bash", "Edit", "MultiEdit", "Write", "Glob", "Grep", "Task", "Agent", "WebSearch", "WebFetch", "NotebookEdit", "TodoWrite"]
const SYSTEM = "You are a receipt bookkeeping reviewer. You may only Read the one receipt file named in the prompt; never run, edit, write or search anything. " +
  "Answer with ONE minified JSON object and nothing else: {\"resolved\":boolean,\"patch\":{\"field\":\"value\"},\"reason\":\"short reason\"}."

export interface SonnetAnswer { resolved: boolean; patch: Record<string, string>; reason: string }
export type SonnetRun = { kind: "ok"; text: string } | { kind: "error"; reason: string }
export type SonnetRunner = (prompt: string, imagePath: string) => Promise<SonnetRun>

/** Absolute path of the claude CLI (daemon PATH lacks ~/.local/bin). COMPANION_CLAUDE_BIN wins. */
export function resolveClaudeBin(): string | null {
  const override = process.env.COMPANION_CLAUDE_BIN?.trim()
  if (override) return existsSync(override) ? override : null
  const home = process.env.HOME || homedir()
  const candidates = [join(home, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude"]
  return candidates.find((p) => existsSync(p)) ?? Bun.which("claude")
}

export function sonnetArgs(bin: string, prompt: string, imagePath: string): string[] {
  const args = [bin, "-p", prompt, "--model", "sonnet", "--output-format", "json",
    "--append-system-prompt", SYSTEM, "--strict-mcp-config", "--disallowed-tools", ...DENY_TOOLS]
  if (imagePath) args.push("--allowed-tools", `Read(/${imagePath})`)
  return args
}

export const runSonnetCli: SonnetRunner = async (prompt, imagePath) => {
  const bin = resolveClaudeBin()
  if (!bin) return { kind: "error", reason: "claude binary not found" }
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(sonnetArgs(bin, prompt, imagePath), { stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: existsSync(SONNET_CWD) ? SONNET_CWD : undefined })
  } catch {
    return { kind: "error", reason: "spawn failed" }
  }
  const timer = setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, CALL_TIMEOUT_MS)
  try {
    const out = await new Response(proc.stdout as ReadableStream).text()
    const code = await proc.exited
    if (code !== 0) return { kind: "error", reason: `exit ${code}` }
    const start = out.indexOf('{"type"')
    const wrapper = JSON.parse(start >= 0 ? out.slice(start) : out) as { result?: unknown }
    return typeof wrapper.result === "string" ? { kind: "ok", text: wrapper.result } : { kind: "ok", text: "" }
  } catch {
    return { kind: "ok", text: "" }
  } finally {
    clearTimeout(timer)
  }
}

export function buildPrompt(input: { fields: ExpenseFields; issues: QaIssue[]; jev: Record<string, unknown> | null; chart: ChartEntry[]; imagePath: string }): string {
  const allowed = PATCH_ALLOWLIST.join(", ")
  return [
    "Review one saved expense receipt for Tech Lab Studio's books. A first pass flagged the issues below.",
    input.imagePath ? `Read the receipt file at ${input.imagePath} and compare it with the saved fields.` : "No receipt image is available; judge from the fields only.",
    "",
    "Saved fields:", JSON.stringify(input.fields),
    "", "Issues:", JSON.stringify(input.issues),
    "", "First-pass model verdict (GL code + confidence, grocery/meal/trip probabilities):", JSON.stringify(input.jev ?? null),
    "", BOOKS_RULES,
    "", "Expense chart (category_code options):", input.chart.map((c) => `${c.code} ${c.name}`).join("\n"),
    "",
    `Set resolved=true ONLY if every issue is settled by the receipt and the rules. patch may only use: ${allowed}. ` +
      "Money values as plain numbers with a dot (e.g. \"12.34\"); dates YYYY-MM-DD. Change total only when an issue says the amounts do not add up AND the receipt shows a different total. Never invent a trip or a client. " +
      "If anything needs Jeremie (where a meal was eaten, which client, a possible duplicate, an unreadable receipt) set resolved=false and patch {}.",
  ].join("\n")
}

/** Model text → answer. null = unparseable (→ needs_human). */
export function parseAnswer(text: string): SonnetAnswer | null {
  const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const a = s.indexOf("{"), b = s.lastIndexOf("}")
  if (a < 0 || b <= a) return null
  let v: unknown
  try { v = JSON.parse(s.slice(a, b + 1)) } catch { return null }
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (typeof o.resolved !== "boolean") return null
  const patchIn = o.patch ?? {}
  if (!patchIn || typeof patchIn !== "object" || Array.isArray(patchIn)) return null
  const patch: Record<string, string> = {}
  for (const [k, val] of Object.entries(patchIn as Record<string, unknown>)) {
    if (typeof val !== "string" && typeof val !== "number") return null
    patch[k] = String(val)
  }
  return { resolved: o.resolved, patch, reason: typeof o.reason === "string" ? o.reason.slice(0, 300) : "" }
}

export type PatchVerdict = { ok: true; patch: Record<string, string> } | { ok: false; why: string }

function validDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
}

/** Does code arithmetic prove the extracted total wrong (not a tax-inclusive subtotal)? */
function totalProvenWrong(f: ExpenseFields): boolean {
  return checkArithmetic(f).some((i) => i.field === "total" && i.problem.includes("≠ total"))
}

/**
 * Code-side gate for a model patch: allowlisted fields only (total only when
 * the arithmetic proves it wrong and the patched amounts add up), sane values,
 * a chart code, and the patched receipt must pass the arithmetic + tax checks.
 */
export function validatePatch(fields: ExpenseFields, patch: Record<string, string>, chart: ChartEntry[]): PatchVerdict {
  const allowed = new Set<string>(PATCH_ALLOWLIST)
  for (const [k, v] of Object.entries(patch)) {
    if (k === "total") {
      if (!totalProvenWrong(fields)) return { ok: false, why: "total change not proven by arithmetic" }
    } else if (!allowed.has(k)) {
      return { ok: false, why: `field ${k.slice(0, 40)} not allowed` }
    }
    if (v.length > MAX_VALUE || /[\x00-\x09\x0b-\x1f\x7f]/.test(v)) return { ok: false, why: `bad value for ${k}` }
    if (MONEY_FIELDS.has(k) && v !== "" && parseMoney(v) === null) return { ok: false, why: `${k} is not money` }
    if (k === "date" && !validDate(v)) return { ok: false, why: "bad date" }
    if (k === "category_code" && v !== "" && !chart.some((c) => c.code === v)) return { ok: false, why: "category_code not in chart" }
  }
  const after: ExpenseFields = { ...fields, ...patch }
  if (checkArithmetic(after).length || checkTaxRates(after).length) return { ok: false, why: "patched amounts still inconsistent" }
  if (!String(after.category_code ?? "").trim() && !isPersonalPurpose(after)) return { ok: false, why: "no GL code after patch" }
  return { ok: true, patch }
}
