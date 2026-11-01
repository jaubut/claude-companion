import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { BRAIN_THREAD } from "../lib/brain"
import { type CdpBrowser, cdpBrowser } from "../lib/cdp"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { OffAllowlistError, readInstagram } from "../lib/web-read-instagram"
import { MIN_GAP_MS, ReadLimiter, UNTRUSTED_NOTICE, checkReadUrl, isAllowedHostUrl } from "../lib/web-read-policy"
import { orchEmit } from "./orchestrator"

// POST /hooks/brain/web-read and /api/web/read (docs/web-read.md): one read at
// a time through the brain's logged-in browser, rate-limited, output wrapped as
// untrusted data. Frames land under SCRATCH_ROOT, which the brain may Read.

export const SCRATCH_ROOT = "/tmp/companion-web-read"
const SCRATCH_TTL_MS = 24 * 60 * 60_000
const TRANSCRIBE_TIMEOUT_MS = 180_000

export interface WebReadDeps {
  browser: CdpBrowser
  now(): number
  sleep(ms: number): Promise<void>
  /** One line in the brain thread. */
  event(text: string): void
  scratchRoot: string
  /** Audio transcript of a CDN media URL, or null when whisper is unavailable. */
  transcribe(mediaUrl: string, dir: string): Promise<string | null>
}

export interface WebReadOut { status: number; body: Record<string, unknown> }

export const LOGIN_EVENT =
  "🔒 web-read: the server browser is logged out of Instagram (or hit a checkpoint). Please log in again: docs/web-read.md → \"Log in\"."

export function createWebReader(deps: WebReadDeps): { read(raw: unknown): Promise<WebReadOut> } {
  const limiter = new ReadLimiter()
  let lastAt = 0
  let loginAlerted = false
  let queue: Promise<unknown> = Promise.resolve()

  async function readOne(url: string): Promise<WebReadOut> {
    const now = deps.now()
    const gate = limiter.check(now)
    if (!gate.ok) return { status: 429, body: { ok: false, error: "rate_limited", retryAfterSec: gate.retryAfterSec } }
    const wait = lastAt + MIN_GAP_MS - now
    if (wait > 0) await deps.sleep(wait)

    let tab
    try { tab = await deps.browser.open() } catch (err) {
      companionLog(`[web-read] browser unreachable: ${(err as Error)?.message ?? err}`)
      return { status: 503, body: { ok: false, error: "browser_down" } }
    }
    // Only a read that reached the browser counts against the budget and the gap.
    lastAt = deps.now()
    limiter.record(lastAt)
    try {
      const dir = scratchDir(deps.scratchRoot, deps.now())
      const io = {
        sleep: deps.sleep,
        save: async (name: string, b64: string): Promise<string> => {
          const path = join(dir, name)
          writeFileSync(path, Buffer.from(b64, "base64"), { mode: 0o600 })
          return path
        },
      }
      const got = await readInstagram(tab, url, io)
      if (got.loginRequired) {
        if (!loginAlerted) { loginAlerted = true; deps.event(LOGIN_EVENT) }
        companionLog(`[web-read] login_required (landed on ${got.path})`)
        return { status: 409, body: { ok: false, error: "login_required", hint: "Logged out or checkpoint. Don't retry; hand the link to the Mac builder and ask Jeremie to log in (docs/web-read.md)." } }
      }
      loginAlerted = false
      const transcript = got.mediaUrl ? await deps.transcribe(got.mediaUrl, dir).catch(() => null) : null
      const data = got.mediaUrl ? { ...got.data, transcript } : got.data
      companionLog(`[web-read] ${got.kind} ok (${got.files.length} files)`)
      return { status: 200, body: { ok: true, untrusted: true, notice: UNTRUSTED_NOTICE, url, finalUrl: got.finalUrl, kind: got.kind, scratchDir: dir, files: got.files, content: data } }
    } catch (err) {
      if (err instanceof OffAllowlistError) {
        companionLog(`[web-read] refused: navigation left the allowlist (${err.url.slice(0, 200)})`)
        return { status: 403, body: { ok: false, error: "url_not_allowed", hint: "The page redirected off instagram.com; nothing was read." } }
      }
      companionLog(`[web-read] read failed: ${(err as Error)?.message ?? err}`)
      return { status: 502, body: { ok: false, error: "read_failed" } }
    } finally {
      await tab.close().catch(() => undefined)
    }
  }

  return {
    read(raw: unknown): Promise<WebReadOut> {
      const check = checkReadUrl(raw)
      if (!check.ok) return Promise.resolve({ status: check.error === "bad_url" ? 400 : 403, body: { ok: false, error: check.error } })
      // ponytail: one global queue, one tab at a time — reads are rare and the account is the bottleneck.
      const run = queue.then(() => readOne(check.url))
      queue = run.catch(() => undefined)
      return run
    },
  }
}

/**
 * A fresh 0700 dir for one read under a 0700 root this user owns. The root
 * lives in /tmp: one another user pre-created (or a symlink) is refused.
 */
export function scratchDir(root: string, now: number): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const st = lstatSync(root)
  if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error(`scratch root ${root} is not ours`)
  if ((st.mode & 0o777) !== 0o700) chmodSync(root, 0o700)
  pruneScratch(root, now)
  const dir = join(root, `${new Date(now).toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { mode: 0o700 })
  return dir
}

/** Drops read dirs older than a day so frames don't pile up. */
export function pruneScratch(root: string, now: number): void {
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    try { if (now - statSync(p).mtimeMs > SCRATCH_TTL_MS) rmSync(p, { recursive: true, force: true }) } catch { /* raced with another prune */ }
  }
}

const WHISPER_DIR = join(homedir(), "whisper.cpp")
const WHISPER_BIN = join(WHISPER_DIR, "build", "bin", "whisper-cli")
const WHISPER_MODEL = process.env.COMPANION_WHISPER_MODEL ?? join(WHISPER_DIR, "models", "ggml-small.bin")

async function run(argv: string[]): Promise<boolean> {
  const p = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  const timer = setTimeout(() => p.kill(), TRANSCRIBE_TIMEOUT_MS)
  try { return (await p.exited) === 0 } finally { clearTimeout(timer) }
}

/** ffmpeg pulls the audio straight from the CDN (allowlisted, https only), whisper.cpp transcribes it. */
async function whisperTranscribe(mediaUrl: string, dir: string): Promise<string | null> {
  if (!isAllowedHostUrl(mediaUrl) || !existsSync(WHISPER_BIN) || !existsSync(WHISPER_MODEL)) return null
  const wav = join(dir, "audio.wav")
  const ok = await run(["ffmpeg", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "https,tls,tcp", "-i", mediaUrl, "-t", "300", "-vn", "-ac", "1", "-ar", "16000", "-y", wav])
  if (!ok) return null
  const base = join(dir, "transcript")
  const done = await run([WHISPER_BIN, "-m", WHISPER_MODEL, "-f", wav, "-l", "auto", "-nt", "-otxt", "-of", base])
  rmSync(wav, { force: true })
  return done && existsSync(`${base}.txt`) ? readFileSync(`${base}.txt`, "utf8").trim().slice(0, 20_000) || null : null
}

let reader: ReturnType<typeof createWebReader> | null = null

/** The real reader (lazy: no browser connection until the first read). */
export function webRead(raw: unknown): Promise<WebReadOut> {
  reader ??= createWebReader({
    browser: cdpBrowser(),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
    scratchRoot: SCRATCH_ROOT,
    transcribe: whisperTranscribe,
  })
  return reader.read(raw)
}
