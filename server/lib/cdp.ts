import { type ChildProcess, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"

// Chrome DevTools Protocol for the brain's read-only browser (docs/web-read.md).
// The companion server spawns Chromium itself with --remote-debugging-pipe and
// talks to it on fd 3/4: there is no debugging port, so no other local process
// can drive the logged-in session.

type Params = Record<string, unknown>

export interface CdpTab {
  send(method: string, params?: Params): Promise<Params>
  /** Calls `fn` for every `method` event this tab receives from now on. */
  on(method: string, fn: (params: Params) => void): void
  close(): Promise<void>
}

export interface CdpBrowser {
  /** A fresh blank tab. Starts the browser on first use; throws when it can't. */
  open(): Promise<CdpTab>
}

const CALL_TIMEOUT_MS = 30_000
/** Deadline for a freshly spawned browser to answer on the pipe. */
export const CONNECT_TIMEOUT_MS = 15_000
export const WEB_PROFILE_DIR = join(homedir(), ".claude-companion", "web-browser-profile")
const DISPLAY = `:${process.env.COMPANION_WEB_DISPLAY ?? "99"}`

interface Pending { resolve: (v: Params) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
interface Message { id?: unknown; method?: unknown; params?: Params; result?: Params; error?: { message?: string }; sessionId?: unknown }

/** One CDP pipe: NUL-framed JSON messages, flat sessions (Target.attachToTarget flatten). */
export class CdpConnection {
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, ((p: Params) => void)[]>()
  private next = 1
  private buf = ""
  private closedWhy: string | null = null

  constructor(private readonly write: (frame: string) => void) {}

  /** Bytes from the browser (fd 4), already utf8-decoded. */
  feed(chunk: string): void {
    this.buf += chunk
    for (let i = this.buf.indexOf("\0"); i >= 0; i = this.buf.indexOf("\0")) {
      const frame = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      this.dispatch(frame)
    }
  }

  send(method: string, params: Params = {}, sessionId?: string, timeoutMs = CALL_TIMEOUT_MS): Promise<Params> {
    if (this.closedWhy) return Promise.reject(new Error(this.closedWhy))
    return new Promise((resolve, reject) => {
      const id = this.next++
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp: ${method} timed out`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write(`${JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })}\0`)
    })
  }

  on(sessionId: string, method: string, fn: (p: Params) => void): void {
    const key = `${sessionId}|${method}`
    this.listeners.set(key, [...(this.listeners.get(key) ?? []), fn])
  }

  off(sessionId: string): void {
    for (const key of [...this.listeners.keys()]) if (key.startsWith(`${sessionId}|`)) this.listeners.delete(key)
  }

  fail(why: string): void {
    this.closedWhy ??= why
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)) }
    this.pending.clear()
    this.listeners.clear()
  }

  private dispatch(frame: string): void {
    let msg: Message
    try { msg = JSON.parse(frame) as Message } catch { return }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(`cdp: ${msg.error.message ?? "error"}`))
      else p.resolve(msg.result ?? {})
    } else if (typeof msg.method === "string" && typeof msg.sessionId === "string") {
      for (const fn of this.listeners.get(`${msg.sessionId}|${msg.method}`) ?? []) fn(msg.params ?? {})
    }
  }
}

/** COMPANION_WEB_CHROME, else the newest Playwright Chromium (scripts/web-browser.sh setup). */
function chromeBin(): string | null {
  if (process.env.COMPANION_WEB_CHROME) return process.env.COMPANION_WEB_CHROME
  const root = join(homedir(), ".cache", "ms-playwright")
  if (!existsSync(root)) return null
  const builds = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  for (const b of builds) {
    for (const sub of ["chrome-linux64", "chrome-linux"]) {
      const p = join(root, b, sub, "chrome")
      if (existsSync(p)) return p
    }
  }
  return null
}

async function launch(profile: string): Promise<{ conn: CdpConnection; child: ChildProcess }> {
  const bin = chromeBin()
  if (!bin) throw new Error("cdp: Chromium not installed (scripts/web-browser.sh setup)")
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  chmodSync(profile, 0o700)
  // A crash leaves the profile locked; only this server ever uses the profile.
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(join(profile, f), { force: true })
  const child = spawn(bin, [
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "--no-first-run", "--no-default-browser-check",
    "--disable-features=Translate,MediaRouter",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,1000", "--window-position=0,0",
    "about:blank",
  ], { env: { ...process.env, DISPLAY }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] })
  const toBrowser = child.stdio[3] as Writable
  const fromBrowser = child.stdio[4] as Readable
  const conn = new CdpConnection((frame) => toBrowser.write(frame))
  fromBrowser.setEncoding("utf8")
  fromBrowser.on("data", (chunk: string) => conn.feed(chunk))
  toBrowser.on("error", () => conn.fail("cdp: pipe closed"))
  child.once("exit", () => conn.fail("cdp: browser exited"))
  child.once("error", (err) => conn.fail(`cdp: ${err.message}`))
  process.once("exit", () => child.kill())
  try {
    await conn.send("Browser.getVersion", {}, undefined, CONNECT_TIMEOUT_MS)
  } catch (err) {
    child.kill()
    throw err
  }
  return { conn, child }
}

export function cdpBrowser(profile = WEB_PROFILE_DIR): CdpBrowser {
  let live: Promise<{ conn: CdpConnection; child: ChildProcess }> | null = null
  const browser = (): Promise<{ conn: CdpConnection; child: ChildProcess }> => {
    if (live) return live
    const started = launch(profile)
    live = started
    const reset = (): void => { if (live === started) live = null }
    started.then(({ child }) => child.once("exit", reset), reset)
    return started
  }
  return {
    async open(): Promise<CdpTab> {
      const { conn } = await browser()
      const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" })
      if (typeof targetId !== "string") throw new Error("cdp: unexpected target")
      const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true })
      if (typeof sessionId !== "string") throw new Error("cdp: attach failed")
      return {
        send: (method, params) => conn.send(method, params, sessionId),
        on: (method, fn) => conn.on(sessionId, method, fn),
        async close(): Promise<void> {
          conn.off(sessionId)
          await conn.send("Target.closeTarget", { targetId }).catch(() => undefined)
        },
      }
    },
  }
}
