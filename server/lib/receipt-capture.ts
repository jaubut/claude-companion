import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { DashboardKeyMissing, DashboardUnreachable, type DashReply, extractReceipt, saveExpense } from "./dashboard-client"
import { companionLog } from "./log"
import { type ExpenseFields, insertQueued } from "./receipt-qa-store"

// POST /api/capture/receipt, store host: validate + normalize the upload,
// dashboard extract, then SAVE STRAIGHT AWAY (Jeremie 2026-10-03) and queue the
// row for QA. The original image is kept under ~/.claude-companion/receipt-qa/
// (0600) for the Sonnet pass and deleted once the row is settled. Nothing here
// logs receipt text — ids and statuses only.

export const MAX_DECODED_BYTES = 12 * 1024 * 1024
const MAX_EDGE = 2400
const NOTE_MAX = 1000
// Fields /api/expense/save accepts that the extractor produces.
const SAVE_FIELDS = ["merchant", "date", "total", "category", "purpose", "payment", "tps", "tvq", "tip", "subtotal", "address", "receipt_number", "reimbursable", "items", "currency"] as const

export type Mime = "image/jpeg" | "image/png" | "image/heic" | "image/webp" | "application/pdf"

export type CaptureOutcome =
  | { ok: true; body: { ok: true; expense_id: string; merchant: string; total: string; date: string; category: string; category_code: string; qa_status: "queued" } }
  | { ok: false; status: number; error: string; message?: string }

export function qaDir(): string {
  return join(process.env.HOME || homedir(), ".claude-companion", "receipt-qa")
}

/** base64 (optionally a data: URL) → bytes. null = not base64. */
export function decodeBase64(raw: string): Uint8Array | null {
  const b64 = raw.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "")
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  return new Uint8Array(Buffer.from(b64, "base64"))
}

/** Upper bound of the decoded size, before decoding. */
export function decodedSizeOf(raw: string): number {
  const comma = raw.startsWith("data:") ? raw.indexOf(",") + 1 : 0
  return Math.floor(((raw.length - comma) * 3) / 4)
}

export function sniffMime(b: Uint8Array): Mime | null {
  const ascii = (from: number, to: number): string => String.fromCharCode(...b.subarray(from, to))
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png"
  if (ascii(0, 5) === "%PDF-") return "application/pdf"
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  if (ascii(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(ascii(8, 12))) return "image/heic"
  return null
}

/** EXIF-rotate, cap the long edge, re-encode JPEG (the extractor's 5 MB limit). Falls back to the original. */
export async function normalizeImage(bytes: Uint8Array, mime: Mime): Promise<{ bytes: Uint8Array; mime: Mime }> {
  try {
    const out = await sharp(bytes).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
    return { bytes: new Uint8Array(out), mime: "image/jpeg" }
  } catch {
    // e.g. HEIC on a libvips without the HEVC decoder: let the extractor decide.
    return { bytes, mime }
  }
}

const EXT: Record<Mime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/webp": "webp", "application/pdf": "pdf" }

export function localCopyPath(expenseId: string, mime: Mime): string {
  return join(qaDir(), `${createHash("sha256").update(expenseId).digest("hex").slice(0, 24)}.${EXT[mime]}`)
}

function storeLocalCopy(expenseId: string, bytes: Uint8Array, mime: Mime): string {
  try {
    mkdirSync(qaDir(), { recursive: true, mode: 0o700 })
    const path = localCopyPath(expenseId, mime)
    writeFileSync(path, bytes, { mode: 0o600 })
    chmodSync(path, 0o600)
    return path
  } catch {
    companionLog("receipt-qa local copy failed (QA will use the dashboard PDF)")
    return ""
  }
}

export function removeLocalCopy(path: string): void {
  if (!path) return
  try { if (existsSync(path)) unlinkSync(path) } catch { /* best effort */ }
}

const str = (v: unknown): string => (v == null ? "" : String(v)).slice(0, 2000)
const clean = (v: unknown, max = 300): string => str(v).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, max)

export interface ReceiptInput { image?: unknown; pdf?: unknown; note?: unknown }

type Prepared = { ok: true; bytes: Uint8Array; mime: Mime } | { ok: false; status: number; error: string; message?: string }

/** Body → validated bytes (exactly one of image/pdf, ≤ 12 MB decoded, known type). */
export async function prepareUpload(input: ReceiptInput): Promise<Prepared> {
  const hasImage = typeof input.image === "string" && input.image.length > 0
  const hasPdf = typeof input.pdf === "string" && input.pdf.length > 0
  if (hasImage === hasPdf) return { ok: false, status: 400, error: "image_or_pdf_required" }
  if (input.note !== undefined && typeof input.note !== "string") return { ok: false, status: 400, error: "bad_note" }
  const raw = (hasImage ? input.image : input.pdf) as string
  if (decodedSizeOf(raw) > MAX_DECODED_BYTES + 3) return { ok: false, status: 413, error: "too_large", message: "max 12 MB" }
  const bytes = decodeBase64(raw)
  if (!bytes) return { ok: false, status: 400, error: "bad_base64" }
  if (bytes.length > MAX_DECODED_BYTES) return { ok: false, status: 413, error: "too_large", message: "max 12 MB" }
  const mime = sniffMime(bytes)
  if (!mime || (hasPdf && mime !== "application/pdf")) return { ok: false, status: 415, error: "unsupported_media" }
  if (mime === "application/pdf") return { ok: true, bytes, mime }
  const norm = await normalizeImage(bytes, mime)
  return { ok: true, ...norm }
}

function saveBody(data: Record<string, unknown>, note: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of SAVE_FIELDS) if (data[k] != null && data[k] !== "") out[k] = str(data[k])
  if (note) out.notes = note
  if (typeof data.receiptFile === "string" && data.receiptFile) out.receiptFile = data.receiptFile
  return out
}

function snapshot(body: Record<string, unknown>): ExpenseFields {
  const f: ExpenseFields = { category_code: "", notes: "" }
  for (const [k, v] of Object.entries(body)) if (k !== "receiptFile") f[k] = str(v)
  return f
}

/** extract → save → queued row. Never throws. */
export async function captureReceipt(input: ReceiptInput): Promise<CaptureOutcome> {
  const prep = await prepareUpload(input)
  if (!prep.ok) return prep
  const note = clean(input.note, NOTE_MAX).trim()
  const b64 = Buffer.from(prep.bytes).toString("base64")
  const upload = prep.mime === "application/pdf" ? { pdf: b64 } : { image: `data:${prep.mime};base64,${b64}` }
  try {
    const ex: DashReply = await extractReceipt(upload).catch((e: unknown): DashReply => {
      // The extractor answering 5xx is an extraction failure, not an outage.
      if (e instanceof DashboardUnreachable && e.status >= 500) return { status: e.status, json: { ok: false, error: "extraction service error" } }
      throw e
    })
    const data = ex.json?.data
    if (ex.status !== 200 || ex.json?.ok !== true || !data || typeof data !== "object") {
      const message = clean(ex.json?.error ?? `extract HTTP ${ex.status}`)
      companionLog(`receipt capture extract_failed (HTTP ${ex.status})`)
      return { ok: false, status: 422, error: "extract_failed", message }
    }
    const body = saveBody(data as Record<string, unknown>, note)
    const saved = await saveExpense(body)
    const id = saved.json?.id
    if (saved.status !== 200 || saved.json?.ok !== true || typeof id !== "string" || !id) {
      companionLog(`receipt capture save_failed (HTTP ${saved.status})`)
      return { ok: false, status: 502, error: "save_failed", message: clean(saved.json?.error ?? `save HTTP ${saved.status}`) }
    }
    const fields = snapshot(body)
    const imagePath = prep.mime === "application/pdf" ? "" : storeLocalCopy(id, prep.bytes, prep.mime)
    const item = insertQueued({ expense_id: id, fields, receipt_file: str(body.receiptFile), image_path: imagePath })
    companionLog(`receipt saved ${id} → queued`)
    return {
      ok: true,
      body: { ok: true, expense_id: id, merchant: item.merchant, total: item.total, date: item.date, category: item.category, category_code: item.category_code, qa_status: "queued" },
    }
  } catch (e) {
    if (e instanceof DashboardKeyMissing) return { ok: false, status: 503, error: "dashboard_key_missing" }
    if (e instanceof DashboardUnreachable) {
      companionLog(`receipt capture dashboard unreachable (${e.status || "network"})`)
      return { ok: false, status: 502, error: "dashboard_unreachable" }
    }
    companionLog(`receipt capture failed (${e instanceof Error ? e.name : "error"})`)
    return { ok: false, status: 500, error: "capture_failed" }
  }
}
