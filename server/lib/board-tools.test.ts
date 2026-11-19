import { describe, expect, test } from "bun:test"
import { InMemorySyncStorage, TLSocketRoom } from "@tldraw/sync-core"
import type { TLRecord } from "@tldraw/tlschema"
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
})
