import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { BodyComponentDetail } from "./body"
import type { InvestigationReport, InvestigationResult, RecommendedFix } from "./body-investigate"
import { BASE_DISALLOWED, readonlyArgs, readonlyCwd, readonlyEnv, runReadonlyClaude } from "./readonly-claude"
import { redactSecrets } from "./secret-redact"

// The investigator: one headless `claude -p` per component, READ-ONLY by
// construction via lib/readonly-claude.ts (verified against claude 2.1.289, see STATE.md):
//   --setting-sources project,local   user settings (auto mode, broad allows, hooks) never load;
//                                     cwd is ~/.claude-companion/investigate (empty, ours), so there
//                                     are no project settings either. One stable dir on purpose: the
//                                     CLI leaves an empty ~/.claude/projects/<cwd>/memory per cwd.
//   --settings {"disableAllHooks":true} --strict-mcp-config
//   --permission-mode dontAsk         anything not allowlisted is denied, never prompted
//   --tools Read,Grep,Glob,Bash       the only tools that exist in the session
//   --add-dir /                       without it even `ls` outside cwd is refused
//   --allowedTools <diagnostic prefixes>  --disallowedTools Edit Write NotebookEdit + secrets + mutating flags
// The prompt goes on stdin; the env is allowlisted (no Turso / Companion tokens).

export const INVESTIGATE_TIMEOUT_MS = 10 * 60_000
export const DEFAULT_MODEL = "sonnet"
const EVENTS_IN_PROMPT = 20
const TEXT_MAX = 600
const EVIDENCE_MAX = 10
const STEPS_MAX = 12

export const ALLOWED_TOOLS: readonly string[] = [
  "Read", "Grep", "Glob",
  "Bash(journalctl *)",
  "Bash(systemctl --user status *)", "Bash(systemctl --user status)",
  "Bash(systemctl --user cat *)",
  "Bash(systemctl --user list-timers *)", "Bash(systemctl --user list-timers)",
  "Bash(systemctl --user show *)",
  "Bash(launchctl print *)", "Bash(launchctl list *)", "Bash(launchctl list)",
  "Bash(ls *)", "Bash(ls)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(stat *)",
  "Bash(docker ps *)", "Bash(docker ps)", "Bash(docker logs *)", "Bash(docker inspect *)",
  "Bash(git log *)", "Bash(git log)", "Bash(git status *)", "Bash(git status)", "Bash(git diff *)", "Bash(git diff)",
  "Bash(which *)", "Bash(crontab -l)", "Bash(crontab -l *)",
  "Bash(ps *)", "Bash(ps)", "Bash(df *)", "Bash(df)", "Bash(du *)",
  "Bash(curl -s http://localhost*)", "Bash(curl -s http://127.0.0.1*)",
]

export const DISALLOWED_TOOLS: readonly string[] = [
  ...BASE_DISALLOWED,
  "Bash(journalctl *--vacuum*)", "Bash(journalctl *--rotate*)", "Bash(journalctl *--flush*)",
  "Bash(journalctl *--sync*)", "Bash(journalctl *--relinquish*)", "Bash(journalctl *--setup-keys*)", "Bash(journalctl *--update-catalog*)",
]

const SYSTEM =
  "You are a read-only diagnostician for Jeremie's personal infrastructure (a Mac and a Linux server, Zettlab). " +
  "You may only read files and run the allowlisted diagnostic commands; anything else is denied. Never try to fix, restart, " +
  "edit, write or delete anything — a human approves fixes later. Never print secrets or token values. " +
  "Finish with ONE JSON object and nothing after it."

// ── Known paths from the component id ────────────────────────────────────────

export interface KnownPaths {
  files: string[]
  commands: string[]
  /** The unit's working dir (plist WorkingDirectory, unit WorkingDirectory=, script dir). */
  cwd: string | null
  /** Git root above cwd, when there is one. */
  repo: string | null
}

export interface FsSeams {
  home: string
  uid: number
  exists: (p: string) => boolean
  read: (p: string) => string | null
}

export const realFs: FsSeams = {
  home: process.env.HOME || homedir(),
  uid: typeof process.getuid === "function" ? process.getuid() : 501,
  exists: existsSync,
  read: (p) => { try { return readFileSync(p, "utf8") } catch { return null } },
}

/** Component names go into suggested shell commands: keep them to a safe charset. */
export function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._@+-]/g, "")
}

function plistString(xml: string, key: string): string | null {
  const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  return m?.[1]?.trim() || null
}

function plistArgs(xml: string): string[] {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)
  return m ? [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!.trim()) : []
}

function unitValue(text: string, key: string): string | null {
  const m = new RegExp(`^\\s*${key}=\\s*(.+)$`, "m").exec(text)
  return m?.[1]?.trim() || null
}

/** First absolute path under home in a command line (the script a unit runs). */
function scriptDir(args: string[], home: string): string | null {
  const p = args.find((a) => a.startsWith(home + "/") && !a.endsWith("/bun") && !a.endsWith("/node") && !a.endsWith("/python3"))
  return p ? dirname(p) : null
}

function gitRoot(dir: string | null, fs: FsSeams): string | null {
  for (let d = dir; d && d !== "/" && d.startsWith(fs.home); d = dirname(d)) {
    if (fs.exists(join(d, ".git"))) return d
    if (d === fs.home) break
  }
  return null
}

function launchdPaths(label: string, fs: FsSeams): KnownPaths {
  const n = safeName(label)
  const candidates = [join(fs.home, "Library/LaunchAgents", `${n}.plist`), join(fs.home, "Library/LaunchAgents/disabled", `${n}.plist`),
    `/Library/LaunchAgents/${n}.plist`, `/Library/LaunchDaemons/${n}.plist`]
  const files = candidates.filter(fs.exists)
  let cwd: string | null = null
  for (const f of files) {
    const xml = fs.read(f)
    if (!xml) continue
    for (const k of ["StandardOutPath", "StandardErrorPath"]) {
      const p = plistString(xml, k)
      if (p && !files.includes(p)) files.push(p)
    }
    cwd ??= plistString(xml, "WorkingDirectory") ?? scriptDir(plistArgs(xml), fs.home)
  }
  return {
    files: files.length ? files : candidates.slice(0, 1),
    commands: [`launchctl print gui/${fs.uid}/${n}`, `launchctl list ${n}`],
    cwd, repo: null,
  }
}

function systemdPaths(name: string, kind: "timer" | "service", fs: FsSeams): KnownPaths {
  const n = safeName(name)
  const dir = join(fs.home, ".config/systemd/user")
  const svc = join(dir, `${n}.service`)
  const files = kind === "timer" ? [join(dir, `${n}.timer`), svc] : [svc]
  const unit = fs.read(svc)
  const exec = unit ? unitValue(unit, "ExecStart") : null
  const cwd = (unit ? unitValue(unit, "WorkingDirectory") : null) ?? (exec ? scriptDir(exec.split(/\s+/), fs.home) : null)
  const units = kind === "timer" ? `${n}.timer ${n}.service` : `${n}.service`
  return {
    files,
    commands: [`systemctl --user status ${units} --no-pager`, `systemctl --user cat ${n}.service`,
      `journalctl --user -u ${n}.service -n 100 --no-pager`, ...(kind === "timer" ? ["systemctl --user list-timers --all --no-pager"] : [])],
    cwd: cwd?.replace(/^%h/, fs.home) ?? null, repo: null,
  }
}

/** Unit/plist/log paths and diagnostic commands derived from the component id + kind. */
export function knownPaths(component: { id: string; kind: unknown; name: unknown }, fs: FsSeams = realFs): KnownPaths {
  const kind = String(component.kind ?? "")
  const name = String(component.name ?? component.id.split(":").slice(2).join(":"))
  let out: KnownPaths
  if (kind === "launchd") out = launchdPaths(name, fs)
  else if (kind === "systemd-timer") out = systemdPaths(name, "timer", fs)
  else if (kind === "systemd-service") out = systemdPaths(name, "service", fs)
  else if (kind === "docker") {
    const n = safeName(name)
    out = { files: [], commands: [`docker ps -a --filter name=${n}`, `docker logs --tail 100 ${n}`, `docker inspect ${n}`], cwd: null, repo: null }
  } else if (kind === "cron") out = { files: [], commands: ["crontab -l"], cwd: null, repo: null }
  else if (kind === "github-actions") {
    const local = join(fs.home, safeName(name))
    out = { files: fs.exists(local) ? [join(local, ".github/workflows")] : [], commands: [], cwd: fs.exists(local) ? local : null, repo: null }
  } else out = { files: [], commands: [], cwd: null, repo: null }
  out.repo = gitRoot(out.cwd, fs)
  return out
}

// ── Prompt ───────────────────────────────────────────────────────────────────

export interface InvestigationInput {
  detail: BodyComponentDetail
  paths: KnownPaths
}

export const OUTPUT_SCHEMA =
  '{"rootCause":"<one sentence>","evidence":["<fact you observed, with the file/command it came from>"],"confidence":0.0,' +
  '"severity":"low|med|high|critical","recommendedFix":{"summary":"<one line>","steps":["<concrete step>"],"risk":"low|med|high","reversible":true} or null,' +
  '"retire":false,"notes":"<anything else Jeremie should know>"}'

export function buildInvestigationPrompt(input: InvestigationInput): string {
  const { component, vitals, events } = input.detail
  const p = input.paths
  return [
    `Investigate why the Body monitor reports component ${component.id} as ${vitals?.state ?? "unknown"}.`,
    "The Body monitor is a 5-minute collector that probes every launchd agent, systemd unit, docker container, cron job and health URL on the Mac and on Zettlab and records state transitions.",
    "",
    "Component record:", JSON.stringify(component),
    "", "Latest vitals:", JSON.stringify(vitals),
    "", `Last ${EVENTS_IN_PROMPT} events (newest first):`, JSON.stringify(events.slice(0, EVENTS_IN_PROMPT)),
    "",
    "Known paths (may not all exist):", ...(p.files.length ? p.files.map((f) => `- ${f}`) : ["- (none derived)"]),
    "Suggested diagnostic commands:", ...(p.commands.length ? p.commands.map((c) => `- ${c}`) : ["- (none; use Read/Grep/Glob)"]),
    ...(p.cwd ? [`Working directory of the unit: ${p.cwd}${p.repo ? ` (git repo ${p.repo})` : ""}`] : []),
    "",
    "Instructions:",
    "- Find the root cause from evidence: read the unit/plist, its logs, its script, recent git history of its repo. Prefer facts over guesses.",
    "- Allowed Bash: journalctl, systemctl --user status|cat|list-timers|show, launchctl print|list, ls, cat, head, tail, stat, docker ps|logs|inspect, git log|status|diff (use `cd <dir> && git log …`), which, crontab -l, ps, df, du, curl -s http://localhost… / http://127.0.0.1…. Never `tail -f`, never pipe into files. Everything else is denied — don't retry a denied command.",
    "- If the component is obsolete (the app was uninstalled, a one-off job that should be removed, a helper that never runs by design), set retire=true and make the fix the clean removal/disable.",
    "- recommendedFix is a plan for a human-approved worker, not something you do. null when nothing should change (e.g. a false positive in the monitor — say so in rootCause).",
    "- confidence is 0-1. severity: critical = data loss or a core service down; high = a user-facing or scheduled job broken; med = degraded; low = cosmetic / unused.",
    "- Never include secret values (tokens, passwords, keys) in the output.",
    "",
    "Reply with ONLY this JSON object (no prose, no code fence):",
    OUTPUT_SCHEMA,
  ].join("\n")
}

// ── argv + env ───────────────────────────────────────────────────────────────

export function investigatorArgs(bin: string, model: string): string[] {
  return readonlyArgs(bin, { model, system: SYSTEM, tools: "Read,Grep,Glob,Bash", addDirs: ["/"], allowed: ALLOWED_TOOLS, disallowed: DISALLOWED_TOOLS })
}

/** Allowlisted child env: no Turso / Companion / broker tokens ever reach the investigator. */
export function investigatorEnv(env: Record<string, string | undefined> = process.env, home: string = realFs.home): Record<string, string> {
  return readonlyEnv(env, home)
}

// ── Runner ───────────────────────────────────────────────────────────────────

export type RunOutcome = { ok: true; result: InvestigationResult; raw: string } | { ok: false; error: string; raw?: string }
export type InvestigatorRunner = (prompt: string) => Promise<RunOutcome>

export function investigateModel(env: Record<string, string | undefined> = process.env): string {
  return env.COMPANION_INVESTIGATE_MODEL?.trim() || DEFAULT_MODEL
}

export function investigatorCwd(home: string = realFs.home): string {
  return readonlyCwd(home)
}

/** Spawn the real `claude -p` in the investigator's empty cwd. Never throws. */
export async function runInvestigatorCli(prompt: string, opts: { timeoutMs?: number; model?: string } = {}): Promise<RunOutcome> {
  const run = await runReadonlyClaude(prompt, {
    model: opts.model ?? investigateModel(), system: SYSTEM, tools: "Read,Grep,Glob,Bash", addDirs: ["/"], allowed: ALLOWED_TOOLS, disallowed: DISALLOWED_TOOLS,
  }, { timeoutMs: opts.timeoutMs ?? INVESTIGATE_TIMEOUT_MS, cwd: investigatorCwd() })
  if (!run.ok) return run
  const result = parseInvestigationResult(run.text)
  return result ? { ok: true, result, raw: run.text } : { ok: false, error: "unparseable investigator output", raw: redactSecrets(run.text).slice(0, 2000) }
}

// ── Output parsing ───────────────────────────────────────────────────────────

const str = (v: unknown, max = TEXT_MAX): string => (typeof v === "string" ? redactSecrets(v.replace(/\s+/g, " ").trim()).slice(0, max) : "")
const strList = (v: unknown, n: number): string[] => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, n) : [])

/** Candidate JSON texts: the whole thing, each fenced block, then the outermost {...}. */
function jsonCandidates(text: string): string[] {
  const t = text.trim()
  const out = [t]
  for (const m of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) out.push(m[1]!.trim())
  const a = t.indexOf("{"), b = t.lastIndexOf("}")
  if (a >= 0 && b > a) out.push(t.slice(a, b + 1))
  return out
}

function parseFix(v: unknown): RecommendedFix | null | undefined {
  if (v === null || v === undefined) return null
  if (typeof v !== "object" || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const summary = str(o.summary, 300)
  if (!summary) return undefined
  const risk = o.risk === "low" || o.risk === "high" ? o.risk : o.risk === "medium" ? "med" : o.risk === "med" ? "med" : "med"
  return { summary, steps: strList(o.steps, STEPS_MAX), risk, reversible: o.reversible === true }
}

function toResult(o: Record<string, unknown>): InvestigationResult | null {
  const rootCause = str(o.rootCause)
  if (!rootCause) return null
  let confidence = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? o.confidence : 0
  if (confidence > 1 && confidence <= 100) confidence /= 100
  confidence = Math.min(1, Math.max(0, confidence))
  const sev = String(o.severity ?? "").toLowerCase()
  const severity = sev === "low" || sev === "high" || sev === "critical" ? sev : sev === "medium" || sev === "med" ? "med" : "med"
  const recommendedFix = parseFix(o.recommendedFix)
  if (recommendedFix === undefined) return null
  return { rootCause, evidence: strList(o.evidence, EVIDENCE_MAX), confidence, severity, recommendedFix, retire: o.retire === true, notes: str(o.notes) }
}

/** Model text → result. Fenced and prose-wrapped JSON are accepted; anything else → null. */
export function parseInvestigationResult(text: string): InvestigationResult | null {
  for (const c of jsonCandidates(text)) {
    let v: unknown
    try { v = JSON.parse(c) } catch { continue }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const r = toResult(v as Record<string, unknown>)
      if (r) return r
    }
  }
  return null
}

// ── POST /api/body/investigate body ──────────────────────────────────────────

export type InvestigateBody =
  | { kind: "request"; request: { componentId: string; state: string | null; fromState: string | null; trigger: "forward" | "manual" } }
  | { kind: "report"; report: InvestigationReport }

const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const optStr = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)

type Parsed = { ok: true; report: InvestigationReport } | { ok: false; error: string }

function parseReport(v: unknown): Parsed {
  const bad = (error: string): Parsed => ({ ok: false, error })
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("report must be an object")
  const o = v as Record<string, unknown>
  const id = optStr(o.id, 64)
  const componentId = optStr(o.componentId, 200)
  const state = optStr(o.state, 32)
  if (!id || !ID_RE.test(id)) return bad("report.id invalid")
  if (!componentId || !state) return bad("report.componentId and report.state required")
  if (o.status !== "done" && o.status !== "failed") return bad("report.status must be done|failed")
  const finishedAt = typeof o.finishedAt === "number" && Number.isFinite(o.finishedAt) ? o.finishedAt : null
  if (finishedAt === null) return bad("report.finishedAt required")
  const result = o.result && typeof o.result === "object" && !Array.isArray(o.result) ? toResult(o.result as Record<string, unknown>) : null
  if (o.status === "done" && !result) return bad("report.result invalid")
  const attempt = typeof o.attempt === "number" && Number.isInteger(o.attempt) ? Math.min(Math.max(o.attempt, 1), 10) : 1
  const cwd = optStr(o.cwd, 500)
  return { ok: true, report: {
    id, componentId, host: optStr(o.host, 32) ?? "mac", state, status: o.status, attempt,
    startedAt: typeof o.startedAt === "number" && Number.isFinite(o.startedAt) ? o.startedAt : null, finishedAt,
    runOn: optStr(o.runOn, 32) ?? "peer", result: o.status === "done" ? result : null,
    error: o.status === "failed" ? str(o.error, 300) || "unknown error" : null,
    cwd: cwd?.startsWith("/") ? cwd : null, repo: o.repo === true,
  } }
}

/** `{component_id, state?, from_state?, trigger?}` or `{report}`; an error string for the 400. */
export function parseInvestigateBody(raw: unknown): InvestigateBody | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be a JSON object" }
  const o = raw as Record<string, unknown>
  if (o.report !== undefined) {
    const parsed = parseReport(o.report)
    return parsed.ok ? { kind: "report", report: parsed.report } : { error: parsed.error }
  }
  const componentId = optStr(o.component_id, 200)
  if (!componentId) return { error: "component_id required" }
  for (const k of ["state", "from_state"] as const) {
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "string") return { error: `${k} must be a string` }
  }
  return {
    kind: "request",
    request: { componentId, state: optStr(o.state, 32), fromState: optStr(o.from_state, 32), trigger: o.trigger === "manual" ? "manual" : "forward" },
  }
}

// ── Report text ──────────────────────────────────────────────────────────────

export function reportTurnText(componentId: string, r: InvestigationResult): string {
  const lines = [`🔍 ${componentId} — ${r.rootCause} (confidence ${Math.round(r.confidence * 100)}%)`]
  for (const e of r.evidence.slice(0, 6)) lines.push(`• ${e}`)
  if (r.retire) lines.push("Looks obsolete — the fix retires it.")
  const f = r.recommendedFix
  lines.push(f ? `Fix: ${f.summary} (${f.risk} risk, ${f.reversible ? "reversible" : "not reversible"})` : "No fix proposed.")
  return lines.join("\n")
}

export function failureTurnText(componentId: string, error: string, attempt: number): string {
  return `🔍 ${componentId} — investigation failed: ${error}${attempt >= 2 ? " (second failure; no retry for 12 h)" : " (will retry)"}`
}

export function proposalPrompt(c: { componentId: string; host: string; state: string; investigationId: string; cwd: string }, r: InvestigationResult): string {
  const f = r.recommendedFix!
  return [
    `Fix a Body component the auto-investigation flagged${r.retire ? " as obsolete (retire it)" : ""}.`,
    `Component: ${c.componentId} (host ${c.host}, state ${c.state})`,
    `Run on host: ${c.host} — the component lives there.`,
    `Working directory: ${c.cwd}`,
    `Root cause (confidence ${Math.round(r.confidence * 100)}%): ${r.rootCause}`,
    "Evidence:", ...r.evidence.map((e) => `- ${e}`),
    `Fix (${f.risk} risk, ${f.reversible ? "reversible" : "NOT reversible"}): ${f.summary}`,
    ...f.steps.map((s, i) => `${i + 1}. ${s}`),
    ...(r.notes ? [`Notes: ${r.notes}`] : []),
    "Rules: confirm the root cause still holds before changing anything; make the smallest change that fixes it; verify the component recovers (its probe or the next Body collection reads ok); report exactly what changed.",
    `Investigation: ${c.investigationId}`,
  ].join("\n")
}
