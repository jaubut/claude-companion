import { describe, expect, test } from "bun:test"
import { toRichText } from "@tldraw/tlschema"
import { BOARD_SHAPE_TYPES, buildArrowBindings, buildShape, nextIndex, richTextToPlain } from "./board-records"
import { LIVE_FRAME_TYPE, boardSchema } from "./board-schema"

// Every record board_write builds must pass tldraw 5.6.0 validation: a bump
// that adds a required prop fails here before prod (canvas-board-sync).

const validate = (rec: object) => boardSchema.types[(rec as { typeName: "shape" }).typeName].validate(rec as never)

describe("board records", () => {
  test("every buildable shape type validates against boardSchema", () => {
    for (const type of BOARD_SHAPE_TYPES) {
      const rec = buildShape({ type, parentId: "page:page", index: "a1", x: 1, y: 2, by: "brain", text: "hi", html: "<p>x</p>" })
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
