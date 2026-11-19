import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Board images live out of band (canvas-board-sync): files named by their
// content hash under ~/.claude-companion/board-assets, records hold only
// `src: "/api/board/assets/<file>"` (never a token or a host). Raster only, no
// svg (script in an image); the bytes must match the declared type.

export const BOARD_ASSET_MIMES: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
}
export const BOARD_ASSET_MAX_BYTES = 25 * 1024 * 1024
export const BOARD_ASSET_PREFIX = "/api/board/assets/"

const FILE_RE = /^[a-f0-9]{32}\.(png|jpeg|gif|webp)$/

export function boardAssetDir(): string {
  return join(homedir(), ".claude-companion", "board-assets")
}

function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png"
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg"
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif"
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp"
  return null
}

export type SaveResult = { ok: true; file: string; src: string; path: string } | { ok: false; status: number; error: string }

export function saveBoardAsset(bytes: Uint8Array, contentType: string | null): SaveResult {
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase()
  const ext = BOARD_ASSET_MIMES[mime]
  if (!ext) return { ok: false, status: 415, error: "unsupported_type" }
  if (bytes.byteLength === 0) return { ok: false, status: 400, error: "empty" }
  if (bytes.byteLength > BOARD_ASSET_MAX_BYTES) return { ok: false, status: 413, error: "too_large" }
  if (sniff(bytes) !== mime) return { ok: false, status: 415, error: "type_mismatch" }
  const file = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`
  const dir = boardAssetDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, file)
  if (!existsSync(path)) writeFileSync(path, bytes, { mode: 0o600 })
  return { ok: true, file, src: `${BOARD_ASSET_PREFIX}${file}`, path }
}

/** A stored asset by file name (`<hash>.<ext>` only: no path tricks), or null. */
export function boardAssetFile(name: string): { path: string; mime: string } | null {
  if (!FILE_RE.test(name)) return null
  const path = join(boardAssetDir(), name)
  if (!existsSync(path)) return null
  const ext = name.slice(name.lastIndexOf(".") + 1)
  const mime = Object.keys(BOARD_ASSET_MIMES).find((m) => BOARD_ASSET_MIMES[m] === ext)!
  return { path, mime }
}

/**
 * Import: rewrite `data:` image URLs held by asset records into files (in
 * place), so the room never carries inline bytes. An undecodable or refused
 * one is left as is and counted.
 */
export function externalizeDataUrls(store: Record<string, unknown>): { moved: number; refused: number } {
  let moved = 0
  let refused = 0
  for (const rec of Object.values(store)) {
    const props = (rec as { typeName?: unknown; props?: { src?: unknown } } | null)?.props
    if ((rec as { typeName?: unknown }).typeName !== "asset" || typeof props?.src !== "string") continue
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(props.src)
    if (!m) continue
    const saved = saveBoardAsset(Buffer.from(m[2]!, "base64"), m[1]!)
    if (saved.ok) { props.src = saved.src; moved++ } else refused++
  }
  return { moved, refused }
}
