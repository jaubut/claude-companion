import type { CdpTab } from "./cdp"
import { BLOCKED_URL_PATTERNS, type PageKind, isAllowedHostUrl, isAllowedPageUrl, isBlockedUrl, isLoginWallPath, pageKind } from "./web-read-policy"

// Reads one Instagram page in an open CDP tab (docs/web-read.md). Read-only:
// the only clicks are a caption's "more" and a carousel's "Next"; no typing.
// Every page script starts with a /*tag*/ so a test can fake the page by tag.

export const FRAME_EVERY_S = 3
export const MAX_FRAMES = 30
const MAX_SLIDES = 20
const LOAD_TIMEOUT_MS = 20_000
const TEXT_MAX = 5_000

export interface ReadIo {
  sleep(ms: number): Promise<void>
  /** Writes a base64 JPEG into the read's scratch dir; returns its absolute path. */
  save(name: string, base64: string): Promise<string>
}

export type Extracted =
  | { loginRequired: true; path: string }
  | { loginRequired: false; kind: PageKind; finalUrl: string; data: Record<string, unknown>; files: string[]; mediaUrl: string | null }

interface Rect { x: number; y: number; width: number; height: number }

const clip = (v: unknown, max = TEXT_MAX): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)
const isRect = (v: unknown): v is Rect => !!v && typeof v === "object" && ["x", "y", "width", "height"].every((k) => typeof (v as Record<string, unknown>)[k] === "number") && (v as Rect).width > 0 && (v as Rect).height > 0

async function evaluate(tab: CdpTab, expression: string): Promise<unknown> {
  const out = await tab.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (out.exceptionDetails) throw new Error("page script failed")
  const result = out.result as { value?: unknown } | undefined
  return result?.value
}

async function shot(tab: CdpTab, rect: Rect | null): Promise<string> {
  const params: Record<string, unknown> = { format: "jpeg", quality: 70 }
  if (rect) params.clip = { ...rect, scale: 1 }
  const out = await tab.send("Page.captureScreenshot", params)
  if (typeof out.data !== "string") throw new Error("no screenshot")
  return out.data
}

const PROBE = `/*probe*/(() => ({
  href: location.href,
  path: location.pathname,
  ready: document.readyState === "complete" && !!document.querySelector("main article, main header, main video, main h1, main h2"),
  loginWall: !!document.querySelector('input[name="password"]') || !!document.querySelector('a[href^="/accounts/login"]'),
}))()`

const EXPAND_MORE = `/*more*/(() => {
  let n = 0
  for (const el of document.querySelectorAll('main span[role="button"], main div[role="button"], main button')) {
    const t = (el.textContent || "").trim().toLowerCase().replace(/^(…|\\.\\.\\.)\\s*/, "")
    if (t === "more" || t === "plus") { el.click(); n++ }
  }
  return n
})()`

const POST = `/*post*/(() => {
  const meta = (p) => document.querySelector('meta[property="' + p + '"]')?.getAttribute("content") ?? null
  const root = document.querySelector("main article") ?? document.querySelector("main") ?? document.body
  const h1 = root.querySelector("h1")
  const who = root.querySelector('header a[href^="/"]')
  const video = root.querySelector("video")
  return {
    title: document.title,
    ogTitle: meta("og:title"), ogDescription: meta("og:description"), ogImage: meta("og:image"),
    ogVideo: meta("og:video:secure_url") ?? meta("og:video"),
    caption: h1 ? h1.innerText : null,
    creator: who ? (who.getAttribute("href") || "").split("/").filter(Boolean)[0] ?? null : null,
    hasVideo: !!video,
    videoSrc: video ? (video.currentSrc || video.src || null) : null,
    isCarousel: !!root.querySelector('button[aria-label="Next"], button[aria-label="Suivant"]'),
  }
})()`

const SLIDE = `/*slide*/(() => {
  const root = document.querySelector("main article") ?? document.querySelector("main")
  if (!root) return null
  let best = null, area = 0
  for (const el of root.querySelectorAll("ul li img, ul li video")) {
    const r = el.getBoundingClientRect()
    if (r.width < 150 || r.left < -1 || r.right > innerWidth + 1) continue
    if (r.width * r.height > area) { area = r.width * r.height; best = { el, r } }
  }
  if (!best) return null
  const { el, r } = best
  return { src: el.currentSrc || el.src || el.poster || null, alt: el.alt || null, video: el.tagName === "VIDEO",
    rect: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height } }
})()`

const NEXT = `/*next*/(() => {
  const b = document.querySelector('main button[aria-label="Next"], main button[aria-label="Suivant"]')
  if (!b) return false
  b.click()
  return true
})()`

const VIDEO_PREP = `/*video*/(async () => {
  const v = document.querySelector("main video") ?? document.querySelector("video")
  if (!v) return null
  v.muted = true
  v.pause()
  for (let i = 0; i < 50 && v.readyState < 1; i++) await new Promise((r) => setTimeout(r, 100))
  return { duration: Number.isFinite(v.duration) ? v.duration : null }
})()`

const seekScript = (t: number): string => `/*seek*/(async () => {
  const v = document.querySelector("main video") ?? document.querySelector("video")
  if (!v) return null
  await new Promise((resolve) => { v.addEventListener("seeked", resolve, { once: true }); setTimeout(resolve, 3000); v.currentTime = ${t} })
  const r = v.getBoundingClientRect()
  return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }
})()`

const PROFILE = `/*profile*/(() => {
  const meta = (p) => document.querySelector('meta[property="' + p + '"]')?.getAttribute("content") ?? null
  const header = document.querySelector("main header")
  const seen = new Set()
  const posts = []
  for (const a of document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')) {
    if (seen.has(a.href) || posts.length >= 12) continue
    seen.add(a.href)
    posts.push({ url: a.href, caption: a.querySelector("img")?.alt || null })
  }
  return {
    title: document.title, ogTitle: meta("og:title"), ogDescription: meta("og:description"),
    header: header ? header.innerText : null,
    links: header ? [...header.querySelectorAll("a[href]")].map((a) => a.href) : [],
    posts,
  }
})()`

const PAGE = `/*page*/(() => {
  const meta = (p) => document.querySelector('meta[property="' + p + '"]')?.getAttribute("content") ?? null
  return { title: document.title, ogTitle: meta("og:title"), ogDescription: meta("og:description"),
    text: (document.querySelector("main") ?? document.body).innerText }
})()`

interface Probe { href: string; path: string; ready: boolean; loginWall: boolean }
const asProbe = (v: unknown): Probe | null => {
  const p = v as Partial<Probe> | null
  return p && typeof p.path === "string" && typeof p.href === "string" ? { href: p.href, path: p.path, ready: p.ready === true, loginWall: p.loginWall === true } : null
}

/** The navigation (a redirect hop or where it landed) left the allowlist: refused, nothing is read. */
export class OffAllowlistError extends Error {
  constructor(readonly url: string) { super("navigation left the allowlist") }
}

/**
 * Navigates and waits for content or a login wall. Every main-frame document
 * request (each redirect hop included) and the final href must be an
 * allowlisted page. A page that never gets ready throws: it is not a read.
 */
async function load(tab: CdpTab, url: string, io: ReadIo): Promise<Probe> {
  const docs: { frameId: unknown; url: string }[] = []
  tab.on("Network.requestWillBeSent", (p) => {
    const req = p.request as { url?: unknown } | undefined
    if (p.type === "Document" && typeof req?.url === "string") docs.push({ frameId: p.frameId, url: req.url })
  })
  await tab.send("Network.enable")
  await tab.send("Network.setBlockedURLs", { urls: [...BLOCKED_URL_PATTERNS] })
  const nav = await tab.send("Page.navigate", { url })
  if (typeof nav.errorText === "string" && nav.errorText) throw new Error(`navigate: ${nav.errorText}`)
  const checkChain = (): void => {
    const off = docs.find((d) => d.frameId === nav.frameId && !isAllowedPageUrl(d.url))
    if (off) throw new OffAllowlistError(off.url)
  }
  for (let waited = 0; waited < LOAD_TIMEOUT_MS; waited += 500) {
    checkChain()
    const last = asProbe(await evaluate(tab, PROBE))
    if (last && last.href !== "about:blank") {
      if (!isAllowedPageUrl(last.href)) throw new OffAllowlistError(last.href)
      if (last.ready || last.loginWall || isLoginWallPath(last.path)) { checkChain(); return last }
    }
    await io.sleep(500)
  }
  throw new Error("page did not load in time")
}

/** Instagram's outbound links go through l.instagram.com/?u=<target>. */
function outboundLink(href: string): string | null {
  try {
    const u = new URL(href)
    if (u.hostname === "l.instagram.com") return u.searchParams.get("u")
    if (/(^|\.)instagram\.com$/.test(u.hostname)) return null
    return u.href
  } catch {
    return null
  }
}

/** "Name (@user) on Instagram…" / "user on Instagram: …" → user. */
export function creatorFromTitle(title: string | null): string | null {
  if (!title) return null
  const m = /\(@([A-Za-z0-9._]{1,30})\)/.exec(title) ?? /^([A-Za-z0-9._]{1,30}) on Instagram/.exec(title)
  return m ? m[1]! : null
}

async function readFrames(tab: CdpTab, io: ReadIo): Promise<{ frames: string[]; durationSec: number | null }> {
  const prep = await evaluate(tab, VIDEO_PREP) as { duration?: unknown } | null
  if (!prep) return { frames: [], durationSec: null }
  const duration = typeof prep.duration === "number" && prep.duration > 0 ? prep.duration : null
  const count = Math.min(MAX_FRAMES, duration === null ? 10 : Math.max(1, Math.ceil(duration / FRAME_EVERY_S)))
  const frames: string[] = []
  for (let i = 0; i < count; i++) {
    const rect = await evaluate(tab, seekScript(i * FRAME_EVERY_S))
    if (!isRect(rect)) break
    frames.push(await io.save(`frame-${String(i).padStart(2, "0")}-${i * FRAME_EVERY_S}s.jpg`, await shot(tab, rect)))
  }
  return { frames, durationSec: duration }
}

async function readSlides(tab: CdpTab, io: ReadIo): Promise<{ index: number; image: string; alt: string | null; video: boolean }[]> {
  const slides: { index: number; image: string; alt: string | null; video: boolean }[] = []
  const seen = new Set<string>()
  for (let i = 0; i < MAX_SLIDES; i++) {
    const s = await evaluate(tab, SLIDE) as { src?: unknown; alt?: unknown; video?: unknown; rect?: unknown } | null
    const key = typeof s?.src === "string" ? s.src : `slide-${i}`
    if (s && !seen.has(key)) {
      seen.add(key)
      const image = await io.save(`slide-${String(slides.length + 1).padStart(2, "0")}.jpg`, await shot(tab, isRect(s.rect) ? s.rect : null))
      slides.push({ index: slides.length + 1, image, alt: clip(s.alt, 2_000), video: s.video === true })
    }
    if (await evaluate(tab, NEXT) !== true) break
    await io.sleep(900)
  }
  return slides
}

async function readPost(tab: CdpTab, kind: PageKind, io: ReadIo): Promise<{ data: Record<string, unknown>; files: string[]; mediaUrl: string | null }> {
  await evaluate(tab, EXPAND_MORE)
  const p = (await evaluate(tab, POST) ?? {}) as Record<string, unknown>
  const creator = clip(p.creator, 60) ?? creatorFromTitle(clip(p.ogTitle))
  const base = { creator, caption: clip(p.caption) ?? clip(p.ogDescription), title: clip(p.ogTitle) ?? clip(p.title, 300) }
  if (p.isCarousel === true) {
    const slides = await readSlides(tab, io)
    return { data: { ...base, type: "carousel", slides }, files: slides.map((s) => s.image), mediaUrl: null }
  }
  if (kind === "reel" || p.hasVideo === true) {
    const { frames, durationSec } = await readFrames(tab, io)
    const media = [p.ogVideo, p.videoSrc].find((v): v is string => typeof v === "string" && isAllowedHostUrl(v)) ?? null
    return { data: { ...base, type: "video", durationSec, frameEverySec: FRAME_EVERY_S, frames }, files: frames, mediaUrl: media }
  }
  const image = await io.save("image.jpg", await shot(tab, null))
  return { data: { ...base, type: "image", image, imageUrl: clip(p.ogImage, 2_000) }, files: [image], mediaUrl: null }
}

async function readProfile(tab: CdpTab): Promise<Record<string, unknown>> {
  const p = (await evaluate(tab, PROFILE) ?? {}) as Record<string, unknown>
  const links = Array.isArray(p.links) ? [...new Set(p.links.filter((h): h is string => typeof h === "string").map(outboundLink).filter((h): h is string => !!h))] : []
  const posts = Array.isArray(p.posts) ? (p.posts as { url?: unknown; caption?: unknown }[]).map((x) => ({ url: clip(x.url, 500), caption: clip(x.caption, 1_000) })).filter((x) => x.url) : []
  return { type: "profile", title: clip(p.ogTitle) ?? clip(p.title, 300), summary: clip(p.ogDescription), bio: clip(p.header, 3_000), links, posts }
}

/** Opens `url` in `tab` and reads it by kind. The caller owns the tab (opens and closes it). */
export async function readInstagram(tab: CdpTab, url: string, io: ReadIo): Promise<Extracted> {
  const probe = await load(tab, url, io)
  if (probe.loginWall || isLoginWallPath(probe.path)) return { loginRequired: true, path: probe.path }
  if (isBlockedUrl(probe.href)) throw new Error("landed on a blocked page")
  const kind = pageKind(probe.href)
  if (kind === "post" || kind === "reel") return { loginRequired: false, kind, finalUrl: probe.href, ...(await readPost(tab, kind, io)) }
  if (kind === "profile") return { loginRequired: false, kind, finalUrl: probe.href, data: await readProfile(tab), files: [], mediaUrl: null }
  const p = (await evaluate(tab, PAGE) ?? {}) as Record<string, unknown>
  return { loginRequired: false, kind, finalUrl: probe.href, data: { type: "page", title: clip(p.ogTitle) ?? clip(p.title, 300), summary: clip(p.ogDescription), text: clip(p.text) }, files: [], mediaUrl: null }
}
