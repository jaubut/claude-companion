import { describe, expect, test } from "bun:test"
import { InMemorySyncStorage, TLSocketRoom } from "@tldraw/sync-core"
import type { TLRecord } from "@tldraw/tlschema"
import sharp from "sharp"
import { renderBoardRegion } from "./board-render"
import { putStroke } from "./board-stroke.test-util"
import { type BoardRoom, boardPresence, boardRecords } from "./board-room"
import { boardSchema } from "./board-schema"
import { BoardOpError, boardRead, boardWrite, parseBoardOps } from "./board-tools"

// board_read / board_write on an in-memory room (canvas-board-sync).

const newRoom = (): BoardRoom => new TLSocketRoom<TLRecord, void>({ schema: boardSchema, storage: new InMemorySyncStorage<TLRecord>() })
const validateAll = (room: BoardRoom) => {
  for (const r of boardRecords(room)) boardSchema.types[r.typeName as "shape"].validate(r as never)
}

describe("board tools", () => {
  test("parseBoardOps names the bad op's index", () => {
    const at = (raw: unknown) => { try { parseBoardOps(raw); return -1 } catch (e) { return (e as BoardOpError).at } }
    expect(at([])).toBe(0)
    expect(at([{ op: "create", type: "note" }, { op: "create", type: "svg" }])).toBe(1)
    expect(at([{ op: "create", type: "arrow", from: "shape:a" }])).toBe(0)
    expect(at([{ op: "update" }])).toBe(0)
    expect(at([{ op: "create", type: "note", x: "1" }])).toBe(0)
    expect(at([{ op: "create", type: "live-frame", html: "x".repeat(512 * 1024 + 1) }])).toBe(0)
    expect(at(Array.from({ length: 51 }, () => ({ op: "delete", id: "shape:x" })))).toBe(50)
  })

  test("an invalid op applies nothing (one transaction)", async () => {
    const room = newRoom()
    await expect(boardWrite(parseBoardOps([{ op: "create", type: "note", id: "shape:ok", text: "a" }, { op: "delete", id: "shape:missing" }]), "t", room)).rejects.toMatchObject({ at: 1 })
    expect(boardRecords(room).filter((r) => r.typeName === "shape")).toHaveLength(0)
  })

  test("delete cascades descendants and every binding touching them; the store still validates", async () => {
    const room = newRoom()
    await boardWrite(parseBoardOps([
      { op: "create", type: "geo", id: "shape:g1", x: 0, y: 0, w: 100, h: 100 },
      { op: "create", type: "geo", id: "shape:g2", x: 300, y: 0 },
      { op: "create", type: "note", id: "shape:child", parentId: "shape:g1", x: 10, y: 20, text: "inner" },
      { op: "create", type: "arrow", id: "shape:arr", from: "shape:g1", to: "shape:g2" },
    ]), "t", room)
    const count = boardRecords(room).length
    const out = await boardWrite([{ op: "delete", id: "shape:g1" }], "t", room)
    expect(out.ids.sort()).toEqual(expect.arrayContaining(["shape:g1", "shape:child"]))
    const left = boardRecords(room)
    expect(left.length).toBe(count - 3)
    expect(left.filter((r) => r.typeName === "binding").map((r) => r.toId)).toEqual(["shape:g2"])
    validateAll(room)
    await boardWrite([{ op: "delete", id: "shape:g2" }], "t", room)
    expect(boardRecords(room).filter((r) => r.typeName === "binding")).toHaveLength(0)
    validateAll(room)
  })

  test("read: page coordinates through the parent chain, note size, arrow ends, html only on request, meta.by", async () => {
    const room = newRoom()
    await boardWrite(parseBoardOps([
      { op: "create", type: "geo", id: "shape:box", x: 50, y: 60 },
      { op: "create", type: "note", id: "shape:n", parentId: "shape:box", x: 10, y: 20, text: "line1\nline2" },
      { op: "create", type: "live-frame", id: "shape:lf", x: 0, y: 500, html: "<b>x</b>", title: "T" },
      { op: "create", type: "arrow", id: "shape:ar", from: "shape:box", to: "shape:lf" },
    ]), "mac:desk", room)
    const read = boardRead({}, room)
    const n = read.shapes.find((s) => s.id === "shape:n")!
    expect(n).toMatchObject({ x: 10, y: 20, w: 200, h: 200, page: { x: 60, y: 80, w: 200, h: 200 }, text: "line1\nline2", by: "mac:desk" })
    expect(read.shapes.find((s) => s.id === "shape:ar")!.arrow).toEqual({ from: "shape:box", to: "shape:lf" })
    expect(read.shapes.find((s) => s.id === "shape:lf")!.html).toBeUndefined()
    expect(boardRead({ ids: ["shape:lf"], html: true }, room).shapes[0]!.html).toBe("<b>x</b>")
    expect(boardRead({ ids: ["shape:box"] }, room).shapes.map((s) => s.id).sort()).toEqual(["shape:box", "shape:n"])
    expect(read.pages).toEqual([{ id: "page:page", name: "Page 1" }])
    expect(read.presence).toEqual([])
  })

  test("update: text, color and position; a prop the shape lacks is refused", async () => {
    const room = newRoom()
    await boardWrite([{ op: "create", type: "note", id: "shape:u", text: "a" }], "t", room)
    await boardWrite(parseBoardOps([{ op: "update", id: "shape:u", text: "b", color: "blue", x: 5 }]), "t", room)
    expect(boardRead({}, room).shapes[0]).toMatchObject({ text: "b", color: "blue", x: 5 })
    await expect(boardWrite(parseBoardOps([{ op: "update", id: "shape:u", html: "<p/>" }]), "t", room)).rejects.toBeInstanceOf(BoardOpError)
    await expect(boardWrite(parseBoardOps([{ op: "update", id: "shape:u", color: "neon" }]), "t", room)).rejects.toBeInstanceOf(BoardOpError)
  })

  test("auto-placed shapes stack without overlapping; no presence → from 0,0", async () => {
    const room = newRoom()
    const out = await boardWrite(parseBoardOps([{ op: "create", type: "note", text: "1" }, { op: "create", type: "note", text: "2" }]), "t", room)
    const [a, b] = out.ids.map((id) => boardRead({ ids: [id] }, room).shapes[0]!)
    expect([a!.x, a!.y]).toEqual([0, 0])
    expect(b!.y).toBe(224)
  })

  test("boardPresence fails open when the internal method is missing or throws", () => {
    expect(boardPresence({} as BoardRoom)).toEqual([])
    expect(boardPresence({ getPresenceRecords() { throw new Error("x") } } as unknown as BoardRoom)).toEqual([])
    // The @internal method exists on the pinned 5.6.0 room (an exact pin + this guard).
    expect(typeof (newRoom() as unknown as { getPresenceRecords?: unknown }).getPresenceRecords).toBe("function")
  })

  test("ui-block inside an auto-layout-frame: create, read props, update props", async () => {
    const room = newRoom()
    await boardWrite(parseBoardOps([
      { op: "create", type: "auto-layout-frame", id: "shape:page1", x: 0, y: 0, props: { name: "Landing", gap: 24, paddingY: 48 } },
      { op: "create", type: "ui-block", id: "shape:hero", parentId: "shape:page1", props: { slug: "algarve-hero-1" } },
    ]), "brain", room)
    validateAll(room)
    await boardWrite(parseBoardOps([{ op: "update", id: "shape:hero", w: 390, props: { sizingW: "fill" } }, { op: "update", id: "shape:page1", props: { direction: "row", bg: "#faf6ea" } }]), "brain", room)
    const shapes = boardRead({ ids: ["shape:page1"] }, room).shapes
    expect(shapes.find((s) => s.id === "shape:hero")!.props).toEqual({ w: 390, h: 720, slug: "algarve-hero-1", sizingW: "fill", sizingH: "hug" })
    expect(shapes.find((s) => s.id === "shape:page1")!.props).toMatchObject({ name: "Landing", gap: 24, paddingY: 48, direction: "row", bg: "#faf6ea" })
  })

  test("invalid ui-block / auto-layout-frame ops are refused, nothing applied", async () => {
    const at = (raw: unknown) => { try { parseBoardOps(raw); return -1 } catch (e) { return (e as BoardOpError).at } }
    expect(at([{ op: "create", type: "ui-block" }])).toBe(0)
    expect(at([{ op: "create", type: "ui-block", props: { slug: "not-in-manifest" } }])).toBe(0)
    expect(at([{ op: "create", type: "note", props: { w: 1 } }])).toBe(0)
    expect(at([{ op: "update", id: "shape:x", props: [] }])).toBe(0)
    const room = newRoom()
    await boardWrite(parseBoardOps([{ op: "create", type: "auto-layout-frame", id: "shape:f", props: { name: "F" } }, { op: "create", type: "note", id: "shape:n" }]), "t", room)
    const refused = async (ops: unknown[], index: number) => {
      const before = JSON.stringify(boardRecords(room))
      await expect(boardWrite(parseBoardOps(ops), "t", room)).rejects.toMatchObject({ at: index })
      expect(JSON.stringify(boardRecords(room))).toBe(before)
    }
    await refused([{ op: "create", type: "note", id: "shape:ok" }, { op: "create", type: "auto-layout-frame", props: { gap: -4 } }], 1)
    await refused([{ op: "create", type: "auto-layout-frame", props: { direction: "diagonal" } }], 0)
    await refused([{ op: "create", type: "ui-block", props: { slug: "fit-text-01", sizingH: "fill" } }], 0)
    await refused([{ op: "update", id: "shape:f", props: { justify: "space-around" } }], 0)
    await refused([{ op: "update", id: "shape:f", props: { clip: true } }], 0)
    await refused([{ op: "update", id: "shape:f", props: { bg: "red" } }], 0)
    await refused([{ op: "update", id: "shape:n", props: { color: "red" } }], 0)
    await refused([{ op: "create", type: "ui-block", props: { slug: "fit-text-01", w: 0 } }], 0)
  })

  test("draw / highlight: page bounds from the decoded points (scaleX applied); rect scopes the read", async () => {
    const room = newRoom()
    await putStroke(room, "shape:ink", "draw", [{ x: 10, y: 20 }, { x: 60, y: 70 }, { x: 110, y: 20 }], { x: 100, y: 50 }, 2)
    await putStroke(room, "shape:hl", "highlight", [{ x: -5, y: 0 }, { x: 45, y: 10 }], { x: 1000, y: 1000 })
    validateAll(room)
    const read = boardRead({}, room)
    expect(read.shapes.find((s) => s.id === "shape:ink")!.page).toEqual({ x: 120, y: 70, w: 200, h: 50 })
    expect(read.shapes.find((s) => s.id === "shape:hl")!.page).toEqual({ x: 995, y: 1000, w: 50, h: 10 })
    expect(boardRead({ rect: { x: 300, y: 100, w: 10, h: 10 } }, room).shapes.map((s) => s.id)).toEqual(["shape:ink"])
    expect(boardRead({ rect: { x: 330, y: 0, w: 600, h: 60 } }, room).shapes).toEqual([])
  })

  test("renderBoardRegion: a valid PNG with the stroke's red along its path, white elsewhere", async () => {
    const room = newRoom()
    await putStroke(room, "shape:ink", "draw", [{ x: 10, y: 20 }, { x: 60, y: 70 }, { x: 110, y: 20 }], { x: 100, y: 50 }, 2)
    await boardWrite(parseBoardOps([{ op: "create", type: "note", id: "shape:n", x: 2000, y: 2000, text: "far & <away>" }]), "t", room)
    const out = await renderBoardRegion({ ids: ["shape:ink"] }, room)
    expect(out.shapeCount).toBe(1)
    expect(out.rect).toEqual({ x: 88, y: 38, w: 264, h: 114 })
    expect([...out.png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const { data, info } = await sharp(out.png).raw().toBuffer({ resolveWithObject: true })
    expect([info.width, info.height]).toEqual([660, 285]) // scale 2.5 (the cap)
    const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)]
    const [r, g, b] = px(Math.round((220 - 88) * 2.5), Math.round((120 - 38) * 2.5)) // the middle point (60·2, 70) + (100, 50)
    expect(r).toBeGreaterThan(180)
    expect(g).toBeLessThan(120)
    expect(b).toBeLessThan(120)
    expect(px(5, 5)).toEqual([255, 255, 255])
    const all = await renderBoardRegion({ rect: { x: 0, y: 0, w: 4000, h: 2500 }, maxDim: 800 }, room)
    expect(all.shapeCount).toBe(2)
    expect((await sharp(all.png).metadata()).width).toBe(800)
    await expect(renderBoardRegion({ rect: { x: 0, y: 0, w: 0, h: 10 } }, room)).rejects.toThrow("rect")
  })

  test("a bound arrow's bounds span its ends; text gets a height; XML-invalid chars don't break the render", async () => {
    const room = newRoom()
    await boardWrite(parseBoardOps([
      { op: "create", type: "geo", id: "shape:a", x: 1000, y: 1000, w: 100, h: 100 },
      { op: "create", type: "geo", id: "shape:b", x: 1400, y: 1000, w: 100, h: 100 },
      { op: "create", type: "arrow", id: "shape:ar", from: "shape:a", to: "shape:b" },
      { op: "create", type: "text", id: "shape:t", x: 0, y: 0, text: "one\ntwo \x1b[31m\x0c\ud800\ufffe\uffff" },
    ]), "t", room)
    const read = boardRead({}, room)
    expect(read.shapes.find((s) => s.id === "shape:ar")!.page).toEqual({ x: 1050, y: 1050, w: 400, h: 0 })
    expect(read.shapes.find((s) => s.id === "shape:t")!.page.h).toBe(60)
    expect(boardRead({ rect: { x: 1200, y: 1040, w: 10, h: 20 } }, room).shapes.map((s) => s.id)).toEqual(["shape:ar"])
    expect((await renderBoardRegion({ ids: ["shape:ar"] }, room)).rect).toEqual({ x: 1018, y: 1018, w: 464, h: 64 })
    expect((await renderBoardRegion({ ids: ["shape:t"] }, room)).shapeCount).toBe(1)
  })
})
