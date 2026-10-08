import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DashboardKeyMissing, DashboardUnreachable, type DashReply, fetchReceiptFile, officeDistance, patchExpense } from "./dashboard-client"
import { companionLog } from "./log"
import { type DupQuery, MEAL_ADDRESS_UNRESOLVED, MEAL_TRAVEL_KM, checkDuplicate, codeChecks, mealCodeForKm } from "./receipt-checks"
import { localCopyPath, qaDir, removeLocalCopy } from "./receipt-capture"
import { type ChartEntry, type ChartQuery, type JevDecision, type JevVerdict, type MealRule, askJev, decideJev, loadChart, mealRuleApplies } from "./receipt-jev"
import { type ExpenseFields, type QaChange, type QaIssue, type QaRow, type QaStatus, getQaRow, nextDue, nextWakeAt, defer, setImagePath, transition } from "./receipt-qa-store"
import { type SonnetRunner, buildPrompt, parseAnswer, runSonnetCli, validatePatch } from "./receipt-sonnet"
import { tursoQuery } from "./turso"
import { vaultUpstream } from "./vault-upstream"

// Receipt QA queue worker (store host only). One row at a time, never on the
// HTTP path: the capture route only inserts + kicks. Transient failures
// (dashboard/Turso/claude unreachable) back off 30 s → 1 h, MAX_ATTEMPTS, then
// the row moves on with an issue naming what was unavailable.
// Kill switch COMPANION_RECEIPT_QA=off: rows stay `queued`, saves still work.
// Jev fills a BLANK category_code itself (conf ≥ 0.9, receipt clean, no flag).
// Business meals: the dashboard office-distance endpoint decides the code
// (> 50 km → 5216, ≤ 50 km → 5776, by:"rule"); unresolved → to_review.
// Every edit made here or by the phone is appended to
// ~/.config/tls-agent/receipt-qa-audit.jsonl {ts, expense_id, by, field, from, to, reason}.

export const MAX_ATTEMPTS = 6
const BASE_BACKOFF_MS = 30_000
const MAX_BACKOFF_MS = 60 * 60_000
const IDLE_POLL_MS = 5 * 60_000
const HUMAN_EXTRA_FIELDS = ["total", "payment", "address", "receipt_number", "currency"]
const DUPLICATE = "possible duplicate"

class Transient extends Error {}

/** Office-distance answer: km, or why there is none. Throws when the endpoint is unreachable. */
export type OfficeDistance = { km: number } | { km: null; reason: string }

export interface WorkerDeps {
  dupQuery: DupQuery
  chartQuery: ChartQuery
  jev: (f: ExpenseFields, chart: ChartEntry[]) => Promise<JevVerdict | null>
  sonnet: SonnetRunner
  patch: (id: string, fields: Record<string, string>) => Promise<DashReply>
  officeDistance: (address: string) => Promise<OfficeDistance>
  fetchReceipt: (filename: string) => Promise<{ bytes: Uint8Array; mime: string } | null>
  now: () => number
}

const defaultDupQuery: DupQuery = async (date, excludeId) => {
  const rows = await tursoQuery("SELECT id, merchant, total FROM accounting_entries WHERE date = ? AND id != ? LIMIT 200", [date, excludeId])
  return rows.map((r) => ({ id: String(r.id ?? ""), merchant: String(r.merchant ?? ""), total: String(r.total ?? "") }))
}

const defaultOfficeDistance = async (address: string): Promise<OfficeDistance> => {
  const r = await officeDistance(address)
  const km = r.json?.km
  if (r.status >= 200 && r.status < 300 && typeof km === "number" && Number.isFinite(km) && km >= 0) return { km }
  const reason = r.json?.reason
  return { km: null, reason: typeof reason === "string" && reason ? reason.slice(0, 120) : `http ${r.status}` }
}

/** Test seam: swap any dependency. */
export const workerDeps: WorkerDeps = {
  dupQuery: defaultDupQuery,
  chartQuery: tursoQuery,
  jev: askJev,
  sonnet: runSonnetCli,
  patch: patchExpense,
  officeDistance: defaultOfficeDistance,
  fetchReceipt: fetchReceiptFile,
  now: () => Date.now(),
}

export function qaEnabled(): boolean {
  return (process.env.COMPANION_RECEIPT_QA ?? "").trim().toLowerCase() !== "off"
}

// ── Audit ──

export function auditFile(): string {
  return join(process.env.HOME || homedir(), ".config", "tls-agent", "receipt-qa-audit.jsonl")
}

function audit(id: string, by: string, changes: QaChange[], reason: string): void {
  if (!changes.length) return
  try {
    const path = auditFile()
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
    const ts = new Date(workerDeps.now()).toISOString()
    const lines = changes.map((c) => JSON.stringify({ ts, expense_id: id, by, field: c.field, from: c.from, to: c.to, reason: reason.slice(0, 300) }))
    appendFileSync(path, lines.join("\n") + "\n", { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    companionLog(`\x1b[31mreceipt-qa audit write failed\x1b[0m ${id}`)
  }
  companionLog(`receipt-qa ${by} edited ${id}: ${changes.map((c) => c.field).join(", ")}`)
}

function diff(fields: ExpenseFields, patch: Record<string, string>, by: QaChange["by"]): QaChange[] {
  return Object.entries(patch)
    .filter(([k, v]) => String(fields[k] ?? "") !== v)
    .map(([k, v]) => ({ field: k, from: String(fields[k] ?? ""), to: v, by }))
}

function settle(row: QaRow, status: QaStatus, extra: Parameters<typeof transition>[2] = {}): void {
  const terminal = status === "jev_ok" || status === "sonnet_fixed" || status === "human_done"
  // Fresh read: the Sonnet pass may have cached the dashboard PDF since `row` was loaded.
  if (terminal) removeLocalCopy(getQaRow(row.expense_id)?.image_path ?? row.image_path)
  transition(row.expense_id, status, { ...extra, ...(terminal ? { image_path: "" } : {}) })
  companionLog(`receipt-qa ${row.expense_id} → ${status}`)
}

/** PATCH the dashboard; transient → throw Transient; a refusal → false. */
async function applyPatch(id: string, patch: Record<string, string>): Promise<boolean> {
  let r: DashReply
  try {
    r = await workerDeps.patch(id, patch)
  } catch (e) {
    if (e instanceof DashboardUnreachable || e instanceof DashboardKeyMissing) throw new Transient(e.message)
    throw e
  }
  return r.status >= 200 && r.status < 300 && r.json?.ok !== false
}

// ── Pass 1: code checks + Jev ──

async function jevPass(row: QaRow): Promise<void> {
  const issues = codeChecks(row.fields, new Date(workerDeps.now()))
  try {
    issues.push(...await checkDuplicate(row.expense_id, row.fields, workerDeps.dupQuery))
  } catch {
    if (row.attempts + 1 < MAX_ATTEMPTS) throw new Transient("duplicate check unavailable")
    issues.push({ field: "total", problem: "duplicate check unavailable" })
  }
  const chart = await loadChart(workerDeps.chartQuery)
  const jev = await workerDeps.jev(row.fields, chart).catch(() => null)
  const meal = mealRuleApplies(row.fields, jev) ? await mealRule(row.fields) : undefined
  const d = decideJev(row.fields, issues, jev, meal)
  // office_km persists the rule's ownership of the code, even when nothing was patched.
  const km = meal && "km" in meal ? { office_km: meal.km } : null
  const jevJson = jev || km ? { ...jev, ...km } : null
  if (d.rule && meal && "km" in meal) return ruleSet(row, d, d.rule, meal.km, jevJson)
  if (d.fill && jev) return jevFill(row, d.fill, jev)
  settle(row, d.status, { issues: d.issues, jev: jevJson })
}

/** Office distance for a meal's extracted address. Never throws; no km → unresolved. */
async function mealRule(f: ExpenseFields): Promise<MealRule> {
  const address = String(f.address ?? "").trim()
  if (!address) return { unresolved: "no address on the receipt" }
  try {
    const d = await workerDeps.officeDistance(address)
    return d.km === null ? { unresolved: d.reason || "address not geocodable" } : { km: d.km, code: mealCodeForKm(d.km) }
  } catch {
    return { unresolved: "office-distance endpoint unavailable" }
  }
}

/** Book the distance rule's meal code (PATCH + by:"rule" change + audit). */
async function ruleSet(row: QaRow, d: JevDecision, code: string, km: number, jev: Record<string, unknown> | null): Promise<void> {
  const changes = diff(row.fields, { category_code: code }, "rule")
  if (!await applyPatch(row.expense_id, { category_code: code })) {
    const issue: QaIssue = { field: "category_code", problem: `dashboard refused the meal rule's ${code}`, suggestion: code }
    return settle(row, "to_review", { issues: [...d.issues, issue], jev })
  }
  audit(row.expense_id, "rule", changes, `meal ${km.toFixed(1)} km from office (${km > MEAL_TRAVEL_KM ? ">" : "≤"} ${MEAL_TRAVEL_KM} km)`)
  settle(row, d.status, { issues: d.issues, jev, fields: { ...row.fields, category_code: code }, changes: [...row.changes, ...changes] })
}

function mealAddressUnresolved(row: QaRow): boolean {
  return row.issues.some((i) => i.problem.startsWith(MEAL_ADDRESS_UNRESOLVED))
}

/** A meal code decided by the distance rule (patched or already matching), or one it could not resolve, is not Sonnet's to change. */
function mealCodeLocked(row: QaRow): boolean {
  return typeof row.jev?.office_km === "number" ||
    row.changes.some((c) => c.by === "rule" && c.field === "category_code") ||
    mealAddressUnresolved(row)
}

/** Book Jev's confident code on a blank expense (PATCH + by:"jev" change + audit). */
async function jevFill(row: QaRow, code: string, jev: JevVerdict): Promise<void> {
  const changes = diff(row.fields, { category_code: code }, "jev")
  if (!await applyPatch(row.expense_id, { category_code: code })) {
    const issue: QaIssue = { field: "category_code", problem: `dashboard refused Jev's ${code}`, suggestion: code }
    return settle(row, "to_review", { issues: [issue], jev: { ...jev } })
  }
  audit(row.expense_id, "jev", changes, `jev conf ${jev.confidence.toFixed(2)}`)
  settle(row, "jev_ok", { issues: [], jev: { ...jev }, fields: { ...row.fields, category_code: code }, changes: [...row.changes, ...changes] })
}

// ── Pass 2: Sonnet on `to_review` ──

async function receiptPathFor(row: QaRow): Promise<string> {
  if (row.image_path && existsSync(row.image_path)) return row.image_path
  if (!row.receipt_file) return ""
  try {
    const got = await workerDeps.fetchReceipt(row.receipt_file)
    if (!got) return ""
    const path = localCopyPath(row.expense_id, got.mime.includes("pdf") ? "application/pdf" : "image/jpeg")
    mkdirSync(qaDir(), { recursive: true, mode: 0o700 })
    writeFileSync(path, got.bytes, { mode: 0o600 })
    setImagePath(row.expense_id, path)
    return path
  } catch {
    return ""
  }
}

function toHuman(row: QaRow, issues: QaIssue[], extra: Parameters<typeof transition>[2] = {}): void {
  settle(row, "needs_human", { ...extra, issues })
}

async function sonnetPass(row: QaRow): Promise<void> {
  if (row.issues.some((i) => i.problem.startsWith(DUPLICATE))) return toHuman(row, row.issues)
  const chart = await loadChart(workerDeps.chartQuery)
  const imagePath = await receiptPathFor(row)
  const prompt = buildPrompt({ fields: row.fields, issues: row.issues, jev: row.jev, chart, imagePath })
  const run = await workerDeps.sonnet(prompt, imagePath)
  if (run.kind === "error") {
    if (row.attempts + 1 < MAX_ATTEMPTS) throw new Transient(`sonnet ${run.reason}`)
    return toHuman(row, [...row.issues, { field: "sonnet", problem: "sonnet_unavailable" }])
  }
  const ans = parseAnswer(run.text)
  if (!ans) return toHuman(row, [...row.issues, { field: "sonnet", problem: "unparseable answer" }])
  if (!ans.resolved) return toHuman(row, [...row.issues, { field: "sonnet", problem: `unresolved: ${ans.reason || "no reason"}` }])
  const verdict = validatePatch(row.fields, ans.patch, chart)
  if (!verdict.ok) return toHuman(row, [...row.issues, { field: "sonnet", problem: `patch refused: ${verdict.why}` }])
  const code = verdict.patch.category_code
  if (code !== undefined && code !== String(row.fields.category_code ?? "") && mealCodeLocked(row)) {
    return toHuman(row, [...row.issues, { field: "sonnet", problem: "patch refused: meal GL code is decided by office distance" }])
  }
  // Sonnet cannot geocode: an unresolved meal address is never auto-completed.
  if (mealAddressUnresolved(row)) return toHuman(row, row.issues)
  const changes = diff(row.fields, verdict.patch, "sonnet")
  if (changes.length) {
    const patch = Object.fromEntries(changes.map((c) => [c.field, c.to]))
    if (!await applyPatch(row.expense_id, patch)) return toHuman(row, [...row.issues, { field: "sonnet", problem: "dashboard refused the patch" }])
    audit(row.expense_id, "sonnet", changes, ans.reason)
  }
  settle(row, "sonnet_fixed", { fields: { ...row.fields, ...verdict.patch }, changes: [...row.changes, ...changes] })
}

// ── Queue loop ──

let running = false
let again = false
let timer: ReturnType<typeof setTimeout> | null = null
let started = false

function backoff(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1))
}

async function processOne(row: QaRow): Promise<void> {
  try {
    if (row.status === "queued") await jevPass(row)
    else if (row.status === "to_review") await sonnetPass(row)
  } catch (e) {
    const attempts = row.attempts + 1
    const reason = e instanceof Error ? e.message : "error"
    if (attempts >= MAX_ATTEMPTS) {
      const issue: QaIssue = { field: "qa", problem: `qa_failed: ${reason.slice(0, 120)}` }
      return row.status === "queued" ? settle(row, "to_review", { issues: [...row.issues, issue] }) : toHuman(row, [...row.issues, issue])
    }
    defer(row.expense_id, attempts, workerDeps.now() + backoff(attempts), reason)
    companionLog(`receipt-qa ${row.expense_id} retry ${attempts}/${MAX_ATTEMPTS} (${e instanceof Transient ? "transient" : "error"})`)
  }
}

/** Process every due row now. Re-entrancy safe; resolves with the count processed. */
export async function drainReceiptQa(): Promise<number> {
  if (!qaEnabled() || vaultUpstream()) return 0
  if (running) { again = true; return 0 }
  running = true
  let n = 0
  try {
    do {
      again = false
      for (let row = nextDue(workerDeps.now()); row; row = nextDue(workerDeps.now())) {
        await processOne(row)
        n++
      }
    } while (again)
  } finally {
    running = false
  }
  if (started) schedule()
  return n
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  const wake = nextWakeAt()
  const delay = wake === null ? IDLE_POLL_MS : Math.max(1_000, Math.min(IDLE_POLL_MS, wake - workerDeps.now()))
  timer = setTimeout(() => { void drainReceiptQa() }, delay)
  timer.unref?.()
}

/** Called by the capture route after a save. */
export function kickReceiptQa(): void {
  if (!qaEnabled() || vaultUpstream()) return
  setTimeout(() => { void drainReceiptQa() }, 0)
}

/** Boot: resume whatever the last process left queued. Inert upstream or when off. */
export function startReceiptQaWorker(): () => void {
  if (vaultUpstream()) return () => {}
  if (!qaEnabled()) {
    companionLog("receipt-qa off (COMPANION_RECEIPT_QA=off) — receipts save, QA skipped")
    return () => {}
  }
  started = true
  kickReceiptQa()
  return () => { started = false; if (timer) clearTimeout(timer); timer = null }
}

// ── Phone actions (pass 3) ──

export type HumanResult = { ok: true } | { ok: false; status: number; error: string }

const HUMAN_FIELDS = new Set<string>(["category_code", "category", "purpose", "reimbursable", "tps", "tvq", "tip", "subtotal", "date", "merchant", "notes", ...HUMAN_EXTRA_FIELDS])

/** Validate the phone's fields: known names, strings ≤ 500, no control chars. */
export function humanPatch(fields: unknown, note: unknown, current: ExpenseFields): Record<string, string> | string {
  if (fields !== undefined && (fields === null || typeof fields !== "object" || Array.isArray(fields))) return "bad_fields"
  if (note !== undefined && typeof note !== "string") return "bad_note"
  const patch: Record<string, string> = {}
  for (const [k, v] of Object.entries((fields ?? {}) as Record<string, unknown>)) {
    if (!HUMAN_FIELDS.has(k)) return "field_not_editable"
    if (typeof v !== "string" && typeof v !== "number") return "bad_value"
    const s = String(v)
    if (s.length > 500 || /[\x00-\x09\x0b-\x1f\x7f]/.test(s)) return "bad_value"
    patch[k] = s
  }
  const n = typeof note === "string" ? note.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 1000) : ""
  if (n) {
    const base = patch.notes ?? String(current.notes ?? "")
    patch.notes = base ? `${base} · ${n}` : n
  }
  return patch
}

export async function resolveByHuman(id: string, fields: unknown, note: unknown): Promise<HumanResult> {
  const row = getQaRow(id)
  if (!row) return { ok: false, status: 404, error: "not_found" }
  const patch = humanPatch(fields, note, row.fields)
  if (typeof patch === "string") return { ok: false, status: 400, error: patch }
  const changes = diff(row.fields, patch, "human")
  if (changes.length) {
    try {
      if (!await applyPatch(id, Object.fromEntries(changes.map((c) => [c.field, c.to])))) return { ok: false, status: 502, error: "dashboard_refused" }
    } catch (e) {
      if (e instanceof Transient) return { ok: false, status: e.message === "dashboard_key_missing" ? 503 : 502, error: e.message === "dashboard_key_missing" ? "dashboard_key_missing" : "dashboard_unreachable" }
      throw e
    }
    audit(id, "human", changes, "phone resolve")
  }
  settle(row, "human_done", { fields: { ...row.fields, ...patch }, changes: [...row.changes, ...changes] })
  return { ok: true }
}

export function acceptByHuman(id: string): HumanResult {
  const row = getQaRow(id)
  if (!row) return { ok: false, status: 404, error: "not_found" }
  settle(row, "human_done")
  return { ok: true }
}
