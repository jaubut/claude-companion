import sharp from "sharp"
import { BOARD_ASSET_MAX_BYTES, saveBoardAsset } from "./board-assets"

// Resolves any pasted public HTTP(S) URL (Pinterest pin/board, direct image, or any web page
// with Open Graph / Twitter / hero images) into locally stored board assets
// (`/api/board/assets/<hash>.<ext>`) with real pixel dimensions.
// Used by `POST /api/board/resolve-url` so pasting a link in Mac or iPad Canvas
// drops the actual image(s) (or a framed board grid) instead of raw link text.

export const RESOLVE_TIMEOUT_MS = 8_000
export const BOARD_MAX_IMAGES = 16

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

export type ResolvedUrlKind = "pin" | "board" | "image"

export interface ResolvedBoardImage {
  src: string
  w: number
  h: number
  mime: string
}

export type ResolveUrlOutcome =
  | { ok: true; kind: ResolvedUrlKind; title: string; sourceUrl: string; images: ResolvedBoardImage[] }
  | { ok: false; status: number; error: string }

export interface ResolveUrlDeps {
  fetch?: typeof fetch
  save?: typeof saveBoardAsset
  probeSize?: (bytes: Uint8Array) => Promise<{ w: number; h: number }>
}

const PRIVATE_HOST_RE =
  /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|\[::1\]$|172\.(?:1[6-9]|2\d|3[01])\.|.*\.local$|.*\.internal$|.*\.ts\.net$)/i

const DIRECT_IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif)(?:[?#].*)?$/i

/** Reject non-http(s) schemes and private/loopback/tailnet hosts (SSRF guard). */
export function parsePublicHttpUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  const host = u.hostname.toLowerCase()
  if (!host || PRIVATE_HOST_RE.test(host)) return null
  return u
}

export function isPinterestHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === "pin.it" || h === "pinterest.com" || h.endsWith(".pinterest.com") || /^pinterest\.[a-z.]{2,6}$/.test(h) || /\.pinterest\.[a-z.]{2,6}$/.test(h)
}

export function isDirectImageUrl(url: URL): boolean {
  const h = url.hostname.toLowerCase()
  if (h === "i.pinimg.com" || h.endsWith(".pinimg.com")) return true
  return DIRECT_IMAGE_EXT_RE.test(url.pathname)
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

export function extractMetaTag(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]) return decodeHtmlEntities(m[1])
  }
  return null
}

/** Upgrade smaller Pinterest thumbnails (`236x`, `474x`, `564x`) to `736x` for crisp canvas rendering. */
export function upgradePinimgUrl(raw: string): string {
  return raw.replace(/^(https:\/\/i\.pinimg\.com\/)(?:236x|474x|564x)\//i, "$1736x/")
}

/**
 * Extract unique high-res `i.pinimg.com` image URLs from a Pinterest page (pin or board).
 * Dedupes by trailing image filename hash so the same pin at 236x & 736x only appears once.
 */
export function extractPinterestImages(html: string, finalUrl: URL, max = BOARD_MAX_IMAGES): { kind: "pin" | "board"; title: string; urls: string[] } {
  const rawTitle = extractMetaTag(html, "og:title") || extractMetaTag(html, "twitter:title") || "Pinterest"
  const title = rawTitle.replace(/\s*[|–—-]\s*Pinterest\s*$/i, "").trim() || "Pinterest"
  const isPin = /\/pin\/\d+/i.test(finalUrl.pathname)

  if (isPin) {
    const og = extractMetaTag(html, "og:image") || extractMetaTag(html, "twitter:image")
    if (og) return { kind: "pin", title, urls: [upgradePinimgUrl(og)] }
  }

  // Board (or pin fallback): collect unique i.pinimg.com image URLs, skipping avatars/75x75/icons.
  const re = /https:\/\/i\.pinimg\.com\/(?:originals|1200x|736x|564x|474x|236x)\/[a-zA-Z0-9/_-]+\.(?:jpg|jpeg|png|webp)/gi
  const byFile = new Map<string, string>()
  const rank = (u: string): number => (u.includes("/originals/") ? 4 : u.includes("/1200x/") ? 3 : u.includes("/736x/") ? 2 : 1)

  for (const m of html.matchAll(re)) {
    const url = upgradePinimgUrl(m[0])
    const file = url.split("/").pop()?.toLowerCase() ?? url
    if (!file || file.includes("default_avatar")) continue
    const prev = byFile.get(file)
    if (!prev || rank(url) > rank(prev)) byFile.set(file, url)
    if (byFile.size >= max * 2) break
  }

  // If a pin page had no og:image, return its first high-res match; for a board, up to `max`.
  const urls = [...byFile.values()].slice(0, isPin ? 1 : max)
  if (urls.length === 0) {
    const og = extractMetaTag(html, "og:image")
    if (og) return { kind: isPin ? "pin" : "board", title, urls: [upgradePinimgUrl(og)] }
  }
  return { kind: isPin ? "pin" : "board", title, urls }
}

function resolveRelativeUrl(candidate: string | null, base: URL): string | null {
  if (!candidate) return null
  const trimmed = candidate.trim()
  if (!trimmed || trimmed.startsWith("data:")) return null
  try {
    const abs = new URL(trimmed, base)
    return parsePublicHttpUrl(abs.toString()) ? abs.toString() : null
  } catch {
    return null
  }
}

function extractTitleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  return m?.[1] ? decodeHtmlEntities(m[1]) : null
}

function extractLinkHref(html: string, rel: string): string | null {
  const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const patterns = [
    new RegExp(`<link[^>]+rel=["']${escaped}["'][^>]+href=["']([^"']+)["']`, "i"),
    new RegExp(`<link[^>]+href=["']([^"']+)["'][^>]+rel=["']${escaped}["']`, "i"),
  ]
  for (const re of patterns) {
    const m = html.match(re)
    if (m?.[1]) return decodeHtmlEntities(m[1])
  }
  return null
}

/**
 * Extract prioritized preview image candidate URLs from any web page:
 * 1. Open Graph (`og:image:secure_url`, `og:image:url`, `og:image`)
 * 2. Twitter Card (`twitter:image:src`, `twitter:image`)
 * 3. `<link rel="image_src">`
 * 4. First non-icon `<img>` on the page as fallback
 */
export function extractGenericPageImages(html: string, finalUrl: URL): { kind: "image"; title: string; urls: string[] } {
  const title =
    extractMetaTag(html, "og:title") ||
    extractMetaTag(html, "twitter:title") ||
    extractTitleTag(html) ||
    finalUrl.hostname

  const rawCandidates: Array<string | null> = [
    extractMetaTag(html, "og:image:secure_url"),
    extractMetaTag(html, "og:image:url"),
    extractMetaTag(html, "og:image"),
    extractMetaTag(html, "twitter:image:src"),
    extractMetaTag(html, "twitter:image"),
    extractLinkHref(html, "image_src"),
  ]

  // Fallback: scan first few <img> tags for a raster image that isn't a tiny icon/logo/pixel.
  const imgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
  let scanned = 0
  for (const m of html.matchAll(imgRe)) {
    const src = decodeHtmlEntities(m[1] ?? "")
    if (!src || src.startsWith("data:") || /\.svg(?:[?#]|$)/i.test(src) || /favicon|sprite|pixel|spacer|1x1/i.test(src)) {
      continue
    }
    rawCandidates.push(src)
    if (++scanned >= 4) break
  }

  const seen = new Set<string>()
  const urls: string[] = []
  for (const c of rawCandidates) {
    const abs = resolveRelativeUrl(c, finalUrl)
    if (abs && !seen.has(abs)) {
      seen.add(abs)
      urls.push(abs)
    }
  }
  return { kind: "image", title, urls }
}

async function defaultProbeSize(bytes: Uint8Array): Promise<{ w: number; h: number }> {
  try {
    const meta = await sharp(bytes).metadata()
    if (meta.width && meta.height) return { w: meta.width, h: meta.height }
  } catch { /* fallback below */ }
  return { w: 480, h: 480 }
}

async function downloadAndSaveImage(
  imgUrl: string,
  fetchFn: typeof fetch,
  saveFn: typeof saveBoardAsset,
  probeFn: (bytes: Uint8Array) => Promise<{ w: number; h: number }>,
): Promise<ResolvedBoardImage | null> {
  const parsed = parsePublicHttpUrl(imgUrl)
  if (!parsed) return null
  try {
    const res = await fetchFn(parsed.toString(), {
      method: "GET",
      headers: { "User-Agent": BROWSER_UA, Accept: "image/webp,image/png,image/jpeg,image/*,*/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const ct = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""
    if (!ct.startsWith("image/")) return null
    if (Number(res.headers.get("content-length") ?? 0) > BOARD_ASSET_MAX_BYTES) return null
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > BOARD_ASSET_MAX_BYTES) return null
    const saved = saveFn(bytes, ct)
    if (!saved.ok) return null
    const { w, h } = await probeFn(bytes)
    return { src: saved.src, w, h, mime: ct }
  } catch {
    return null
  }
}

/** Resolve a pasted Pinterest or image URL into saved board assets. */
export async function resolveBoardUrl(rawUrl: string, deps: ResolveUrlDeps = {}): Promise<ResolveUrlOutcome> {
  const parsed = parsePublicHttpUrl(rawUrl)
  if (!parsed) return { ok: false, status: 400, error: "invalid_url" }

  const fetchFn = deps.fetch ?? fetch
  const saveFn = deps.save ?? saveBoardAsset
  const probeFn = deps.probeSize ?? defaultProbeSize

  // Fast path: direct image URL (including i.pinimg.com).
  if (isDirectImageUrl(parsed)) {
    const img = await downloadAndSaveImage(parsed.toString(), fetchFn, saveFn, probeFn)
    if (!img) return { ok: false, status: 502, error: "image_fetch_failed" }
    const title = parsed.pathname.split("/").pop() || "Image"
    return { ok: true, kind: "image", title, sourceUrl: parsed.toString(), images: [img] }
  }

  // HTML page fetch (Pinterest pin, Pinterest board, pin.it shortlink, or any OG-image page).
  let res: Response
  try {
    res = await fetchFn(parsed.toString(), {
      method: "GET",
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, status: 502, error: "fetch_failed" }
  }
  if (!res.ok) return { ok: false, status: 502, error: `upstream_http_${res.status}` }

  const finalUrl = parsePublicHttpUrl(res.url || parsed.toString()) ?? parsed
  const ct = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? ""

  // Shortlink redirected directly to an image.
  if (ct.startsWith("image/")) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    const saved = saveFn(bytes, ct)
    if (!saved.ok) return { ok: false, status: saved.status, error: saved.error }
    const { w, h } = await probeFn(bytes)
    return { ok: true, kind: "image", title: "Image", sourceUrl: finalUrl.toString(), images: [{ src: saved.src, w, h, mime: ct }] }
  }

  const html = (await res.text()).slice(0, 1_500_000)
  const extracted = isPinterestHost(finalUrl.hostname)
    ? extractPinterestImages(html, finalUrl)
    : extractGenericPageImages(html, finalUrl)

  if (extracted.urls.length === 0) {
    return { ok: false, status: 422, error: "no_images_found" }
  }

  // For a Pinterest board, download up to BOARD_MAX_IMAGES in batches of 4.
  // For a single-image page (pin or generic URL), stop at the first candidate that downloads cleanly.
  const images: ResolvedBoardImage[] = []
  if (extracted.kind === "board") {
    for (let i = 0; i < extracted.urls.length; i += 4) {
      const batch = extracted.urls.slice(i, i + 4)
      const done = await Promise.all(batch.map((u) => downloadAndSaveImage(u, fetchFn, saveFn, probeFn)))
      for (const img of done) if (img) images.push(img)
    }
  } else {
    for (const u of extracted.urls) {
      const img = await downloadAndSaveImage(u, fetchFn, saveFn, probeFn)
      if (img) {
        images.push(img)
        break
      }
    }
  }

  if (images.length === 0) {
    return { ok: false, status: 502, error: "image_download_failed" }
  }

  return {
    ok: true,
    kind: extracted.kind,
    title: extracted.title,
    sourceUrl: finalUrl.toString(),
    images,
  }
}
