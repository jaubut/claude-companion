import { describe, expect, test } from "bun:test"
import { toRichText } from "@tldraw/tlschema"
import { BOARD_SHAPE_TYPES, buildArrowBindings, buildShape, nextIndex, richTextToPlain } from "./board-records"
import { AUTO_LAYOUT_FRAME_TYPE, LIVE_FRAME_TYPE, UI_BLOCK_TYPE, boardSchema } from "./board-schema"

// Every record board_write builds must pass tldraw 5.6.0 validation: a bump
// that adds a required prop fails here before prod (canvas-board-sync).

const validate = (rec: object) => boardSchema.types[(rec as { typeName: "shape" }).typeName].validate(rec as never)

describe("board records", () => {
  test("every buildable shape type validates against boardSchema", () => {
    for (const type of BOARD_SHAPE_TYPES) {
      const rec = buildShape({ type, parentId: "page:page", index: "a1", x: 1, y: 2, by: "brain", text: "hi", html: "<p>x</p>", props: type === UI_BLOCK_TYPE ? { slug: "fit-text-01" } : undefined })
      expect(() => validate(rec)).not.toThrow()
      expect(rec.meta).toEqual({ by: "brain" })
    }
  })

  test("arrow bindings validate (start/end terminals)", () => {
    const bindings = buildArrowBindings("shape:arrow", "shape:a", "shape:b")
    expect(bindings.map((b) => (b.props as { terminal: string }).terminal)).toEqual(["start", "end"])
    for (const b of bindings) expect(() => validate(b)).not.toThrow()
  })

  test("a live-frame literal with LiveFrame.tsx's default props validates; a wrong prop type is refused", () => {
    const frame = {
      id: "shape:lf", typeName: "shape", type: LIVE_FRAME_TYPE, parentId: "page:page", index: "a1", x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {},
      props: { w: 640, h: 400, html: '<div class="p-8">Empty frame</div>', title: "Live frame" },
    }
    expect(() => validate(frame)).not.toThrow()
    expect(() => validate({ ...frame, props: { ...frame.props, w: "640" } })).toThrow()
  })

  // The client's features/canvas/schema defaults (docs/board-api.md "ui-block / auto-layout-frame").
  const base = { typeName: "shape", parentId: "page:page", index: "a1", x: 0, y: 0, rotation: 0, isLocked: false, opacity: 1, meta: {} }
  const block = { ...base, id: "shape:ub", type: UI_BLOCK_TYPE, props: { w: 1280, h: 720, slug: "algarve-hero-1", sizingW: "fixed", sizingH: "hug" } }
  const frame = { ...base, id: "shape:al", type: AUTO_LAYOUT_FRAME_TYPE, props: { w: 1280, h: 800, name: "Frame", direction: "column", justify: "flex-start", align: "stretch", gap: 0, paddingX: 0, paddingY: 0, sizingW: "fixed", sizingH: "hug", bg: "", radius: 0 } }

  test("ui-block and auto-layout-frame literals with the client's default props validate", () => {
    expect(() => validate(block)).not.toThrow()
    expect(() => validate(frame)).not.toThrow()
    expect(() => validate({ ...frame, props: { ...frame.props, bg: "#0a0B0cFF", direction: "row", sizingW: "fill" } })).not.toThrow()
  })

  test("invalid ui-block / auto-layout-frame props are refused", () => {
    const bad = (rec: typeof block | typeof frame, patch: Record<string, unknown>) => expect(() => validate({ ...rec, props: { ...rec.props, ...patch } })).toThrow()
    bad(block, { w: 0 })
    bad(block, { h: -5 })
    bad(block, { w: 200_000 })
    bad(block, { slug: "" })
    bad(block, { slug: "../etc/passwd" })
    bad(block, { sizingH: "fill" })
    bad(block, { sizingW: "hug" })
    bad(block, { variantProps: {} })
    bad(frame, { direction: "diagonal" })
    bad(frame, { justify: "space-around" })
    bad(frame, { align: "baseline" })
    bad(frame, { gap: -1 })
    bad(frame, { paddingX: 5000 })
    bad(frame, { gap: "8" })
    bad(frame, { bg: "red" })
    bad(frame, { bg: "url(javascript:x)" })
    bad(frame, { name: "x".repeat(201) })
    const { radius: _, ...noRadius } = frame.props
    expect(() => validate({ ...frame, props: noRadius })).toThrow()
  })

  test("richTextToPlain: paragraphs → newline", () => {
    expect(richTextToPlain(toRichText("one\ntwo"))).toBe("one\ntwo")
    expect(richTextToPlain(null)).toBe("")
  })

  test("nextIndex is above every sibling", () => {
    const top = nextIndex(["a1", "a3", "a2"])
    expect(top > "a3").toBe(true)
    expect(nextIndex([]) > "").toBe(true)
  })
})
