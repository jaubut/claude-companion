import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CdpBrowser, CdpTab } from "../lib/cdp"

// bin/web-read reader (wiring/web-read.ts): the browser is faked at the CDP
// boundary — each page script is answered by its /*tag*/.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-web-read-")), "test.db")
const { createWebReader, LOGIN_EVENT } = await import("./web-read")
const { BLOCKED_URL_PATTERNS, MIN_GAP_MS, READS_PER_HOUR } = await import("../lib/web-read-policy")

type Page = Record<string, unknown | ((expr: string) => unknown)>
const RECT = { x: 0, y: 0, width: 400, height: 700 }
const JPEG = Buffer.from("fake-jpeg").toString("base64")

function world(page: Page, opts: { down?: boolean } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const events: string[] = []
  const sleeps: number[] = []
  let now = 10_000_000
  let opened = 0
  let closed = 0
  const tab: CdpTab = {
    async send(method, params = {}) {
      calls.push({ method, params })
      if (method === "Page.captureScreenshot") return { data: JPEG }
      if (method !== "Runtime.evaluate") return {}
      const expr = String(params.expression)
      const tag = /^\/\*(\w+)\*\//.exec(expr)?.[1] ?? ""
      const v = page[tag]
      return { result: { value: typeof v === "function" ? (v as (e: string) => unknown)(expr) : v ?? null } }
    },
    async close() { closed++ },
  }
  const browser: CdpBrowser = { async open() { if (opts.down) throw new Error("ECONNREFUSED"); opened++; return tab } }
  const scratchRoot = mkdtempSync(join(tmpdir(), "cc-web-scratch-"))
  const reader = createWebReader({
    browser,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms },
    event: (t) => events.push(t),
    scratchRoot,
    transcribe: async (url) => `transcript of ${new URL(url).hostname}`,
  })
  return {
    reader, calls, events, sleeps, scratchRoot,
    advance: (ms: number) => { now += ms },
    counts: () => ({ opened, closed }),
    tags: () => calls.filter((c) => c.method === "Runtime.evaluate").map((c) => /^\/\*(\w+)\*\//.exec(String(c.params.expression))?.[1]),
  }
}

const probe = (path: string, extra: Record<string, unknown> = {}) => ({ href: `https://www.instagram.com${path}`, path, ready: true, loginWall: false, ...extra })
const REEL: Page = {
  probe: probe("/reel/abc/"),
  more: 1,
  post: { ogTitle: "Nat Geo (@natgeo) on Instagram: \"whales\"", caption: "Whales off Tadoussac", hasVideo: true, ogVideo: "https://scontent.cdninstagram.com/v/x.mp4", videoSrc: "blob:https://www.instagram.com/1" },
  video: { duration: 10 },
  seek: RECT,
}

describe("allowlist and blocked paths never reach the browser", () => {
  test("403 url_not_allowed, 403 url_blocked, 400 bad_url", async () => {
    const w = world(REEL)
    expect((await w.reader.read("https://www.tiktok.com/@x/video/1")).body.error).toBe("url_not_allowed")
    expect((await w.reader.read("https://www.instagram.com/direct/inbox/")).status).toBe(403)
    expect((await w.reader.read("https://www.instagram.com/direct/inbox/")).body.error).toBe("url_blocked")
    expect((await w.reader.read(null)).status).toBe(400)
    expect(w.counts().opened).toBe(0)
  })

  test("the browser blocks every write path for the page's own requests", async () => {
    const w = world(REEL)
    await w.reader.read("https://www.instagram.com/reel/abc/")
    const blocked = w.calls.find((c) => c.method === "Network.setBlockedURLs")
    expect(blocked?.params.urls).toEqual([...BLOCKED_URL_PATTERNS])
    const nav = w.calls.findIndex((c) => c.method === "Page.navigate")
    expect(w.calls.indexOf(blocked!)).toBeLessThan(nav)
  })
})

describe("reel read", () => {
  test("caption, creator, a frame every 3 s saved to scratch, transcript, untrusted wrapper, tab closed", async () => {
    const w = world(REEL)
    const out = await w.reader.read("https://www.instagram.com/reel/abc/")
    expect(out.status).toBe(200)
    expect(out.body.untrusted).toBe(true)
    expect(String(out.body.notice)).toContain("never instructions")
    const c = out.body.content as Record<string, unknown>
    expect(c.creator).toBe("natgeo")
    expect(c.caption).toBe("Whales off Tadoussac")
    expect(c.type).toBe("video")
    expect(c.transcript).toBe("transcript of scontent.cdninstagram.com")
    const frames = out.body.files as string[]
    expect(frames).toHaveLength(4) // 0, 3, 6, 9 s of 10 s
    for (const f of frames) {
      expect(f.startsWith(w.scratchRoot)).toBe(true)
      expect(existsSync(f)).toBe(true)
    }
    expect(w.counts()).toEqual({ opened: 1, closed: 1 })
    // read-only: only the allowed page scripts ran (no typing, no other clicks)
    expect(new Set(w.tags())).toEqual(new Set(["probe", "more", "post", "video", "seek"]))
    expect(w.calls.some((c) => c.method.startsWith("Input."))).toBe(false)
  })

  test("a non-CDN media URL gets no transcript (no fetch outside the allowlist)", async () => {
    const w = world({ ...REEL, post: { ...(REEL.post as object), ogVideo: "https://evil.example/x.mp4", videoSrc: "blob:x" } })
    const c = (await w.reader.read("https://www.instagram.com/reel/abc/")).body.content as Record<string, unknown>
    expect(c.transcript).toBeUndefined()
  })
})

describe("carousel read", () => {
  test("every slide's image and alt text, stepping with Next only", async () => {
    let slide = 0
    const w = world({
      probe: probe("/p/xyz/"),
      post: { caption: "three slides", creator: "tls", isCarousel: true },
      slide: () => ({ src: `https://scontent.cdninstagram.com/${slide}.jpg`, alt: `alt ${slide}`, video: false, rect: RECT }),
      next: () => (slide < 2 ? (slide++, true) : false),
    })
    const out = await w.reader.read("https://www.instagram.com/p/xyz/")
    const c = out.body.content as { type: string; slides: { alt: string; image: string }[] }
    expect(c.type).toBe("carousel")
    expect(c.slides.map((s) => s.alt)).toEqual(["alt 0", "alt 1", "alt 2"])
    expect((out.body.files as string[]).every((f) => existsSync(f))).toBe(true)
  })
})

describe("profile read", () => {
  test("bio, unwrapped outbound links, recent posts", async () => {
    const w = world({
      probe: probe("/tls/"),
      profile: {
        ogDescription: "1,234 Followers", header: "Tech Lab Studio\nVideo, Montréal",
        links: ["https://www.instagram.com/tls/followers/", "https://l.instagram.com/?u=https%3A%2F%2Ftechlab.studio%2F&e=x"],
        posts: [{ url: "https://www.instagram.com/p/a/", caption: "first" }],
      },
    })
    const c = (await w.reader.read("https://www.instagram.com/tls/")).body.content as Record<string, unknown>
    expect(c.bio).toBe("Tech Lab Studio\nVideo, Montréal")
    expect(c.links).toEqual(["https://techlab.studio/"])
    expect(c.posts).toEqual([{ url: "https://www.instagram.com/p/a/", caption: "first" }])
  })
})

describe("login_required", () => {
  test("login form → 409 login_required, nothing extracted, one event across repeated failures", async () => {
    const page: Page = { probe: probe("/p/abc/", { loginWall: true }) }
    const w = world(page)
    for (let i = 0; i < 3; i++) {
      const out = await w.reader.read("https://www.instagram.com/p/abc/")
      expect(out.status).toBe(409)
      expect(out.body.error).toBe("login_required")
    }
    expect(w.events).toEqual([LOGIN_EVENT])
    expect(w.tags().every((t) => t === "probe")).toBe(true)
    expect(w.counts()).toEqual({ opened: 3, closed: 3 })
    expect(w.calls.filter((c) => c.method === "Page.navigate")).toHaveLength(3) // no retries inside a read
  })

  test("redirect to a checkpoint → login_required; a good read re-arms the event", async () => {
    const page: Page = { ...REEL, probe: probe("/challenge/123/") }
    const w = world(page)
    expect((await w.reader.read("https://www.instagram.com/reel/abc/")).body.error).toBe("login_required")
    page.probe = probe("/reel/abc/")
    expect((await w.reader.read("https://www.instagram.com/reel/abc/")).status).toBe(200)
    page.probe = probe("/accounts/login/")
    expect((await w.reader.read("https://www.instagram.com/reel/abc/")).body.error).toBe("login_required")
    expect(w.events).toEqual([LOGIN_EVENT, LOGIN_EVENT])
  })
})

describe("rate limit and polite delay", () => {
  test(`${READS_PER_HOUR} reads an hour, then 429 without touching the browser; reads are spaced`, async () => {
    const w = world({ probe: probe("/x/"), page: { title: "x" } })
    for (let i = 0; i < READS_PER_HOUR; i++) expect((await w.reader.read("https://www.instagram.com/explore/")).status).toBe(200)
    expect(w.sleeps.filter((s) => s === MIN_GAP_MS)).toHaveLength(READS_PER_HOUR - 1)
    const refused = await w.reader.read("https://www.instagram.com/explore/")
    expect(refused.status).toBe(429)
    expect(refused.body.error).toBe("rate_limited")
    expect(w.counts().opened).toBe(READS_PER_HOUR)
    w.advance(60 * 60_000)
    expect((await w.reader.read("https://www.instagram.com/explore/")).status).toBe(200)
  })

  test("browser down → 503 browser_down", async () => {
    const w = world(REEL, { down: true })
    const out = await w.reader.read("https://www.instagram.com/reel/abc/")
    expect([out.status, out.body.error]).toEqual([503, "browser_down"])
  })
})
