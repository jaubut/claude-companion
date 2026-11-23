import { join } from "node:path"
import { type Browser, type BrowserContext, type Page, chromium } from "playwright-core"
import sharp from "sharp"
import { findChromiumExecutable } from "./board-page-capture"
import { extractPage } from "./link-media-extract"
import { checkUrl, startGuardProxy, vetHost } from "./link-media-guard"
import { palette } from "./link-media-palette"

// bin/media's fallback for links yt-dlp can't read (Dribbble shots, Pinterest image pins,
// Behance projects, any page): a headless Chromium with a desktop UA loads the page (bot
// challenges like Dribbble's AWS WAF solve themselves in a real browser), the main images
// are picked from the rendered DOM (link-media-extract.ts) and downloaded through the same
// browser context (cookies + Referer, so pinimg/CDN hotlink checks pass), plus a page
// screenshot. Fresh context every run: no login, nothing stored. Every byte (page, its
// sub-requests, the image downloads) goes through the guard proxy, so the SSRF rules of
// link-media-guard.ts hold here too; the browser is killed at the job deadline.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const VIEW_W = 1440
const VIEW_H = 900
const FRAME_WIDTH = 768
const SHOT_MAX_H = 8_000
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_PAGE_BYTES = 150 * 1024 * 1024
export const OVER = `page over ${MAX_PAGE_BYTES / 1024 / 1024} MB`
export const CHALLENGED_ERR = "page blocked by bot challenge"
const SCREENSHOT_RESERVE_MS = 15_000
const TILE = 256
const COLS = 4

export const CHROMIUM_PROXY_BYPASS = "<-loopback>"
export const CHROMIUM_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
]
export const CHROMIUM_NO_SANDBOX_ARGS = ["--no-sandbox", "--disable-setuid-sandbox"]

const left = (deadline: number, max: number): number => Math.max(1, Math.min(max, deadline - Date.now()))

// Scroll down in steps so lazy images mount, then back to the top.
const SCROLL = `(async () => {
  const end = Math.min(document.documentElement.scrollHeight, ${SHOT_MAX_H});
  for (let y = 800; y < end; y += 800) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 200)); }
  window.scrollTo(0, 0);
})()`

// Stamp each <img> with its rendered width and the source the browser picked, for the extractor.
const STAMP = `(() => {
  for (const img of Array.from(document.images)) {
    img.setAttribute("data-media-w", String(Math.round(img.getBoundingClientRect().width)));
    if (img.currentSrc && !img.currentSrc.startsWith("data:")) img.setAttribute("data-media-src", img.currentSrc);
  }
})()`

const challenged = (page: Pick<Page, "evaluate">): Promise<boolean> =>
  page.evaluate(`!!document.getElementById("challenge-container")`).then(Boolean, () => true)

export async function allowPageRequest(rawUrl: string, check: typeof checkUrl = checkUrl): Promise<boolean> {
  if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:")) return true
  return (await check(rawUrl)).ok
}

export async function installRouteGuard(page: Pick<Page, "route">, check: typeof checkUrl = checkUrl): Promise<void> {
  await page.route("**/*", async (route) => {
    if (await allowPageRequest(route.request().url(), check)) {
      await route.continue().catch(() => {})
    } else {
      await route.abort("blockedbyclient").catch(() => {})
    }
  })
}

export function isSandboxLaunchError(err: unknown): boolean {
  return /no usable sandbox|sandbox|setuid|userns|user_namespaces|namespace|zygote|running as root/i.test(
    String((err as Error)?.message ?? err),
  )
}

export async function launchChromium(
  executablePath: string,
  proxyUrl: string,
  deadline: number,
  launch: typeof chromium.launch = (opts) => chromium.launch(opts),
): Promise<Browser> {
  const base = {
    executablePath,
    headless: true,
    proxy: { server: proxyUrl, bypass: CHROMIUM_PROXY_BYPASS },
  }
  try {
    return await launch({ ...base, timeout: left(deadline, 30_000), args: CHROMIUM_ARGS })
  } catch (err) {
    if (!isSandboxLaunchError(err) || Date.now() >= deadline) throw err
    return launch({ ...base, timeout: left(deadline, 30_000), args: [...CHROMIUM_NO_SANDBOX_ARGS, ...CHROMIUM_ARGS] })
  }
}

export async function loadPage(page: Page, url: URL, deadline: number, sleepMs = 1_000): Promise<void> {
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: left(deadline, 30_000) })
  for (let i = 0; i < 15 && Date.now() < deadline && (await challenged(page)); i++) await Bun.sleep(sleepMs)
  if (await challenged(page)) throw new Error(CHALLENGED_ERR)
  await page.waitForLoadState("networkidle", { timeout: left(deadline, 10_000) }).catch(() => {})
  await page.evaluate(SCROLL).catch(() => {})
  await page.waitForLoadState("networkidle", { timeout: left(deadline, 5_000) }).catch(() => {})
  await page.evaluate(STAMP)
}

/** The first candidate that answers with an image under the size cap. */
export async function fetchFirst(
  ctx: Pick<BrowserContext, "request">,
  urls: string[],
  referer: string,
  deadline: number,
  check: typeof checkUrl = checkUrl,
): Promise<Buffer | null> {
  for (const u of urls) {
    if (!(await check(u)).ok) continue
    const res = await ctx.request
      .get(u, { headers: { Referer: referer, Accept: "image/avif,image/webp,image/*,*/*;q=0.8" }, timeout: left(deadline, 20_000), maxRedirects: 5 })
      .catch(() => null)
    if (!res) continue
    const body = res.ok() && (res.headers()["content-type"] ?? "").startsWith("image/") ? await res.body().catch(() => null) : null
    await res.dispose()
    if (body && body.length <= MAX_IMAGE_BYTES) return body
  }
  return null
}

async function saveImages(ctx: BrowserContext, images: string[][], referer: string, dir: string, deadline: number): Promise<string[]> {
  const frames: string[] = []
  for (const urls of images) {
    if (Date.now() > deadline - SCREENSHOT_RESERVE_MS) break
    const buf = await fetchFirst(ctx, urls, referer, deadline)
    if (!buf) continue
    const out = join(dir, `frame_${String(frames.length + 1).padStart(2, "0")}.jpg`)
    try {
      await sharp(buf).rotate().resize({ width: FRAME_WIDTH, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(out)
      frames.push(out)
    } catch { /* not a decodable image */ }
  }
  return frames
}

async function screenshot(page: Page, dir: string): Promise<string | null> {
  const height = Number(await page.evaluate("document.documentElement.scrollHeight").catch(() => VIEW_H)) || VIEW_H
  const buf = await page
    .screenshot({ type: "jpeg", quality: 80, fullPage: true, clip: { x: 0, y: 0, width: VIEW_W, height: Math.min(height, SHOT_MAX_H) }, timeout: 15_000 })
    .catch(() => null)
  if (!buf) return null
  const out = join(dir, "page.jpg")
  await sharp(buf).resize({ width: FRAME_WIDTH }).jpeg({ quality: 80 }).toFile(out)
  return out
}

/** A grid of 256px tiles, 4 per row, each image letterboxed whole. */
export async function contactSheet(frames: string[], dir: string): Promise<string | null> {
  if (!frames.length) return null
  const tiles = await Promise.all(frames.map((f) => sharp(f).resize(TILE, TILE, { fit: "contain", background: "#111111" }).toBuffer()))
  const out = join(dir, "contact.jpg")
  const rows = Math.ceil(frames.length / COLS)
  await sharp({ create: { width: Math.min(frames.length, COLS) * TILE, height: rows * TILE, channels: 3, background: "#111111" } })
    .composite(tiles.map((input, i) => ({ input, left: (i % COLS) * TILE, top: Math.floor(i / COLS) * TILE })))
    .jpeg({ quality: 80 })
    .toFile(out)
  return out
}

/** Load `url` in headless Chromium and return the bin/media analysis of its images. Throws when nothing usable came back. */
export async function analysePage(url: URL, dir: string, deadline: number): Promise<Record<string, unknown>> {
  if (Date.now() >= deadline) throw new Error("media fetch timed out")
  const executablePath = findChromiumExecutable()
  if (!executablePath) throw new Error("no Chromium installed for the page fallback")
  let browser: Browser | null = null
  const kill = (): void => { void browser?.close().catch(() => {}) }
  const proxy = await startGuardProxy(vetHost, { maxBytes: MAX_PAGE_BYTES, onExceed: kill })
  const watchdog = setTimeout(kill, Math.max(0, deadline - Date.now()))
  try {
    browser = await launchChromium(executablePath, proxy.url, deadline)
    const ctx = await browser.newContext({ viewport: { width: VIEW_W, height: VIEW_H }, userAgent: UA, deviceScaleFactor: 1, serviceWorkers: "block", acceptDownloads: false })
    const page = await ctx.newPage()
    await installRouteGuard(page)
    await loadPage(page, url, deadline)
    const found = extractPage(await page.content(), new URL(page.url()))
    const images = await saveImages(ctx, found.images, page.url(), dir, deadline)
    const shot = await screenshot(page, dir)
    if (proxy.exceeded()) throw new Error(OVER)
    const shown = images.length ? images : shot ? [shot] : []
    if (!shown.length) throw new Error("no images found on the page")
    return {
      kind: "page",
      meta: { source: "browser", uploader: found.author, title: found.title, description: found.description, duration: null },
      palette: await palette(shown), transcript: null,
      frames: shot && images.length ? [...images, shot] : shown,
      contactSheet: await contactSheet(shown, dir),
    }
  } catch (err) {
    if (proxy.exceeded()) throw new Error(OVER) // the quota trip closed the browser mid-step
    if (Date.now() >= deadline) throw new Error("media fetch timed out")
    throw err
  } finally {
    clearTimeout(watchdog)
    await browser?.close().catch(() => {})
    proxy.close()
  }
}
