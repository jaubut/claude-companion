import { extractMetaTag, isPinterestHost } from "./board-url-resolve"

// Picks the main images of a design-reference page (Dribbble shot, Pinterest pin, Behance
// project, or any page) from its rendered HTML, for bin/media's browser fallback
// (link-media-browser.ts). Each image is a list of candidate URLs, best first; the browser
// downloads the first that answers with an image. `data-media-w` is the rendered CSS width
// the browser stamps on every <img> before serialising the DOM: it tells the shot apart from
// avatars and "more like this" thumbnails. Without it (static HTML) the declared width counts.

export interface PageExtract {
  title: string | null
  description: string | null
  author: string | null
  images: string[][]
}

interface Img { urls: string[]; width: number; timing: string }

export const MAX_PAGE_IMAGES = 12
const MIN_WIDTH = 300

/** The candidate with the biggest w/x descriptor in a srcset; null when none parse. */
export function largestSrc(srcset: string): string | null {
  let best: string | null = null
  let bestN = -1
  // Split on ", " or on a comma right before the next absolute URL, so commas inside a URL survive.
  for (const part of srcset.split(/,\s+|,(?=https?:)/)) {
    const [u, d] = part.trim().split(/\s+/)
    const n = Number.parseFloat(d ?? "1")
    if (u && Number.isFinite(n) && n > bestN) { best = u; bestN = n }
  }
  return best
}

const srcsetWidth = (srcset: string): number =>
  Math.max(0, ...[...srcset.matchAll(/\s(\d+)w(?:,|\s*$)/g)].map((m) => Number(m[1])))

function absolute(raw: string | null | undefined, base: URL): string | null {
  if (!raw || raw.startsWith("data:")) return null
  try {
    const u = new URL(raw.replace(/&amp;/g, "&"), base)
    return (u.protocol === "https:" || u.protocol === "http:") && !/\.svg$/i.test(u.pathname) ? u.href : null
  } catch {
    return null
  }
}

/** Bigger versions of a CDN image: the Pinterest original (its URL is in the page JSON), the Dribbble upload without ?resize. */
export function upgrades(raw: string, html: string): string[] {
  const u = new URL(raw)
  if (u.hostname === "i.pinimg.com") {
    const path = u.pathname.match(/^\/[^/]+\/([\w/]+)\.\w+$/)?.[1]
    const orig = path && html.match(new RegExp(`https://i\\.pinimg\\.com/originals/${path}\\.\\w+`))?.[0]
    return orig ? [orig] : []
  }
  if (u.hostname === "cdn.dribbble.com" && u.pathname.startsWith("/userupload/") && u.search) return [u.origin + u.pathname]
  return []
}

const candidates = (raws: Array<string | null | undefined>, base: URL): string[] =>
  [...new Set(raws.map((r) => absolute(r, base)).filter((u): u is string => u !== null))]

const withUpgrades = (urls: string[], html: string): string[] => [...new Set([...upgrades(urls[0]!, html), ...urls])]

function collectImgs(html: string, base: URL): Img[] {
  const imgs: Img[] = []
  let sources: string[] = [] // <source srcset> of the open <picture>
  new HTMLRewriter()
    .on("picture", { element(el) { sources = []; el.onEndTag(() => { sources = [] }) } })
    .on("picture source", { element(el) { const s = largestSrc(el.getAttribute("srcset") ?? ""); if (s) sources.push(s) } })
    .on("img", {
      element(el) {
        const srcset = el.getAttribute("srcset") ?? el.getAttribute("data-srcset") ?? ""
        const raws = [...sources, largestSrc(srcset), el.getAttribute("data-media-src"), el.getAttribute("data-src"), el.getAttribute("src")]
        const urls = candidates(raws, base)
        const stamped = el.getAttribute("data-media-w")
        const width = stamped !== null ? Number(stamped) : Number(el.getAttribute("width")) || srcsetWidth(srcset)
        if (urls.length) imgs.push({ urls, width: Number.isFinite(width) ? width : 0, timing: el.getAttribute("elementtiming") ?? "" })
      },
    })
    .transform(html)
  return imgs
}

/** Which <img> are the page's own work, per site. `null` = no site rule. */
function siteScope(host: string): ((img: Img) => boolean) | null {
  if (isPinterestHost(host)) return (img) => img.timing.startsWith("closeup-image-main")
  if (/(^|\.)behance\.net$/.test(host)) return (img) => img.urls.some((u) => u.includes("/project_modules/"))
  // ponytail: Dribbble attachments rendered as small carousel thumbnails fall under the size cut; add a
  // container rule once a captured shot page shows their markup.
  if (/(^|\.)dribbble\.com$/.test(host)) return (img) => img.urls.some((u) => u.startsWith("https://cdn.dribbble.com/userupload/"))
  return null
}

function mainImages(imgs: Img[], host: string): Img[] {
  const scope = siteScope(host)
  const scoped = scope ? imgs.filter(scope) : imgs
  if (isPinterestHost(host)) return scoped
  const widest = Math.max(0, ...scoped.map((i) => i.width))
  // Behance modules are all the project's own; elsewhere keep what renders at least half as wide as the widest.
  const min = /(^|\.)behance\.net$/.test(host) ? MIN_WIDTH : Math.max(MIN_WIDTH, widest / 2)
  return scoped.filter((i) => i.width >= min)
}

/** Title, description, author and the main images (≤ 12, page order; og:image when nothing else qualifies). */
export function extractPage(html: string, pageUrl: URL): PageExtract {
  const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || null
  const seen = new Set<string>()
  const images: string[][] = []
  for (const img of mainImages(collectImgs(html, pageUrl), pageUrl.hostname)) {
    if (seen.has(img.urls[0]!)) continue
    seen.add(img.urls[0]!)
    images.push(withUpgrades(img.urls, html))
  }
  if (!images.length) {
    const og = candidates([extractMetaTag(html, "og:image"), extractMetaTag(html, "twitter:image")], pageUrl)
    if (og.length) images.push(withUpgrades(og, html))
  }
  return {
    title: extractMetaTag(html, "og:title") ?? titleTag,
    description: extractMetaTag(html, "og:description") ?? extractMetaTag(html, "description"),
    author: extractMetaTag(html, "author") ?? extractMetaTag(html, "og:site_name"),
    images: images.slice(0, MAX_PAGE_IMAGES),
  }
}
