import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import sharp from "sharp"
import { MAX_BYTES, checkUrl, safeFetch, startGuardProxy, vetHost } from "./link-media-guard"
import { type Swatch, palette } from "./link-media-palette"
import { companionLog } from "./log"

// bin/media (POST /hooks/brain/media): the brain may not write files, so the
// server fetches a video or image URL into its own cache and hands back what
// the brain needs to look at it: meta, a 6-colour palette, the caption
// transcript (no Whisper) and absolute paths of ~10 frames + a contact sheet
// (the brain opens them with Read). One folder per URL, reused while present,
// pruned after 7 days. yt-dlp does the fetching (Instagram 401 → the embed
// captions page), ffmpeg the frames. All network traffic goes through the
// guard proxy (link-media-guard.ts) and the whole job, fetches and sharp
// included, ends at a 120 s deadline.

const ROOT = process.env.COMPANION_LINK_MEDIA_DIR ?? join(homedir(), ".cache", "companion", "media")
const TIMEOUT_MS = 120_000
const MAX_VIDEO_BYTES = MAX_BYTES
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_META_BYTES = 10 * 1024 * 1024
const MAX_SUB_BYTES = 5 * 1024 * 1024
const MAX_SECONDS = 600
const FRAMES = 10
const FRAME_WIDTH = 768
const TRANSCRIPT_MAX = 6_000
const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
const YTDLP = existsSync(join(homedir(), ".local", "bin", "yt-dlp")) ? join(homedir(), ".local", "bin", "yt-dlp") : "yt-dlp"

export interface LinkMediaMeta {
  source: "yt-dlp" | "instagram-embed" | "direct"
  uploader: string | null
  title: string | null
  description: string | null
  duration: number | null
}
export interface LinkMediaOut { status: number; body: Record<string, unknown> }

export class MediaError extends Error {
  constructor(readonly status: number, readonly reason: string) { super(reason) }
}

interface RunResult { code: number; stdout: string; stderr: string }

/** An abort signal for the time left before `deadline`, capped at `max` ms. */
const until = (deadline: number, max = Infinity): AbortSignal => AbortSignal.timeout(Math.max(1, Math.min(max, deadline - Date.now())))

/** Reject with a 504 at `deadline`; whatever `p` does later is ignored. */
export function beforeDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  p.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MediaError(504, "timed out")), Math.max(0, deadline - Date.now())) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/** Run a command in its own process group; at the deadline (or abort signal) the whole group (yt-dlp's ffmpeg too) is killed. */
export async function run(cmd: string[], deadline: number, signal?: AbortSignal): Promise<RunResult> {
  const left = deadline - Date.now()
  if (left <= 0) throw new MediaError(504, "timed out")
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true, env: { ...process.env, NO_PROXY: "", no_proxy: "" } })
  const killGroup = (): void => {
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      proc.kill("SIGKILL")
    }
  }
  const timer = setTimeout(killGroup, left)
  if (signal?.aborted) killGroup()
  else signal?.addEventListener("abort", killGroup, { once: true })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  signal?.removeEventListener("abort", killGroup)
  if (Date.now() >= deadline && !signal?.aborted) throw new MediaError(504, "timed out")
  return { code, stdout, stderr }
}

/**
 * yt-dlp flags: no host config, every request through the guard proxy, native HLS downloader, and ffmpeg_i stripped
 * of network/file protocols so yt-dlp's external ffmpeg downloader can never open nested HLS key/segment URLs directly.
 * --fixup never: a fixup runs ffprobe on the download, unproxied, and the bytes are the sender's.
 */
export const ytArgs = (proxy: string): string[] => ["--ignore-config", "--proxy", proxy, "--fixup", "never", "--hls-prefer-native", "--downloader-args", "ffmpeg_i:-protocol_whitelist crypto", "--no-warnings", "--no-playlist", "--no-progress", "--socket-timeout", "20"]
// ffmpeg picks a demuxer from the file's content and name, and both come from the sender: a playlist saved as
// video.* would make the local ffmpeg open its segments directly, past the guard proxy. Plain containers from disk only.
export const LOCAL_INPUT = ["-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,mpegts"]
// Only formats fetched by yt-dlp's Python downloaders over http(s)/native-HLS/DASH through the guard proxy
// (never legacy 'm3u8' or rtmp:// which invoke ffmpeg directly on remote URLs).
const SAFE_PROTOCOL_RE = /^(https?|m3u8_native|http_dash_segments)$/
const SAFE_PROTOCOL = "[protocol~='^(https?|m3u8_native|http_dash_segments)$']"
export const VIDEO_FORMAT = ["bv*[width<=?1080]", "b[width<=?1080]", "bv*", "b"].map((f) => f + SAFE_PROTOCOL).join("/")
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

const isSafeProtocol = (proto: string): boolean => proto.split("+").every((p) => SAFE_PROTOCOL_RE.test(p))

/** True when yt-dlp metadata only advertises http(s) / native-HLS / DASH formats over http(s) URLs. */
export function isSafeMediaInfo(raw: Record<string, unknown>): boolean {
  if (typeof raw.url === "string" && !/^https?:\/\//i.test(raw.url)) return false
  if (typeof raw.protocol === "string" && !isSafeProtocol(raw.protocol)) return false
  if (Array.isArray(raw.formats) && raw.formats.length > 0) {
    const anySafe = raw.formats.some((f) => {
      if (!f || typeof f !== "object") return false
      const fmt = f as Record<string, unknown>
      if (typeof fmt.url === "string" && !/^https?:\/\//i.test(fmt.url)) return false
      if (typeof fmt.protocol === "string" && !isSafeProtocol(fmt.protocol)) return false
      return typeof fmt.url === "string" || typeof fmt.protocol === "string"
    })
    if (!anySafe) return false
  }
  return true
}

/** Stream a response to disk, refusing past `max` bytes. */
async function saveCapped(res: Response, path: string, max: number): Promise<void> {
  if (!res.ok || !res.body) throw new MediaError(502, `fetch failed (HTTP ${res.status})`)
  if (Number(res.headers.get("content-length") ?? 0) > max) throw new MediaError(413, `over ${max / 1024 / 1024} MB`)
  const w = Bun.file(path).writer()
  let total = 0
  for await (const chunk of res.body) {
    total += chunk.length
    if (total > max) { await w.end(); throw new MediaError(413, `over ${max / 1024 / 1024} MB`) }
    w.write(chunk)
  }
  await w.end()
}

// ── Metadata ──

interface Info { meta: LinkMediaMeta; raw: Record<string, unknown> | null; videoUrl: string | null }

/** null when `s` isn't valid JSON: tool output, a scraped string or a cache file can all be cut short. */
export function jsonOrNull<T>(s: string): T | null {
  try { return JSON.parse(s) as T } catch { return null }
}

async function ytInfo(url: string, deadline: number): Promise<Info | { error: string }> {
  const abort = new AbortController()
  const proxy = await startGuardProxy(vetHost, { maxBytes: MAX_META_BYTES, onExceed: () => abort.abort() })
  let r: RunResult
  try {
    r = await run([YTDLP, ...ytArgs(proxy.url), "-f", VIDEO_FORMAT, "-J", "--skip-download", url], deadline, abort.signal)
    if (proxy.exceeded()) return { error: "metadata over 10 MB" }
  } finally {
    proxy.close()
  }
  if (r.code !== 0) return { error: r.stderr.trim().split("\n").pop()?.slice(0, 300) ?? "yt-dlp failed" }
  const raw = jsonOrNull<Record<string, unknown>>(r.stdout)
  if (!raw) return { error: "yt-dlp printed unreadable JSON" }
  if (!isSafeMediaInfo(raw)) return { error: "unsupported media protocol" }
  return {
    raw, videoUrl: null,
    meta: {
      source: "yt-dlp",
      uploader: text(raw.uploader) ?? text(raw.channel),
      title: text(raw.title),
      description: text(raw.description),
      duration: typeof raw.duration === "number" ? raw.duration : null,
    },
  }
}

const IG_CODE = /^\/(?:[\w.]+\/)?(?:reels?|p|tv)\/([\w-]+)/

/** Instagram without yt-dlp: the embed captions page carries caption + video_url (best effort). */
async function instagramEmbed(url: URL, deadline: number): Promise<Info | null> {
  const code = url.pathname.match(IG_CODE)?.[1]
  if (!code) return null
  const res = await safeFetch(`https://www.instagram.com/reel/${code}/embed/captions/`, { headers: { "User-Agent": UA }, signal: until(deadline, 20_000) })
  if (!res.ok) return null
  const html = (await res.text()).replace(/\\"/g, '"')
  const m = html.match(/"video_url":"((?:[^"\\]|\\.)*)"/)
  const rawVideoUrl = m ? jsonOrNull<string>(`"${m[1]}"`) : null
  const videoUrl = rawVideoUrl && /^https?:\/\//i.test(rawVideoUrl) ? rawVideoUrl : null
  const strip = (s: string | undefined): string | null => text(s?.replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'"))
  const caption = strip(html.match(/class="Caption"[^>]*>([\s\S]*?)<\/div>/)?.[1])
  const uploader = strip(html.match(/class="CaptionUsername"[^>]*>([\s\S]*?)<\/a>/)?.[1])
  if (!videoUrl && !caption) return null
  return { raw: null, videoUrl, meta: { source: "instagram-embed", uploader, title: null, description: caption, duration: null } }
}

async function fetchInfo(url: URL, deadline: number): Promise<Info> {
  const yt = await ytInfo(url.href, deadline)
  if (!("error" in yt)) return yt
  if (/(^|\.)instagram\.com$/.test(url.hostname)) {
    const embed = await instagramEmbed(url, deadline).catch(() => null)
    if (embed) return embed
  }
  throw new MediaError(422, `could not read this link: ${yt.error}`)
}

// ── Video ──

function findVideo(dir: string): string | null {
  const f = readdirSync(dir).find((n) => n.startsWith("video.") && !n.endsWith(".part") && !n.endsWith(".ytdl"))
  return f ? join(dir, f) : null
}

async function download(url: string, info: Info, dir: string, deadline: number): Promise<string> {
  if (info.videoUrl) {
    await saveCapped(await safeFetch(info.videoUrl, { headers: { "User-Agent": UA }, signal: until(deadline) }), join(dir, "video.mp4"), MAX_VIDEO_BYTES)
  } else {
    const abort = new AbortController()
    const proxy = await startGuardProxy(vetHost, { maxBytes: MAX_VIDEO_BYTES, onExceed: () => abort.abort() })
    try {
      const r = await run([YTDLP, ...ytArgs(proxy.url), "-f", VIDEO_FORMAT, "--max-filesize", "200M", "-o", join(dir, "video.%(ext)s"), url], deadline, abort.signal)
      if (proxy.exceeded()) throw new MediaError(413, "video over 200 MB (not downloaded)")
      if (r.code !== 0) throw new MediaError(502, `download failed: ${r.stderr.trim().split("\n").pop()?.slice(0, 300)}`)
    } finally {
      proxy.close()
    }
  }
  const v = findVideo(dir)
  if (!v || statSync(v).size > MAX_VIDEO_BYTES) throw new MediaError(413, "video over 200 MB (not downloaded)")
  return v
}

async function probeDuration(video: string, deadline: number): Promise<number> {
  const r = await run(["ffprobe", "-v", "error", ...LOCAL_INPUT, "-show_entries", "format=duration", "-of", "csv=p=0", video], deadline)
  const d = Number(r.stdout.trim())
  if (!Number.isFinite(d) || d <= 0) throw new MediaError(422, "unreadable video")
  return Math.min(d, MAX_SECONDS)
}

async function extractFrames(video: string, duration: number, dir: string, deadline: number): Promise<string[]> {
  const frames: string[] = []
  for (let i = 0; i < FRAMES; i++) {
    const out = join(dir, `frame_${String(i + 1).padStart(2, "0")}.jpg`)
    const t = ((i + 0.5) * duration / FRAMES).toFixed(2)
    await run(["ffmpeg", "-v", "error", "-y", ...LOCAL_INPUT, "-ss", t, "-i", video, "-frames:v", "1", "-vf", `scale='min(${FRAME_WIDTH},iw)':-2`, "-q:v", "3", out], deadline)
    if (existsSync(out)) frames.push(out)
  }
  if (!frames.length) throw new MediaError(422, "no frames could be extracted")
  return frames
}

async function contactSheet(dir: string, deadline: number): Promise<string | null> {
  const out = join(dir, "contact.jpg")
  await run(["ffmpeg", "-v", "error", "-y", "-i", join(dir, "frame_%02d.jpg"), "-vf", "scale=256:-2,tile=5x2", "-frames:v", "1", "-q:v", "3", out], deadline)
  return existsSync(out) ? out : null
}

/** Drop `<...>` tags in one pass. A regex rescans to end-of-line from every unmatched `<` (quadratic); once no `>` remains the rest is literal. */
function stripTags(line: string): string {
  let out = ""
  let i = 0
  while (i < line.length) {
    const lt = line.indexOf("<", i)
    if (lt < 0) break
    const gt = line.indexOf(">", lt + 1)
    if (gt < 0) break
    out += line.slice(i, gt === lt + 1 ? lt + 1 : lt)
    i = gt === lt + 1 ? lt + 1 : gt + 1
  }
  return out + line.slice(i)
}

/** Caption text from a WebVTT file, cue lines deduped (auto-captions repeat). */
export function vttText(vtt: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of vtt.split("\n")) {
    const line = stripTags(l).trim()
    if (!line || line === "WEBVTT" || /^(NOTE|Kind:|Language:)/.test(line) || line.includes("-->") || /^\d+$/.test(line) || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out.join("\n")
}

/** Stream a response body as UTF-8 text, aborting immediately if decompressed bytes exceed `max`. */
export async function readCappedUtf8(res: Response, max: number): Promise<string | null> {
  if (!res.ok || !res.body) return null
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body.cancel().catch(() => {})
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged)
}

/** Pick the preferred WebVTT URL from yt-dlp's extracted `subtitles` / `automatic_captions` metadata. */
export function pickCaptionUrl(raw: Record<string, unknown>): string | null {
  const pref = text(raw.language)?.toLowerCase() ?? null
  const matchLang = (lang: string, pass: number): boolean => {
    const l = lang.toLowerCase()
    if (pass === 0) return pref !== null && (l === pref || l.startsWith(`${pref}-`) || l.startsWith(`${pref}_`))
    if (pass === 1) return l === "en" || /^en[_-]/.test(l)
    return l === "fr" || /^fr[_-]/.test(l)
  }
  for (const key of ["subtitles", "automatic_captions"] as const) {
    const table = raw[key]
    if (!table || typeof table !== "object") continue
    const entries = Object.entries(table as Record<string, unknown>)
    for (let pass = 0; pass < 3; pass++) {
      for (const [lang, formats] of entries) {
        if (!matchLang(lang, pass) || !Array.isArray(formats)) continue
        for (const f of formats) {
          if (!f || typeof f !== "object") continue
          const fmt = f as Record<string, unknown>
          const ext = typeof fmt.ext === "string" ? fmt.ext.toLowerCase() : ""
          const url = typeof fmt.url === "string" ? fmt.url.trim() : ""
          const proto = typeof fmt.protocol === "string" ? fmt.protocol : "https"
          if (ext === "vtt" && /^https?:\/\//i.test(url) && isSafeProtocol(proto)) return url
        }
      }
    }
  }
  return null
}

async function transcript(info: Info, deadline: number): Promise<string | null> {
  if (!info.raw) return null
  const subUrl = pickCaptionUrl(info.raw)
  if (!subUrl) return null
  const res = await safeFetch(subUrl, { headers: { "User-Agent": UA, "Accept-Encoding": "identity" }, signal: until(deadline, 20_000) })
  const rawVtt = await readCappedUtf8(res, MAX_SUB_BYTES)
  if (!rawVtt) return null
  const t = vttText(rawVtt)
  return t.length > TRANSCRIPT_MAX ? `${t.slice(0, TRANSCRIPT_MAX - 1)}…` : t || null
}

async function analyseVideo(url: URL, dir: string, deadline: number): Promise<Record<string, unknown>> {
  const info = await fetchInfo(url, deadline)
  const video = await download(url.href, info, dir, deadline)
  const duration = await probeDuration(video, deadline)
  const frames = await extractFrames(video, duration, dir, deadline)
  const sheet = await contactSheet(dir, deadline)
  const colours: Swatch[] = await palette(frames)
  const captions = await transcript(info, deadline).catch(() => null)
  rmSync(video, { force: true })
  return {
    kind: "video", meta: { ...info.meta, duration: info.meta.duration ?? duration }, truncated: (info.meta.duration ?? 0) > MAX_SECONDS,
    palette: colours, transcript: captions, frames, contactSheet: sheet,
  }
}

// ── Image ──

/** The response if it is an image, else null (its body cancelled). */
export async function asImage(res: Response | null): Promise<Response | null> {
  if (res?.ok && (res.headers.get("content-type") ?? "").startsWith("image/")) return res
  await res?.body?.cancel().catch(() => {})
  return null
}

// One GET (not HEAD: some hosts and GET-signed URLs refuse it); not an image → the video path.
async function imageResponse(url: URL, deadline: number): Promise<Response | null> {
  return asImage(await safeFetch(url.href, { headers: { "User-Agent": UA }, signal: until(deadline) }).catch(() => null))
}

/** Last path segment as a title; a malformed %-escape stays raw. */
export function imageTitle(url: URL): string | null {
  const seg = url.pathname.split("/").pop() ?? ""
  try {
    return decodeURIComponent(seg) || null
  } catch {
    return seg || null
  }
}

async function analyseImage(url: URL, res: Response, dir: string): Promise<Record<string, unknown>> {
  const src = join(dir, "source")
  await saveCapped(res, src, MAX_IMAGE_BYTES)
  const image = join(dir, "image.jpg")
  await sharp(src).rotate().resize({ width: FRAME_WIDTH, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(image)
  rmSync(src, { force: true })
  const meta: LinkMediaMeta = { source: "direct", uploader: null, title: imageTitle(url), description: null, duration: null }
  return { kind: "image", meta, palette: await palette([image]), transcript: null, frames: [image], contactSheet: null }
}

// ── Cache + entry point ──

function prune(): void {
  if (!existsSync(ROOT)) return
  for (const name of readdirSync(ROOT)) {
    const p = join(ROOT, name)
    try {
      if (Date.now() - statSync(p).mtimeMs > KEEP_MS) rmSync(p, { recursive: true, force: true })
    } catch { /* raced with another prune */ }
  }
}

const inflight = new Map<string, Promise<LinkMediaOut>>()

export interface BuildOptions {
  timeoutMs?: number
  attempt?: (workDir: string, deadline: number) => Promise<Record<string, unknown>>
}

export async function build(url: URL, dir: string, opts: BuildOptions = {}): Promise<LinkMediaOut> {
  const deadline = Date.now() + (opts.timeoutMs ?? TIMEOUT_MS)
  mkdirSync(dirname(dir), { recursive: true })
  const workDir = `${dir}.attempt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  mkdirSync(workDir, { recursive: true })
  const runAttempt = opts.attempt ?? ((w, d) => imageResponse(url, d).then((img) => (img ? analyseImage(url, img, w) : analyseVideo(url, w, d))))
  const analysis = (async () => runAttempt(workDir, deadline))()
  try {
    const raw = await beforeDeadline(analysis, deadline)
    if (Date.now() >= deadline) throw new MediaError(504, "timed out")
    const frames = Array.isArray(raw.frames) ? raw.frames.map((f) => join(dir, basename(String(f)))) : raw.frames
    const contactSheet = typeof raw.contactSheet === "string" ? join(dir, basename(raw.contactSheet)) : raw.contactSheet
    const result = { ok: true, url: url.href, dir, ...raw, frames, contactSheet }
    writeFileSync(join(workDir, "result.json"), JSON.stringify(result))
    rmSync(dir, { recursive: true, force: true })
    renameSync(workDir, dir)
    return { status: 200, body: { ...result, cached: false } }
  } catch (err) {
    const clean = (): void => rmSync(workDir, { recursive: true, force: true })
    clean()
    analysis.then(clean, clean)
    const e = err instanceof MediaError ? err : new MediaError(502, String((err as Error)?.message ?? err).slice(0, 300))
    companionLog(`[media] ${url.host} failed: ${e.reason}`)
    return { status: e.status, body: { ok: false, error: "media_failed", reason: e.reason } }
  }
}

/** Fetch + analyse one URL (cached per URL for 7 days). Never throws. */
export async function analyseLink(raw: string): Promise<LinkMediaOut> {
  const c = await checkUrl(raw)
  if (!c.ok) return { status: 400, body: { ok: false, error: "bad_url", reason: c.reason } }
  prune()
  const dir = join(ROOT, createHash("sha256").update(c.url.href).digest("hex").slice(0, 16))
  const done = join(dir, "result.json")
  // An unreadable cache file is a miss: the job below writes it again.
  const cached = existsSync(done) ? jsonOrNull<Record<string, unknown>>(readFileSync(done, "utf8")) : null
  if (cached) return { status: 200, body: { ...cached, cached: true } }
  const running = inflight.get(dir)
  if (running) return running
  const job = build(c.url, dir).finally(() => inflight.delete(dir))
  inflight.set(dir, job)
  return job
}
