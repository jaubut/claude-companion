import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import { checkUrl, guardProxy, safeFetch } from "./link-media-guard"
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
const MAX_VIDEO_BYTES = 200 * 1024 * 1024
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
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

/** Run a command in its own process group; at the deadline the whole group (yt-dlp's ffmpeg too) is killed. */
export async function run(cmd: string[], deadline: number): Promise<RunResult> {
  const left = deadline - Date.now()
  if (left <= 0) throw new MediaError(504, "timed out")
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true, env: { ...process.env, NO_PROXY: "", no_proxy: "" } })
  const timer = setTimeout(() => {
    try {
      process.kill(-proc.pid, "SIGKILL")
    } catch {
      proc.kill("SIGKILL")
    }
  }, left)
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  if (Date.now() >= deadline) throw new MediaError(504, "timed out")
  return { code, stdout, stderr }
}

/** yt-dlp flags: no host config, and every request (ffmpeg's too) through the guard proxy. */
export const ytArgs = (proxy: string): string[] => ["--ignore-config", "--proxy", proxy, "--no-warnings", "--no-playlist", "--no-progress", "--socket-timeout", "20"]
// Only formats fetched over http(s)/HLS/DASH: ffmpeg would open rtmp:// and
// friends directly, past the guard proxy.
const SAFE_PROTOCOL = "[protocol~='^(https?|m3u8(_native)?|http_dash_segments)$']"
export const VIDEO_FORMAT = ["bv*[width<=?1080]", "b[width<=?1080]", "bv*", "b"].map((f) => f + SAFE_PROTOCOL).join("/")
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

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

function hasCaptions(raw: Record<string, unknown>): boolean {
  const n = (v: unknown): number => (v && typeof v === "object" ? Object.keys(v).length : 0)
  return n(raw.subtitles) + n(raw.automatic_captions) > 0
}

async function ytInfo(url: string, deadline: number): Promise<Info | { error: string }> {
  const r = await run([YTDLP, ...ytArgs(await guardProxy()), "-J", "--skip-download", url], deadline)
  if (r.code !== 0) return { error: r.stderr.trim().split("\n").pop()?.slice(0, 300) ?? "yt-dlp failed" }
  const raw = JSON.parse(r.stdout) as Record<string, unknown>
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
  const videoUrl = m ? JSON.parse(`"${m[1]}"`) as string : null
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
    const long = (info.meta.duration ?? 0) > MAX_SECONDS ? ["--download-sections", `*0-${MAX_SECONDS}`] : []
    const r = await run([YTDLP, ...ytArgs(await guardProxy()), "-f", VIDEO_FORMAT, "--max-filesize", "200M", ...long, "-o", join(dir, "video.%(ext)s"), url], deadline)
    if (r.code !== 0) throw new MediaError(502, `download failed: ${r.stderr.trim().split("\n").pop()?.slice(0, 300)}`)
  }
  const v = findVideo(dir)
  if (!v) throw new MediaError(413, "video over 200 MB (not downloaded)")
  return v
}

async function probeDuration(video: string, deadline: number): Promise<number> {
  const r = await run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video], deadline)
  const d = Number(r.stdout.trim())
  if (!Number.isFinite(d) || d <= 0) throw new MediaError(422, "unreadable video")
  return Math.min(d, MAX_SECONDS)
}

async function extractFrames(video: string, duration: number, dir: string, deadline: number): Promise<string[]> {
  const frames: string[] = []
  for (let i = 0; i < FRAMES; i++) {
    const out = join(dir, `frame_${String(i + 1).padStart(2, "0")}.jpg`)
    const t = ((i + 0.5) * duration / FRAMES).toFixed(2)
    await run(["ffmpeg", "-v", "error", "-y", "-ss", t, "-i", video, "-frames:v", "1", "-vf", `scale='min(${FRAME_WIDTH},iw)':-2`, "-q:v", "3", out], deadline)
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

/** Caption text from a WebVTT file, cue lines deduped (auto-captions repeat). */
export function vttText(vtt: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const l of vtt.split("\n")) {
    const line = l.replace(/<[^>]+>/g, "").trim()
    if (!line || line === "WEBVTT" || /^(NOTE|Kind:|Language:)/.test(line) || line.includes("-->") || /^\d+$/.test(line) || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out.join("\n")
}

async function transcript(url: string, info: Info, dir: string, deadline: number): Promise<string | null> {
  if (!info.raw || !hasCaptions(info.raw)) return null
  const langs = [text(info.raw.language), "en.*", "fr.*"].filter(Boolean).join(",")
  await run([YTDLP, ...ytArgs(await guardProxy()), "--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", langs, "--sub-format", "vtt", "-o", join(dir, "subs.%(ext)s"), url], deadline)
  const vtt = readdirSync(dir).find((n) => n.startsWith("subs.") && n.endsWith(".vtt"))
  if (!vtt) return null
  const t = vttText(readFileSync(join(dir, vtt), "utf8"))
  return t.length > TRANSCRIPT_MAX ? `${t.slice(0, TRANSCRIPT_MAX - 1)}…` : t || null
}

async function analyseVideo(url: URL, dir: string, deadline: number): Promise<Record<string, unknown>> {
  const info = await fetchInfo(url, deadline)
  const video = await download(url.href, info, dir, deadline)
  const duration = await probeDuration(video, deadline)
  const frames = await extractFrames(video, duration, dir, deadline)
  const sheet = await contactSheet(dir, deadline)
  const colours: Swatch[] = await palette(frames)
  const captions = await transcript(url.href, info, dir, deadline).catch(() => null)
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

async function build(url: URL, dir: string): Promise<LinkMediaOut> {
  const deadline = Date.now() + TIMEOUT_MS
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  try {
    const analysis = imageResponse(url, deadline).then((img) => (img ? analyseImage(url, img, dir) : analyseVideo(url, dir, deadline)))
    const result = { ok: true, url: url.href, dir, ...await beforeDeadline(analysis, deadline) }
    writeFileSync(join(dir, "result.json"), JSON.stringify(result))
    return { status: 200, body: { ...result, cached: false } }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
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
  if (existsSync(done)) return { status: 200, body: { ...JSON.parse(readFileSync(done, "utf8")) as Record<string, unknown>, cached: true } }
  const running = inflight.get(dir)
  if (running) return running
  const job = build(c.url, dir).finally(() => inflight.delete(dir))
  inflight.set(dir, job)
  return job
}
