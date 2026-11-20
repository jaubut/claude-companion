import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"
import { parsePublicHttpUrl } from "./board-url-resolve"

export const CAPTURE_VIEWPORT_W = 1440
export const CAPTURE_VIEWPORT_H = 900
export const CAPTURE_MAX_HEIGHT = 12_000
export const CAPTURE_NAV_TIMEOUT_MS = 15_000

const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export interface CapturedPage {
  bytes: Uint8Array
  mime: "image/jpeg"
  title: string
  finalUrl: string
}

/** Locate an installed Chromium / headless-shell binary without downloading browsers. */
export function findChromiumExecutable(): string | null {
  const envPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROME_PATH
  if (envPath && existsSync(envPath)) return envPath

  const cacheRoots = [
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ]

  for (const root of cacheRoots) {
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root).sort().reverse()
    } catch {
      continue
    }
    // Prefer full chromium over headless_shell for best font/CSS/canvas fidelity, newest revision first.
    const ordered = [
      ...entries.filter((e) => /^chromium-\d+/.test(e)),
      ...entries.filter((e) => /^chromium_headless_shell-\d+/.test(e)),
    ]
    for (const dir of ordered) {
      const candidates = [
        join(root, dir, "chrome-linux64", "chrome"),
        join(root, dir, "chrome-linux", "chrome"),
        join(root, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        join(root, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(root, dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      ]
      for (const c of candidates) {
        if (existsSync(c)) return c
      }
    }
  }

  const systemPaths = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]
  for (const p of systemPaths) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Render a public HTTP(S) web page at 1440px desktop width and capture a full-page
 * JPEG screenshot (capped at CAPTURE_MAX_HEIGHT) with SSRF route filtering.
 * Returns null if Chromium is unavailable or rendering fails.
 */
export async function captureFullPageScreenshot(url: string): Promise<CapturedPage | null> {
  const parsed = parsePublicHttpUrl(url)
  if (!parsed) return null

  const executablePath = findChromiumExecutable()
  if (!executablePath) return null

  const browser = await chromium
    .launch({
      executablePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--hide-scrollbars",
      ],
    })
    .catch(() => null)
  if (!browser) return null

  try {
    const context = await browser.newContext({
      viewport: { width: CAPTURE_VIEWPORT_W, height: CAPTURE_VIEWPORT_H },
      deviceScaleFactor: 1,
      userAgent: DESKTOP_UA,
    })
    const page = await context.newPage()

    // SSRF guard: abort any sub-request to private/loopback/tailnet hosts.
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url()
      if (reqUrl.startsWith("data:") || reqUrl.startsWith("blob:") || parsePublicHttpUrl(reqUrl)) {
        return route.continue()
      }
      return route.abort("blockedbyclient")
    })

    await page.goto(parsed.toString(), {
      waitUntil: "domcontentloaded",
      timeout: CAPTURE_NAV_TIMEOUT_MS,
    })

    // Give assets & web fonts a brief window to finish loading.
    await Promise.race([
      page.waitForLoadState("networkidle").catch(() => {}),
      new Promise((r) => setTimeout(r, 3_500)),
    ])
    await page
      .evaluate("Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 1200))])")
      .catch(() => {})

    // Scroll through the page in steps to trigger lazy-loaded images and scroll reveals.
    const totalHeight = await page.evaluate(
      `(async () => {
        const maxH = ${CAPTURE_MAX_HEIGHT};
        const getH = () => Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0, 900);
        const target = Math.min(getH(), maxH);
        const step = 800;
        let steps = 0;
        for (let y = step; y < target && steps < 14; y += step, steps++) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 110));
        }
        window.scrollTo(0, 0);
        await new Promise((r) => setTimeout(r, 250));
        return Math.max(900, Math.min(getH(), maxH));
      })()`,
    ) as number

    const buf = await page.screenshot({
      type: "jpeg",
      quality: 88,
      clip: { x: 0, y: 0, width: CAPTURE_VIEWPORT_W, height: totalHeight },
    })

    const title = (await page.title().catch(() => "")).trim() || parsed.hostname
    const finalUrl = parsePublicHttpUrl(page.url())?.toString() ?? parsed.toString()
    return {
      bytes: new Uint8Array(buf),
      mime: "image/jpeg",
      title,
      finalUrl,
    }
  } catch {
    return null
  } finally {
    await browser.close().catch(() => {})
  }
}
