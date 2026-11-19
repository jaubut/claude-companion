import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import manifest from "../../canvas-lib/byq/manifest.json"
import { sniff } from "./board-assets"

// BYQ Supply, the canvas's first block library (canvas auto-layout S1).
// BYQ's licence forbids repackaging and this repo is public: no BYQ source is
// ever committed. canvas-lib/byq/manifest.json (metadata only) is; the
// sources stay in the private mirror (~/work/byq-lib on Zettlab, $BYQ_LIB) and
// scripts/byq-sync.ts copies the manifest's ones into the gitignored
// canvas-lib/byq/src/. Thumbnails are served by the board route from
// ~/.claude-companion/byq-thumbs, fetched from BYQ's CDN on a miss.

export interface ByqManifestItem {
  slug: string
  kind: "component" | "gem"
  name: string
  category: string
  component: string
  file: string
  fonts: string[]
  thumb: string
  thumbHash: string | null
}
export interface ByqManifest { widths: Record<string, number>; items: ByqManifestItem[] }

export const BYQ_MANIFEST_PATH = join(import.meta.dir, "../../canvas-lib/byq/manifest.json")
export const BYQ_MANIFEST = manifest as ByqManifest
export const BYQ_SLUGS: ReadonlySet<string> = new Set(BYQ_MANIFEST.items.map((i) => i.slug))

export const byqLibDir = (): string => process.env.BYQ_LIB || join(homedir(), "work", "byq-lib")
export const byqThumbDir = (): string => join(homedir(), ".claude-companion", "byq-thumbs")

export interface ByqIndexItem { id: string; kind: string; thumbnailUrl: string | null; path: string | null }

// ponytail: index.json read once per process; restart the server after a mirror refresh.
let index: Map<string, ByqIndexItem> | null = null
export function byqIndex(): Map<string, ByqIndexItem> {
  if (index) return index
  const file = join(byqLibDir(), "index.json")
  let items: ByqIndexItem[] = []
  try { items = JSON.parse(readFileSync(file, "utf8")) } catch { /* no mirror on this host: no thumbnails to fetch */ }
  return (index = new Map(items.map((i) => [`${i.kind}-${i.id}`, i])))
}

/** `<kind>-<id>`, the iOS bundle's byq-thumbs naming; an optional .jpg/.webp is ignored. */
const THUMB_RE = /^((?:component|wireframe|gem|style)-[A-Za-z0-9][A-Za-z0-9-]{0,99})(?:\.(?:jpg|jpeg|webp|png))?$/
const THUMB_HOSTS = new Set(["ftspw3fevajkuozl.public.blob.vercel-storage.com", "byqsupply-components.netlify.app"])
const THUMB_MAX_BYTES = 5 * 1024 * 1024
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/webp": "webp", "image/png": "png" }

export type ByqThumb = { path: string; mime: string }

function cached(stem: string): ByqThumb | null {
  for (const [mime, ext] of Object.entries(EXT)) {
    const path = join(byqThumbDir(), `${stem}.${ext}`)
    if (existsSync(path)) return { path, mime }
  }
  return null
}

/**
 * A thumbnail by name: the cached file, else BYQ's CDN copy (only its two
 * hosts, https, ≤5 MB, real image bytes) saved to the cache. Null: bad name,
 * unknown item, no thumbnail upstream, or the fetch failed.
 */
export async function byqThumb(name: string, fetcher: typeof fetch = fetch): Promise<ByqThumb | null> {
  const stem = THUMB_RE.exec(name)?.[1]
  if (!stem) return null
  const hit = cached(stem)
  if (hit) return hit
  const src = byqIndex().get(stem)?.thumbnailUrl
  if (!src) return null
  let url: URL
  try { url = new URL(src) } catch { return null }
  if (url.protocol !== "https:" || !THUMB_HOSTS.has(url.hostname)) return null
  const res = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(15_000) }).catch(() => null)
  if (!res?.ok) return null
  const bytes = new Uint8Array(await res.arrayBuffer())
  const mime = sniff(bytes)
  const ext = mime ? EXT[mime] : undefined
  if (!mime || !ext || bytes.byteLength > THUMB_MAX_BYTES) return null
  mkdirSync(byqThumbDir(), { recursive: true, mode: 0o700 })
  const path = join(byqThumbDir(), `${stem}.${ext}`)
  writeFileSync(path, bytes, { mode: 0o600 })
  return { path, mime }
}

export const thumbHash = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16)
