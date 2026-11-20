import { b64Vecs, toRichText } from "@tldraw/tlschema"
import { BOARD_ASSET_PREFIX, boardAssetFile } from "./board-assets"
import { type BoardRecord, BOARD_PROPS_TYPES, BOARD_SHAPE_TYPES, type BoardShapeType, buildArrowBindings, buildShape, nextIndex, richTextToPlain } from "./board-records"
import { BYQ_SLUGS } from "./byq"
import { type BoardRoom, type PresenceRecord, boardPresence, boardRecords, boardRoom } from "./board-room"

// The one implementation of the board tools (canvas-board-sync), served by
// the board MCP (lib/board-mcp.ts). Reads come from the room's current
// snapshot; every write is one room.updateStore transaction, the same commit
// path as a client push, so both clients see it through the sync protocol.

export const BOARD_MAX_OPS = 50
export const BOARD_MAX_HTML = 512 * 1024
export const BOARD_READ_CAP = 500
const NOTE_SIZE = 200
const PLACE_GAP = 80
const STACK_GAP = 24

export interface Rect { x: number; y: number; w: number; h: number }

export interface BoardShapeView {
  id: string
  type: string
  parentId: string
  pageId: string | null
  x: number
  y: number
  w: number | null
  h: number | null
  page: Rect
  rotation: number
  text?: string
  geo?: string
  color?: string
  title?: string
  html?: string
  /** ui-block / auto-layout-frame: every prop (layout, slug, name). */
  props?: Record<string, unknown>
  arrow?: { from: string | null; to: string | null }
  image?: { file: string; path: string | null; url: string; mime: string | null; w: number | null; h: number | null }
  by?: string
}

export interface BoardPresenceView {
  user: string
  pageId: string | null
  selection: string[]
  viewport: Rect | null
  lastActivity: number | null
}

/** `rect` (page coordinates, ignored with `ids`): the shapes on Jeremie's page that intersect it. */
export interface BoardReadOpts { ids?: string[]; focus?: boolean; html?: boolean; rect?: Rect }

export type BoardOp =
  | { op: "create"; type: BoardShapeType; id?: string; parentId?: string; x?: number; y?: number; text?: string; geo?: string; color?: string; w?: number; h?: number; from?: string; to?: string; html?: string; title?: string; props?: Record<string, unknown> }
  | { op: "update"; id: string; x?: number; y?: number; rotation?: number; text?: string; w?: number; h?: number; color?: string; geo?: string; html?: string; title?: string; props?: Record<string, unknown> }
  | { op: "delete"; id: string }

export class BoardOpError extends Error {
  constructor(message: string, readonly at: number) { super(message) }
}

export type Shape = BoardRecord & { type: string; parentId: string; index: string; x: number; y: number; rotation: number; props: Record<string, unknown>; meta: Record<string, unknown> }

const isShape = (r: BoardRecord): r is Shape => r.typeName === "shape"
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** A draw / highlight stroke's points per segment, shape-local (scaleX / scaleY applied). */
export function strokeSegments(s: Shape): Array<{ type: string; points: Array<{ x: number; y: number }> }> {
  const segs = Array.isArray(s.props.segments) ? (s.props.segments as Array<{ type?: unknown; path?: unknown; dim?: unknown }>) : []
  const sx = num(s.props.scaleX) ?? 1
  const sy = num(s.props.scaleY) ?? 1
  return segs.filter((g) => typeof g.path === "string").map((g) => ({
    type: String(g.type),
    points: b64Vecs.decodePoints(g.path as string, g.dim === 2 ? 2 : g.dim === 3 ? 3 : undefined).map((p) => ({ x: p.x * sx, y: p.y * sy })),
  }))
}

/** The shape-local box a stroke's points span, else 0,0 + its stored size. */
function localBox(s: Shape): Rect {
  if (s.type === "draw" || s.type === "highlight") {
    const pts = strokeSegments(s).flatMap((g) => g.points)
    if (pts.length) {
      const xs = pts.map((p) => p.x)
      const ys = pts.map((p) => p.y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
    }
  }
  const { w, h } = sizeOf(s)
  return { x: 0, y: 0, w: w ?? 0, h: h ?? 0 }
}

/** A shape's own size; null where the record stores none (a note is 200 × scale). */
function sizeOf(s: Shape): { w: number | null; h: number | null } {
  const p = s.props
  const scale = num(p.scale) ?? 1
  if (s.type === "note") return { w: NOTE_SIZE * scale, h: NOTE_SIZE * scale + (num(p.growY) ?? 0) }
  const w = num(p.w)
  const h = num(p.h)
  return { w: w === null ? null : w * (s.type === "geo" || s.type === "text" ? scale : 1), h: h === null ? null : h * (s.type === "geo" ? scale : 1) + (num(p.growY) ?? 0) }
}

export type BoardIndex = ReturnType<typeof index>

function index(records: BoardRecord[]) {
  const byId = new Map(records.map((r) => [r.id, r]))
  const shapes = records.filter(isShape)
  const children = new Map<string, Shape[]>()
  for (const s of shapes) children.set(s.parentId, [...(children.get(s.parentId) ?? []), s])
  /** Page coordinates: the parent chain summed (parent rotation ignored), and the page it sits on. */
  const pageOf = (s: Shape): { x: number; y: number; pageId: string | null } => {
    let x = s.x
    let y = s.y
    let p = byId.get(s.parentId)
    for (let hops = 0; p && p.typeName === "shape" && hops < 100; hops++) {
      const ps = p as Shape
      x += ps.x; y += ps.y
      p = byId.get(ps.parentId)
    }
    return { x, y, pageId: p?.typeName === "page" ? p.id : null }
  }
  const descendants = (ids: Iterable<string>): Set<string> => {
    const out = new Set<string>()
    const walk = (id: string) => {
      if (out.has(id)) return
      out.add(id)
      for (const c of children.get(id) ?? []) walk(c.id)
    }
    for (const id of ids) walk(id)
    return out
  }
  const rectOf = (s: Shape): Rect => {
    const at = pageOf(s)
    const b = localBox(s)
    return { x: at.x + b.x, y: at.y + b.y, w: b.w, h: b.h }
  }
  return { byId, shapes, children, pageOf, descendants, rectOf }
}

function presenceView(p: PresenceRecord): BoardPresenceView {
  const c = p.camera
  const sb = p.screenBounds
  return {
    user: p.userName ?? "",
    pageId: p.currentPageId ?? null,
    selection: p.selectedShapeIds ?? [],
    viewport: c && sb && c.z ? { x: -c.x, y: -c.y, w: sb.w / c.z, h: sb.h / c.z } : null,
    lastActivity: p.lastActivityTimestamp ?? null,
  }
}

export const intersects = (a: Rect, b: Rect): boolean => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h

/** What a read (or a render) covers: `pick` holds the scoped shape ids. */
export function boardScope(opts: BoardReadOpts, room: BoardRoom) {
  const records = boardRecords(room)
  const ix = index(records)
  const presence = boardPresence(room).map(presenceView)
  const me = presence[0]
  const pages = records.filter((r) => r.typeName === "page").map((r) => ({ id: r.id, name: String(r.name ?? "") }))
  let pick: Set<string>
  if (opts.ids?.length) {
    pick = ix.descendants(opts.ids.filter((id) => ix.byId.has(id)))
  } else {
    const pageId = me?.pageId && pages.some((p) => p.id === me.pageId) ? me.pageId : pages[0]?.id ?? null
    const onPage = ix.shapes.filter((s) => ix.pageOf(s).pageId === pageId)
    const within = (r: Rect) => new Set(onPage.filter((s) => intersects(ix.rectOf(s), r)).map((s) => s.id))
    if (opts.rect) pick = within(opts.rect)
    else if (opts.focus && me?.selection.length) pick = ix.descendants(me.selection.filter((id) => ix.byId.has(id)))
    else if (opts.focus && me?.viewport) pick = within(me.viewport)
    else pick = new Set(onPage.map((s) => s.id))
  }
  return { records, ix, presence, pages, pick }
}

export function boardRead(opts: BoardReadOpts = {}, room: BoardRoom = boardRoom()): { ok: true; pages: Array<{ id: string; name: string }>; shapes: BoardShapeView[]; presence: BoardPresenceView[]; truncated?: true } {
  const { records, ix, presence, pages, pick } = boardScope(opts, room)
  const bindings = records.filter((r) => r.typeName === "binding" && r.type === "arrow")
  const views: BoardShapeView[] = []
  for (const s of ix.shapes) {
    if (!pick.has(s.id)) continue
    if (views.length >= BOARD_READ_CAP) return { ok: true, pages, shapes: views, presence, truncated: true }
    views.push(viewOf(s, ix, bindings, opts.html === true))
  }
  return { ok: true, pages, shapes: views, presence }
}

function viewOf(s: Shape, ix: ReturnType<typeof index>, bindings: BoardRecord[], withHtml: boolean): BoardShapeView {
  const p = s.props
  const at = ix.pageOf(s)
  const { w, h } = sizeOf(s)
  const v: BoardShapeView = { id: s.id, type: s.type, parentId: s.parentId, pageId: at.pageId, x: s.x, y: s.y, w, h, page: ix.rectOf(s), rotation: s.rotation }
  if (p.richText) v.text = richTextToPlain(p.richText)
  if (typeof p.geo === "string") v.geo = p.geo
  if (typeof p.color === "string") v.color = p.color
  if (typeof p.title === "string") v.title = p.title
  if (withHtml && typeof p.html === "string") v.html = p.html
  if (BOARD_PROPS_TYPES.includes(s.type)) v.props = { ...p }
  if (s.type === "arrow") {
    const end = (t: string) => (bindings.find((b) => b.fromId === s.id && (b.props as { terminal?: unknown })?.terminal === t)?.toId as string | undefined) ?? null
    v.arrow = { from: end("start"), to: end("end") }
  }
  if (s.type === "image" && typeof p.assetId === "string") {
    const src = (ix.byId.get(p.assetId)?.props as { src?: unknown; mimeType?: unknown } | undefined)
    if (typeof src?.src === "string" && src.src.startsWith(BOARD_ASSET_PREFIX)) {
      const file = src.src.slice(BOARD_ASSET_PREFIX.length)
      v.image = { file, path: boardAssetFile(file)?.path ?? null, url: src.src, mime: typeof src.mimeType === "string" ? src.mimeType : null, w, h }
    }
  }
  if (typeof s.meta?.by === "string") v.by = s.meta.by
  return v
}

// ── board_write ──

/** text / title / geo / color: a note is not a document; html has its own cap. */
const BOARD_MAX_TEXT = 20_000
const str = (v: unknown, at: number, name: string): string | undefined => {
  if (v === undefined) return undefined
  if (typeof v !== "string") throw new BoardOpError(`${name} must be a string`, at)
  if (v.length > BOARD_MAX_TEXT) throw new BoardOpError(`${name} over ${BOARD_MAX_TEXT} characters`, at)
  return v
}
const fin = (v: unknown, at: number, name: string): number | undefined => {
  if (v === undefined) return undefined
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BoardOpError(`${name} must be a finite number`, at)
  return v
}

/** `props` (ui-block / auto-layout-frame): a plain object; a slug must be in the BYQ manifest. Values are checked by boardSchema on put. */
const propsArg = (v: unknown, at: number): Record<string, unknown> | undefined => {
  if (v === undefined) return undefined
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BoardOpError("props must be an object", at)
  const p = v as Record<string, unknown>
  if (p.slug !== undefined && !BYQ_SLUGS.has(p.slug as string)) throw new BoardOpError(`unknown BYQ slug ${JSON.stringify(p.slug)} (canvas-lib/byq/manifest.json)`, at)
  return p
}

/** Parse untrusted ops (MCP arguments): throws BoardOpError naming the bad op's index. */
export function parseBoardOps(raw: unknown): BoardOp[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new BoardOpError("ops must be a non-empty array", 0)
  if (raw.length > BOARD_MAX_OPS) throw new BoardOpError(`at most ${BOARD_MAX_OPS} ops per call`, BOARD_MAX_OPS)
  return raw.map((o: unknown, at): BoardOp => {
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new BoardOpError("op must be an object", at)
    const r = o as Record<string, unknown>
    const html = str(r.html, at, "html")
    if (html !== undefined && html.length > BOARD_MAX_HTML) throw new BoardOpError("html over 512 KB", at)
    const common = { text: str(r.text, at, "text"), geo: str(r.geo, at, "geo"), color: str(r.color, at, "color"), w: fin(r.w, at, "w"), h: fin(r.h, at, "h"), html, title: str(r.title, at, "title"), props: propsArg(r.props, at), x: fin(r.x, at, "x"), y: fin(r.y, at, "y") }
    if (r.op === "create") {
      if (!BOARD_SHAPE_TYPES.includes(r.type as BoardShapeType)) throw new BoardOpError(`type must be one of ${BOARD_SHAPE_TYPES.join(", ")}`, at)
      const id = str(r.id, at, "id")
      if (id !== undefined && !/^shape:[A-Za-z0-9_-]{1,64}$/.test(id)) throw new BoardOpError("id must look like shape:<id>", at)
      const from = str(r.from, at, "from")
      const to = str(r.to, at, "to")
      if (r.type === "arrow" && (!from || !to)) throw new BoardOpError("an arrow needs from and to", at)
      if (common.props && !BOARD_PROPS_TYPES.includes(r.type as string)) throw new BoardOpError(`props only for ${BOARD_PROPS_TYPES.join(", ")}`, at)
      if (r.type === "ui-block" && common.props?.slug === undefined) throw new BoardOpError("a ui-block needs props.slug", at)
      return { op: "create", type: r.type as BoardShapeType, id, parentId: str(r.parentId, at, "parentId"), from, to, ...common }
    }
    const id = str(r.id, at, "id")
    if (!id) throw new BoardOpError("id is required", at)
    if (r.op === "update") return { op: "update", id, rotation: fin(r.rotation, at, "rotation"), ...common }
    if (r.op === "delete") return { op: "delete", id }
    throw new BoardOpError("op must be create, update or delete", at)
  })
}

type Store = Parameters<Parameters<BoardRoom["updateStore"]>[0]>[0]

/** Where a shape with no x/y goes: right of Jeremie's selection, else his viewport centre, else 0,0. */
function placementOrigin(records: BoardRecord[], presence: BoardPresenceView[]): { x: number; y: number; pageId: string | null } {
  const me = presence[0]
  const ix = index(records)
  const sel = (me?.selection ?? []).map((id) => ix.byId.get(id)).filter((r): r is Shape => !!r && isShape(r)).map(ix.rectOf)
  if (sel.length) {
    const right = Math.max(...sel.map((r) => r.x + r.w))
    const top = Math.min(...sel.map((r) => r.y))
    return { x: right + PLACE_GAP, y: top, pageId: me?.pageId ?? null }
  }
  if (me?.viewport) return { x: me.viewport.x + me.viewport.w / 2, y: me.viewport.y + me.viewport.h / 2, pageId: me.pageId }
  return { x: 0, y: 0, pageId: me?.pageId ?? null }
}

/** Apply ops in one transaction. `by` (the caller label) goes to meta.by of created shapes. */
export async function boardWrite(ops: BoardOp[], by: string, room: BoardRoom = boardRoom()): Promise<{ ok: true; ids: string[] }> {
  const presence = boardPresence(room).map(presenceView)
  const ids: string[] = []
  await room.updateStore((store) => {
    const all = store.getAll() as unknown as BoardRecord[]
    const firstPage = all.find((r) => r.typeName === "page")?.id
    const origin = placementOrigin(all, presence)
    let stackY = origin.y
    ops.forEach((op, at) => {
      try {
        if (op.op === "create") ids.push(...create(store, op, by, origin, firstPage, () => stackY, (dy) => { stackY += dy }))
        else if (op.op === "update") ids.push(update(store, op))
        else ids.push(...remove(store, op.id))
      } catch (err) {
        throw err instanceof BoardOpError ? err : new BoardOpError((err as Error)?.message ?? String(err), at)
      }
    })
  })
  return { ok: true, ids }
}

function getShape(store: Store, id: string): Shape | null {
  const r = store.get(id) as unknown as BoardRecord | null
  return r && isShape(r) ? r : null
}

function create(store: Store, op: Extract<BoardOp, { op: "create" }>, by: string, origin: { x: number; y: number; pageId: string | null }, firstPage: string | undefined, stackY: () => number, advance: (dy: number) => void): string[] {
  const parentId = op.parentId ?? (origin.pageId && store.get(origin.pageId) ? origin.pageId : firstPage)
  if (!parentId || !store.get(parentId)) throw new Error(`parent ${parentId ?? "(none)"} not found`)
  if (op.id && store.get(op.id)) throw new Error(`${op.id} already exists`)
  const all = store.getAll() as unknown as BoardRecord[]
  const siblings = all.filter((r) => isShape(r) && r.parentId === parentId).map((r) => (r as Shape).index)
  const auto = op.x === undefined && op.y === undefined && !op.parentId
  const shape = buildShape({ ...op, parentId, index: nextIndex(siblings), x: op.x ?? (auto ? origin.x : 0), y: op.y ?? (auto ? stackY() : 0), by })
  if (auto) advance((sizeOf(shape as Shape).h ?? 40) + STACK_GAP)
  store.put(shape as never)
  if (op.type !== "arrow") return [shape.id]
  for (const end of [op.from!, op.to!]) if (!getShape(store, end)) throw new Error(`arrow end ${end} not found`)
  const bindings = buildArrowBindings(shape.id, op.from!, op.to!)
  for (const b of bindings) store.put(b as never)
  return [shape.id, ...bindings.map((b) => b.id)]
}

function update(store: Store, op: Extract<BoardOp, { op: "update" }>): string {
  const s = getShape(store, op.id)
  if (!s) throw new Error(`${op.id} not found`)
  if (op.x !== undefined) s.x = op.x
  if (op.y !== undefined) s.y = op.y
  if (op.rotation !== undefined) s.rotation = op.rotation
  const p = s.props
  const set = (k: string, v: unknown) => {
    if (v === undefined) return
    if (!Object.hasOwn(p, k)) throw new Error(`a ${s.type} has no ${k}`)
    p[k] = v
  }
  if (op.text !== undefined) set("richText", toRichText(op.text))
  set("w", op.w); set("h", op.h); set("color", op.color); set("geo", op.geo); set("html", op.html); set("title", op.title)
  if (op.props && !BOARD_PROPS_TYPES.includes(s.type)) throw new Error(`props only for ${BOARD_PROPS_TYPES.join(", ")}`)
  for (const [k, v] of Object.entries(op.props ?? {})) set(k, v)
  store.put(s as never)
  return s.id
}

/** Delete a shape, its descendants and every binding touching any of them (no editor side effects here). */
function remove(store: Store, id: string): string[] {
  if (!getShape(store, id)) throw new Error(`${id} not found`)
  const all = store.getAll() as unknown as BoardRecord[]
  const gone = index(all).descendants([id])
  const dead = [...gone, ...all.filter((r) => r.typeName === "binding" && (gone.has(r.fromId as string) || gone.has(r.toId as string))).map((r) => r.id)]
  for (const d of dead) store.delete(d)
  return dead
}
