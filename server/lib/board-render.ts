import { readFileSync, statSync } from "node:fs"
import sharp from "sharp"
import { BOARD_ASSET_PREFIX, boardAssetFile } from "./board-assets"
import { richTextToPlain } from "./board-records"
import { type BoardRoom, boardRoom } from "./board-room"
import { BOARD_FONT, type BoardIndex, type Rect, type Shape, boardScope, strokeSegments } from "./board-tools"

// A picture of the live board for agents (handwriting included): the scoped
// shapes as one SVG in z-order, rasterized by sharp on white. Approximates
// tldraw's look (palette, stroke sizes); it is for reading, not for print.

export interface BoardRenderOpts { ids?: string[]; focus?: boolean; rect?: Rect; maxDim?: number }

const PAD = 32
const MIN_SCALE = 0.2
const MAX_SCALE = 2.5
const IMAGE_EMBED_MAX = 5 * 1024 * 1024

const PALETTE: Record<string, string> = {
  black: "#1d1d1d", grey: "#868e96", white: "#ffffff",
  red: "#e03131", "light-red": "#ff8787",
  blue: "#1971c2", "light-blue": "#4dabf7",
  green: "#2f9e44", "light-green": "#69db7c",
  orange: "#f76707", yellow: "#f08c00",
  violet: "#ae3ec9", "light-violet": "#da77f2",
}
const STROKE: Record<string, number> = { s: 2, m: 3.5, l: 6, xl: 10 }

const color = (v: unknown) => PALETTE[String(v)] ?? PALETTE.black!
// Characters XML 1.0 forbids (control chars, lone surrogates, U+FFFE/FFFF) would make librsvg reject the whole SVG.
const XML_INVALID = /[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const esc = (s: string) => s.replace(XML_INVALID, "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const n = (v: number) => (Math.round(v * 100) / 100).toString()
const numOr = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d)

/** Multi-line text from (x, y) = first baseline's left (anchor start) or centre (anchor middle). */
function textSvg(text: string, x: number, y: number, size: number, fill: string, anchor: "start" | "middle"): string {
  const lines = text.split("\n")
  const spans = lines.map((l, i) => `<tspan x="${n(x)}" dy="${i ? n(size * 1.25) : 0}">${esc(l)}</tspan>`).join("")
  return `<text x="${n(x)}" y="${n(y)}" font-family="sans-serif" font-size="${n(size)}" fill="${fill}" text-anchor="${anchor}">${spans}</text>`
}
const centredText = (text: string, w: number, h: number, size: number, fill: string) =>
  textSvg(text, w / 2, h / 2 - ((text.split("\n").length - 1) * size * 1.25) / 2 + size * 0.35, size, fill, "middle")

/** One shape in its own local frame (the caller wraps it in translate + rotate). */
function shapeSvg(s: Shape, ix: BoardIndex): string {
  const p = s.props
  const scale = numOr(p.scale, 1)
  const { w, h } = ix.rectOf(s)
  const stroke = color(p.color)
  const text = p.richText ? richTextToPlain(p.richText) : ""
  const font = (BOARD_FONT[String(p.size)] ?? 24) * scale
  if (s.type === "draw" || s.type === "highlight") {
    const hl = s.type === "highlight"
    const width = (STROKE[String(p.size)] ?? 3.5) * scale * (hl ? 4 : 1)
    const filled = !hl && p.isClosed === true && p.fill !== undefined && p.fill !== "none"
    const d = strokeSegments(s).map((g) => g.points.map((pt, i) => `${i ? "L" : "M"}${n(pt.x)} ${n(pt.y)}`).join(" ") + (g.points.length === 1 ? ` L${n(g.points[0]!.x)} ${n(g.points[0]!.y)}` : "")).join(" ")
    if (!d) return ""
    return `<path d="${d}" fill="${filled ? stroke : "none"}" fill-opacity="${filled ? 0.3 : 1}" stroke="${stroke}" stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"${hl ? ' opacity="0.4"' : ""}/>`
  }
  if (s.type === "geo") {
    const fill = p.fill !== undefined && p.fill !== "none" ? `fill="${stroke}" fill-opacity="0.2"` : 'fill="none"'
    const sw = n((STROKE[String(p.size)] ?? 3.5) * scale)
    const body = p.geo === "ellipse" || p.geo === "oval"
      ? `<ellipse cx="${n(w / 2)}" cy="${n(h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}" ${fill} stroke="${stroke}" stroke-width="${sw}"/>`
      : `<rect width="${n(w)}" height="${n(h)}" ${fill} stroke="${stroke}" stroke-width="${sw}"/>`
    return body + (text ? centredText(text, w, h, font, color(p.labelColor)) : "")
  }
  if (s.type === "note") return `<rect width="${n(w)}" height="${n(h)}" rx="6" fill="${stroke}" fill-opacity="0.35"/>` + (text ? centredText(text, w, h, font, PALETTE.black!) : "")
  if (s.type === "text") return text ? textSvg(text, 0, font, font, stroke, "start") : ""
  if (s.type === "arrow") {
    const at = ix.pageOf(s)
    const end = (t: "start" | "end") => {
      const e = ix.arrowEnd(s, t)
      return { ...e, x: e.x - at.x, y: e.y - at.y }
    }
    // A bound end stops at its shape's box edge, not at its centre (over the label).
    const edge = (from: { x: number; y: number; hw: number; hh: number }, toward: { x: number; y: number }) => {
      const dx = toward.x - from.x
      const dy = toward.y - from.y
      const k = Math.min(dx ? from.hw / Math.abs(dx) : Infinity, dy ? from.hh / Math.abs(dy) : Infinity, 1)
      return { x: from.x + dx * k, y: from.y + dy * k }
    }
    const a0 = end("start")
    const b0 = end("end")
    const a = edge(a0, b0)
    const b = edge(b0, a0)
    const sw = (STROKE[String(p.size)] ?? 3.5) * scale
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    const head = sw * 4 + 6
    const wing = (o: number) => `${n(b.x - head * Math.cos(ang + o))},${n(b.y - head * Math.sin(ang + o))}`
    const tip = p.arrowheadEnd === "none" ? "" : `<polygon points="${n(b.x)},${n(b.y)} ${wing(0.45)} ${wing(-0.45)}" fill="${stroke}"/>`
    return `<line x1="${n(a.x)}" y1="${n(a.y)}" x2="${n(b.x)}" y2="${n(b.y)}" stroke="${stroke}" stroke-width="${n(sw)}" stroke-linecap="round"/>${tip}`
  }
  if (s.type === "image" && typeof p.assetId === "string") {
    const src = (ix.byId.get(p.assetId)?.props as { src?: unknown } | undefined)?.src
    const found = typeof src === "string" && src.startsWith(BOARD_ASSET_PREFIX) ? boardAssetFile(src.slice(BOARD_ASSET_PREFIX.length)) : null
    if (!found || statSync(found.path).size > IMAGE_EMBED_MAX) return `<rect width="${n(w)}" height="${n(h)}" fill="#f1f3f5" stroke="#adb5bd"/>`
    return `<image href="data:${found.mime};base64,${readFileSync(found.path).toString("base64")}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"/>`
  }
  // live-frame, ui-block, auto-layout-frame, frame, …: an outline with its name.
  if (!w || !h) return ""
  const label = [p.title, p.name, p.slug].find((v) => typeof v === "string" && v) as string | undefined
  return `<rect width="${n(w)}" height="${n(h)}" fill="none" stroke="#adb5bd" stroke-dasharray="8 6"/>` + (label ? textSvg(label, 8, 22, 16, "#868e96", "start") : "")
}

/** PNG of the scoped board region: `rect` (page coordinates), else what boardRead({ ids, focus }) covers, padded. */
export async function renderBoardRegion(opts: BoardRenderOpts, room: BoardRoom = boardRoom()): Promise<{ png: Buffer; rect: Rect; shapeCount: number }> {
  if (opts.rect) {
    const { x, y, w, h } = opts.rect
    if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v)) || w <= 0 || h <= 0) throw new Error("rect needs finite x, y and positive w, h")
  }
  const maxDim = Math.min(4096, Math.max(64, numOr(opts.maxDim, 2000)))
  const { records, ix, pick } = boardScope(opts, room)
  // z-order: pages in order, then each parent's children by fractional index.
  const ordered: Shape[] = []
  const walk = (parentId: string) => {
    for (const c of [...(ix.children.get(parentId) ?? [])].sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))) {
      if (pick.has(c.id)) ordered.push(c)
      walk(c.id)
    }
  }
  for (const r of records) if (r.typeName === "page") walk(r.id)
  let rect: Rect
  if (opts.rect) rect = opts.rect
  else if (ordered.length) {
    const rs = ordered.map(ix.rectOf)
    const x = Math.min(...rs.map((r) => r.x)) - PAD
    const y = Math.min(...rs.map((r) => r.y)) - PAD
    rect = { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) + PAD - x, h: Math.max(...rs.map((r) => r.y + r.h)) + PAD - y }
  } else rect = { x: 0, y: 0, w: 400, h: 300 }
  // ponytail: a region wider than maxDim / MIN_SCALE keeps its top-left part; the agent re-asks with `rect` for the rest.
  rect = { ...rect, w: Math.min(rect.w, maxDim / MIN_SCALE), h: Math.min(rect.h, maxDim / MIN_SCALE) }
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, maxDim / Math.max(rect.w, rect.h)))
  const W = Math.max(1, Math.round(rect.w * scale))
  const H = Math.max(1, Math.round(rect.h * scale))
  const body = ordered.map((s) => {
    const at = ix.pageOf(s)
    const rot = s.rotation ? ` rotate(${n((s.rotation * 180) / Math.PI)})` : ""
    return `<g transform="translate(${n(at.x)} ${n(at.y)})${rot}">${shapeSvg(s, ix)}</g>`
  }).join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#ffffff"/><g transform="scale(${scale}) translate(${n(-rect.x)} ${n(-rect.y)})">${body}</g></svg>`
  const png = await sharp(Buffer.from(svg)).flatten({ background: "#ffffff" }).png().toBuffer()
  return { png, rect, shapeCount: ordered.length }
}
