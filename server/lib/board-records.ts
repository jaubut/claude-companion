import { createBindingId, createShapeId, toRichText } from "@tldraw/tlschema"
import { type IndexKey, getIndexAbove } from "@tldraw/utils"
import { LIVE_FRAME_TYPE } from "./board-schema"

// Full tldraw 5.6.0 records for the shapes board_write creates. The server has
// no editor to fill defaults, so every prop is spelled out here and
// board-records.test.ts validates each built record against boardSchema: a
// tldraw bump that adds a prop fails that test before it reaches prod.

/** A stored record, loosely typed: the room validates it against boardSchema on put. */
export interface BoardRecord {
  id: string
  typeName: string
  [key: string]: unknown
}

export const BOARD_SHAPE_TYPES = ["note", "text", "geo", "arrow", LIVE_FRAME_TYPE] as const
export type BoardShapeType = typeof BOARD_SHAPE_TYPES[number]

export interface ShapeInput {
  type: BoardShapeType
  id?: string
  parentId: string
  index: string
  x: number
  y: number
  by: string
  text?: string
  geo?: string
  color?: string
  w?: number
  h?: number
  html?: string
  title?: string
}

const STYLE = { size: "m", font: "draw" }

function shapeProps(s: ShapeInput): Record<string, unknown> {
  const richText = toRichText(s.text ?? "")
  switch (s.type) {
    case "note":
      return { ...STYLE, color: s.color ?? "yellow", labelColor: "black", fontSizeAdjustment: null, align: "middle", verticalAlign: "middle", growY: 0, url: "", richText, scale: 1, textLastEditedBy: null }
    case "text":
      return { ...STYLE, color: s.color ?? "black", textAlign: "start", w: s.w ?? 8, richText, scale: 1, autoSize: s.w === undefined }
    case "geo":
      return { ...STYLE, geo: s.geo ?? "rectangle", dash: "draw", url: "", w: s.w ?? 200, h: s.h ?? 120, growY: 0, scale: 1, flipX: false, flipY: false, labelColor: "black", color: s.color ?? "black", fill: "none", align: "middle", verticalAlign: "middle", richText }
    case "arrow":
      // Bound arrows render from their bindings: start/end are placeholders.
      return { ...STYLE, kind: "arc", labelColor: "black", color: s.color ?? "black", fill: "none", dash: "draw", arrowheadStart: "none", arrowheadEnd: "arrow", start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 0, richText, labelPosition: 0.5, scale: 1, elbowMidPoint: 0.5 }
    case LIVE_FRAME_TYPE:
      return { w: s.w ?? 640, h: s.h ?? 400, html: s.html ?? "", title: s.title ?? "Live frame" }
  }
}

export function buildShape(s: ShapeInput): BoardRecord {
  return {
    id: s.id ?? createShapeId(),
    typeName: "shape",
    type: s.type,
    parentId: s.parentId,
    index: s.index,
    x: s.x,
    y: s.y,
    rotation: 0,
    isLocked: false,
    opacity: 1,
    props: shapeProps(s),
    meta: { by: s.by },
  }
}

/** The two `binding` records that tie an arrow's start to `from` and its end to `to`. */
export function buildArrowBindings(arrowId: string, from: string, to: string): BoardRecord[] {
  return ([["start", from], ["end", to]] as const).map(([terminal, toId]) => ({
    id: createBindingId(),
    typeName: "binding",
    type: "arrow",
    fromId: arrowId,
    toId,
    props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: "none" },
    meta: {},
  }))
}

/** Plain text of a TLRichText (ProseMirror JSON): paragraphs and hard breaks become `\n`. */
export function richTextToPlain(node: unknown): string {
  if (!node || typeof node !== "object") return ""
  const n = node as { type?: unknown; text?: unknown; content?: unknown }
  if (typeof n.text === "string") return n.text
  if (n.type === "hardBreak") return "\n"
  const kids = Array.isArray(n.content) ? n.content.map(richTextToPlain) : []
  return n.type === "doc" ? kids.join("\n") : kids.join("")
}

/** An index above every sibling index given (top of the z-order). */
export function nextIndex(siblings: Iterable<string>): string {
  let max: string | null = null
  for (const i of siblings) if (max === null || i > max) max = i
  return getIndexAbove(max as IndexKey | null)
}
