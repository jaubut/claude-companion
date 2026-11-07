import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { toolsDir } from "./live-repo"
import { companionLog } from "./log"
import type { GhFn } from "./triage-pr"
import type { ExecFn, Row } from "./turso"

// The one call every Companion merge makes before `gh pr merge`: bin/pr-merge
// (wiring/brain-pr-merge.ts) and the tap, with the Opus resolver behind it
// (lib/triage-pr.ts). The hard stops live in claude-config's tools/pr-gate.ts;
// this reads the PR live and asks it the shepherd's question, with
// `approved: false`: neither caller can prove a human yet (a release route will).
// It takes no branch, so no head is exempt, sync/* included.
//
// Fails closed: a missing file, a bad export, a failed self-check, a throw or
// the budget all answer `gate_unavailable`, with no fallback. That is a 409, never
// a 503: iOS queues every 5xx with the card hidden and re-sends it, which would
// turn a refusal into a merge that fires when the gate comes back. A stop is a
// 403 named after it, because iOS shows `Refused: <error>` and nothing else.

export const GATE_BUDGET_MS = 20_000
/** GitHub's REST file list stops here without saying so. */
const FILES_CEILING = 3000
/** A reason names PR-controlled paths and goes back to the brain as data: JSON-encoded, and no longer than this. */
const REASON_MAX = 300
// Same as pr-shepherd.ts HOLD_LABEL.
const HOLD_LABEL = /do-not-merge|dnm|(^|[^a-z])wip([^a-z]|$)/i
const TOOL_FILES = ["pr-gate.ts", "dep-lane.ts", "pr-shepherd-policy.ts", "client-origin.ts"]

interface GateInput { paths: string[]; holdLabels: string[]; approved: boolean; pathsIncomplete?: boolean; taint?: { origin: string; sensitive: string[]; stamped: boolean; truncated?: boolean } }
interface GateStop { stop: string; action: string; reason: string }
/** The exports of the four claude-config modules. The self-check holds them to this. */
interface GateTools {
  gateVerdict(g: GateInput): GateStop | null
  liveGateInput(g: GateInput, paths: string[], holdLabels: string[], sensitive: RegExp): GateInput
  parseGatePaths(tsv: string): string[]
  SENSITIVE_RE: RegExp
  policy(origin: string, sink: string): string
  leastTrusted(origins: Array<string | null>): string
  taintedSensitive(paths: string[], diff: string | null, re: RegExp): { sensitive: string[]; truncated: boolean }
  isTainted(origin: string): boolean
}

export interface GateDeps { gh: GhFn; exec: ExecFn }
export interface GatePr { url: string }
export type GateResult = { ok: true; head: string } | { ok: false; status: number; error: string; extra: Record<string, unknown> }
export type MergeGateFn = (deps: GateDeps, pr: GatePr) => Promise<GateResult>
interface GateOpts { tools?: string; budgetMs?: number }

const unavailable = (detail: string): GateResult => ({ ok: false, status: 409, error: "gate_unavailable", extra: { detail } })

/**
 * Imported fresh when any of the four files changes, so a claude-config pull needs no restart.
 * ponytail: in process, so a sync hang can't be timed out, and a client-origin.ts change reaches
 * pr-shepherd-policy.ts's nested import only at the next restart. A subprocess if the gate ever does I/O or loops.
 */
async function loadTools(dir: string): Promise<GateTools | string> {
  const missing = TOOL_FILES.find((f) => !existsSync(join(dir, f)))
  if (missing) return `${missing} missing on this host`
  const v = Math.max(...TOOL_FILES.map((f) => statSync(join(dir, f)).mtimeMs))
  const mods = await Promise.all(TOOL_FILES.map((f) => import(`${join(dir, f)}?v=${v}`) as Promise<Partial<GateTools>>))
  return Object.assign({}, ...mods) as GateTools
}

/** Known answers, on every call: an older or broken gate refuses instead of passing what it can't see. */
function selfCheck(t: GateTools): boolean {
  try {
    const none = { holdLabels: [], approved: false }
    const human = (p: string): boolean => t.gateVerdict({ ...none, paths: [p] })?.stop === "human-merge-path"
    const auth = "server/lib/auth.ts"
    const tainted = t.gateVerdict({ ...none, paths: [auth], approved: true, taint: { origin: "web", sensitive: [auth], stamped: false } })
    return human("memory/x.md") && human("skills/x.md") && t.gateVerdict({ ...none, paths: ["server/lib/a.ts"] }) === null
      && tainted?.stop === "tainted-sensitive" && /human merge/i.test(tainted.reason)
      && t.policy("unknown", "merge-sensitive") === "DENY" && t.leastTrusted([]) === "unknown" && t.isTainted("unknown")
      && t.taintedSensitive([], null, t.SENSITIVE_RE).truncated && t.SENSITIVE_RE.test("memory/x.md")
      && t.parseGatePaths("a\tb\n").length === 2 && t.liveGateInput({ ...none, paths: [] }, ["a"], [], t.SENSITIVE_RE).paths.length === 1
  } catch {
    return false
  }
}

interface Head { url: string; sha: string; labels: string[] }
async function readHead(gh: GhFn, url: string): Promise<Head | null> {
  const r = await gh(["pr", "view", url, "--json", "url,headRefOid,labels"])
  if (r.code !== 0) return null
  try {
    const v = JSON.parse(r.stdout) as { url?: unknown; headRefOid?: unknown; labels?: unknown }
    if (typeof v.url !== "string" || typeof v.headRefOid !== "string" || !v.headRefOid || !Array.isArray(v.labels)) return null
    return { url: v.url, sha: v.headRefOid, labels: (v.labels as Array<{ name?: unknown }>).map((l) => String(l.name ?? "")) }
  } catch {
    return null
  }
}

async function check(deps: GateDeps, pr: GatePr, dir: string): Promise<GateResult> {
  const tools = await loadTools(dir)
  if (typeof tools === "string") return unavailable(tools)
  if (!selfCheck(tools)) return unavailable("gate self-check failed")
  const head = await readHead(deps.gh, pr.url)
  if (!head) return unavailable("couldn't read the PR head")
  // GitHub's own url from here on: a stale or lower-cased one finds no task, which reads as unknown, which is stricter.
  const ref = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(head.url)
  if (!ref) return unavailable("not a GitHub PR url")
  const files = await deps.gh(["api", "--paginate", `repos/${ref[1]}/pulls/${ref[2]}/files`, "--jq", '.[] | [.filename, .previous_filename // ""] | @tsv'])
  if (files.code !== 0) return unavailable("couldn't read the PR files")
  const paths = tools.parseGatePaths(files.stdout)
  // taintedSensitive compares against the diff's file count, so it takes one name per file; the verdict takes both sides of a rename.
  const newNames = files.stdout.split("\n").map((l) => l.split("\t")[0]!).filter(Boolean)
  if (!paths.length) return unavailable("empty file list")
  if (newNames.length >= FILES_CEILING) return unavailable("file list too long to trust")

  const { rows } = await deps.exec("SELECT origin FROM tasks WHERE dispatch_pr_url = ?", [head.url])
  const origin = tools.leastTrusted(rows.map((r: Row) => (r.origin ?? null) as string | null))
  let taint: GateInput["taint"]
  if (tools.isTainted(origin)) {
    const diff = await deps.gh(["pr", "diff", head.url])
    const t = { origin, stamped: false, ...tools.taintedSensitive(newNames, diff.code === 0 ? diff.stdout : null, tools.SENSITIVE_RE) }
    if (t.truncated || tools.policy(origin, "merge-sensitive") === "DENY") taint = t
  }

  // Read again: the files above may belong to a newer head than the one the caller would pin.
  const again = await readHead(deps.gh, pr.url)
  if (!again) return unavailable("couldn't read the PR head")
  if (again.sha !== head.sha) return { ok: false, status: 409, error: "head_moved", extra: {} }

  const holdLabels = again.labels.filter((l) => HOLD_LABEL.test(l))
  const stop = tools.gateVerdict(tools.liveGateInput({ paths, holdLabels, approved: false, taint }, paths, holdLabels, tools.SENSITIVE_RE))
  if (stop) return { ok: false, status: 403, error: stop.stop, extra: { action: stop.action, reason: stop.reason.slice(0, REASON_MAX), head: head.sha } }
  return { ok: true, head: head.sha }
}

/** Never throws: a throw reaches iOS as a 503 (triage-engine `unavailable`), which it queues. */
export async function mergeGate(deps: GateDeps, pr: GatePr, opts: GateOpts = {}): Promise<GateResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<GateResult>((resolve) => { timer = setTimeout(() => resolve(unavailable("gate timed out")), opts.budgetMs ?? GATE_BUDGET_MS) })
  try {
    return await Promise.race([check(deps, pr, opts.tools ?? toolsDir()), budget])
  } catch (err) {
    companionLog(`[merge-gate] ${pr.url}: ${(err as Error)?.name ?? "error"}`)
    return unavailable("gate error")
  } finally {
    clearTimeout(timer)
  }
}
