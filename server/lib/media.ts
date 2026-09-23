import sharp from "sharp"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Content-addressed media store for images in the feed (RES-L5NG step 3).
//
// A leaf lib: fs + encode only. Feed events carry a reference (`mediaId`),
// never bytes; `GET /api/media/:id` serves the file. File lifetime is NOT tied
// to the feed: the phone caches whole conversations well past the 200-event
// feed window, so a file lives until the byte cap (oldest-by-mtime) or the age
// cap removes it — sweepMedia(), run on every write and hourly (wiring/media.ts).
//
// mediaId = first 32 hex of sha256 of the SOURCE bytes, so the same image read
// twice lands in one file. Every source is downscaled to a 1024px long edge
// JPEG q80. The dir is COMPANION_MEDIA_DIR (tests) or ~/.claude-companion/media.

export interface MediaRef {
  mediaId: string
  width: number
  height: number
}

const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_DIR_BYTES = 200 * 1024 * 1024
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_CONCURRENT = 2
// Waiting jobs beyond the active slots. A queued job holds its source (the
// base64 string, or a path) — not a decoded buffer — but even so a burst of
// screenshots must not pile up without bound; the excess is refused with
// "busy" and the transcript reader retries it on a later tick.
export const MAX_PENDING = 6
const ID_RE = /^[a-f0-9]{32}$/

// One libvips thread per job and at most two jobs: a burst of screenshots must
// never starve the hook path that shares this process.
sharp.concurrency(1)

function mediaDir(): string {
  return process.env.COMPANION_MEDIA_DIR || join(homedir(), ".claude-companion", "media")
}

export function isMediaId(id: string): boolean {
  return ID_RE.test(id)
}

export function mediaPath(id: string): string {
  return join(mediaDir(), `${id}.jpg`)
}

function maxDirBytes(): number {
  const n = Number(process.env.COMPANION_MEDIA_MAX_BYTES)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DIR_BYTES
}

// COMPANION_MEDIA_MAX_AGE: seconds since last write/re-reference (mtime).
function maxAgeMs(): number {
  const n = Number(process.env.COMPANION_MEDIA_MAX_AGE)
  return Number.isFinite(n) && n > 0 ? n * 1000 : DEFAULT_MAX_AGE_MS
}

function log(msg: string): void {
  const dim = "\x1b[2m"; const reset = "\x1b[0m"; const cyan = "\x1b[36m"
  process.stderr.write(`${dim}[companion]${reset} ${cyan}media${reset} ${msg}\n`)
}

// ── Byte total ──
// Seeded by one dir scan on first use (and again if the dir changes, which
// only tests do), then kept current per write/unlink.
let mediaBytes = 0
let seededFor: string | null = null

function listJpegs(dir: string): Array<{ path: string; size: number; mtimeMs: number }> {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const out: Array<{ path: string; size: number; mtimeMs: number }> = []
  for (const name of names) {
    if (!name.endsWith(".jpg")) continue
    const path = join(dir, name)
    try {
      const st = statSync(path)
      if (st.isFile()) out.push({ path, size: st.size, mtimeMs: st.mtimeMs })
    } catch { /* raced with an unlink */ }
  }
  return out
}

function ensureSeeded(): void {
  const dir = mediaDir()
  if (seededFor === dir) return
  seededFor = dir
  mediaBytes = listJpegs(dir).reduce((sum, f) => sum + f.size, 0)
}

// Unlink oldest-by-mtime until the dir is under the cap. Returns the ids
// removed. No announcement: a phone fetching a pruned id gets 404.
export function enforceMediaCap(maxBytes = maxDirBytes()): string[] {
  ensureSeeded()
  if (mediaBytes <= maxBytes) return []
  // Re-derive the total from the scan so a drifted counter self-heals.
  const files = listJpegs(mediaDir()).sort((a, b) => a.mtimeMs - b.mtimeMs)
  let total = files.reduce((sum, f) => sum + f.size, 0)
  const removed: string[] = []
  for (const f of files) {
    if (total <= maxBytes) break
    try {
      unlinkSync(f.path)
      total -= f.size
      removed.push(f.path.slice(f.path.lastIndexOf("/") + 1, -".jpg".length))
    } catch { /* already gone */ }
  }
  mediaBytes = total
  return removed
}

// Unlink every file whose mtime is older than maxAgeMs. mtime is refreshed
// when the same source is stored again, so the age is "since last seen".
export function expireMedia(maxAge = maxAgeMs(), now = Date.now()): string[] {
  ensureSeeded()
  const removed: string[] = []
  for (const f of listJpegs(mediaDir())) {
    if (now - f.mtimeMs <= maxAge) continue
    try {
      unlinkSync(f.path)
      mediaBytes = Math.max(0, mediaBytes - f.size)
      removed.push(f.path.slice(f.path.lastIndexOf("/") + 1, -".jpg".length))
    } catch { /* already gone */ }
  }
  return removed
}

// The only way files leave the store: age cap, then byte cap. Never throws.
export function sweepMedia(): string[] {
  try {
    return [...expireMedia(), ...enforceMediaCap()]
  } catch {
    return []
  }
}

// ── Encode queue ── at most MAX_CONCURRENT sharp jobs. release() hands the
// slot straight to the next waiter so the count can never overshoot.
let active = 0
const waiters: Array<() => void> = []

/// True when a new job would exceed the bounded wait queue.
function saturated(): boolean {
  return active >= MAX_CONCURRENT && waiters.length >= MAX_PENDING
}

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) { active++; return }
  await new Promise<void>((resolve) => waiters.push(resolve))
}

function release(): void {
  const next = waiters.shift()
  if (next) next()
  else active--
}

// Two reads of the same bytes at once share one job instead of racing on the
// same output file (and double-counting its bytes).
const inflight = new Map<string, Promise<MediaRef | null>>()

/// Result of a store call: a ref, `null` for corrupt/refused input, or
/// `"busy"` when the encode queue is saturated (retry later).
export type StoreResult = MediaRef | null | "busy"

async function refForExisting(id: string, path: string): Promise<MediaRef | null> {
  try {
    const meta = await sharp(path).metadata() // header only
    if (!meta.width || !meta.height) return null
    const now = new Date()
    utimesSync(path, now, now) // fresh for the byte cap
    return { mediaId: id, width: meta.width, height: meta.height }
  } catch {
    return null // unreadable leftover — re-encode over it
  }
}

async function encode(id: string, load: () => Buffer | null): Promise<MediaRef | null> {
  const out = mediaPath(id)
  await acquire()
  try {
    if (existsSync(out)) {
      const ref = await refForExisting(id, out)
      if (ref) return ref
    }
    // Decoded only now, inside the slot: a waiting job never holds a buffer.
    const input = load()
    if (!input || input.length === 0 || input.length > MAX_SOURCE_BYTES) return null
    const { data, info } = await sharp(input)
      .rotate()
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true })
    ensureSeeded()
    mkdirSync(mediaDir(), { recursive: true })
    let prevSize = 0
    try { prevSize = statSync(out).size } catch { /* new file */ }
    // Write-then-rename: the route never serves a half-written file.
    const tmp = `${out}.${process.pid}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, out)
    mediaBytes += data.length - prevSize
    sweepMedia()
    return { mediaId: id, width: info.width, height: info.height }
  } catch (err) {
    log(`decode failed for ${id}: ${err instanceof Error ? err.message.split("\n")[0] : "unknown"}`)
    return null
  } finally {
    release()
  }
}

// The id is derived from the SOURCE (base64 text, or path + size + mtime),
// never from decoded bytes, so nothing is decoded before a slot is granted.
// Same source twice → same id → one job, one file.
function storeSource(id: string, load: () => Buffer | null): Promise<StoreResult> {
  const pending = inflight.get(id)
  if (pending) return pending
  if (!existsSync(mediaPath(id)) && saturated()) {
    log(`encode queue saturated (${MAX_CONCURRENT} active + ${MAX_PENDING} waiting) — ${id} deferred`)
    return Promise.resolve("busy")
  }
  const job = encode(id, load).finally(() => inflight.delete(id))
  inflight.set(id, job)
  return job
}

// A base64 image block (tool_result content). Refuses sources over 20 MB
// decoded — checked on the encoded length first so a huge block is never
// materialised. Corrupt data resolves null and writes nothing.
export function storeImageBase64(data: string): Promise<StoreResult> {
  if (typeof data !== "string" || data.length === 0) return Promise.resolve(null)
  if (Math.floor((data.length * 3) / 4) > MAX_SOURCE_BYTES + 3) return Promise.resolve(null)
  const id = createHash("sha256").update(data).digest("hex").slice(0, 32)
  return storeSource(id, () => Buffer.from(data, "base64"))
}

// A local image file (`![alt](path)` in assistant text). Same 20 MB refusal.
export function storeImageFile(path: string): Promise<StoreResult> {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size === 0 || st.size > MAX_SOURCE_BYTES) return Promise.resolve(null)
    const id = createHash("sha256").update(`${path}\0${st.size}\0${st.mtimeMs}`).digest("hex").slice(0, 32)
    return storeSource(id, () => { try { return readFileSync(path) } catch { return null } })
  } catch {
    return Promise.resolve(null)
  }
}
