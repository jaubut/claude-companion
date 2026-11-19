import { createShapePropsMigrationSequence, createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema"
import { T } from "@tldraw/validate"

// The Canvas board's record schema (canvas-board-sync). A copy of the client's:
// tldraw's default shapes plus `live-frame`, whose props are copied from
// claude-companion-ios web/tldraw-canvas/src/LiveFrame.tsx `static props`.
// The server can't import that repo, so two guards keep them equal: the sync
// handshake refuses a client whose schema differs, and board-records.test.ts
// validates a live-frame literal built from LiveFrame's default props.
// Both repos pin every tldraw package to exactly 5.6.0 and bump together.
//
// `ui-block` and `auto-layout-frame` (canvas auto-layout S1, docs/board-api.md)
// mirror the client's features/canvas/schema. Any prop change = a migration
// here and there in the same pair of PRs, server deployed first.

export const LIVE_FRAME_TYPE = "live-frame"
export const UI_BLOCK_TYPE = "ui-block"
export const AUTO_LAYOUT_FRAME_TYPE = "auto-layout-frame"

export const liveFrameProps = { w: T.number, h: T.number, html: T.string, title: T.string }

/** The iframe widths a ui-block snaps to (BYQ's own breakpoints follow the block's w). */
export const UI_BLOCK_WIDTHS = { desktop: 1280, tablet: 768, mobile: 390 } as const

const BYQ_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/
const COLOR = /^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?)?$/
const MAX_SIZE = 100_000
const MAX_SPACING = 1_000
const size = T.nonZeroNumber.check((n) => { if (n > MAX_SIZE) throw new Error(`Expected at most ${MAX_SIZE}, got ${n}`) })
const spacing = T.positiveNumber.check((n) => { if (n > MAX_SPACING) throw new Error(`Expected at most ${MAX_SPACING}, got ${n}`) })
const pattern = (re: RegExp, what: string) => T.string.check((s) => { if (!re.test(s)) throw new Error(`Expected ${what}, got ${JSON.stringify(s.slice(0, 40))}`) })

/** A BYQ section or gem rendered in its own sandboxed iframe; h hugs the content height it reports. */
export const uiBlockProps = {
  w: size,
  h: size,
  slug: pattern(BYQ_SLUG, "a BYQ slug"),
  sizingW: T.literalEnum("fixed", "fill"),
  sizingH: T.literalEnum("fixed", "hug"),
}

/** A CSS flex container; the client lays out its children in the DOM and writes their x/y/w/h back. */
export const autoLayoutFrameProps = {
  w: size,
  h: size,
  name: T.string.check((s) => { if (s.length > 200) throw new Error("Expected at most 200 characters") }),
  direction: T.literalEnum("row", "column"),
  justify: T.literalEnum("flex-start", "center", "flex-end", "space-between"),
  align: T.literalEnum("flex-start", "center", "flex-end", "stretch"),
  gap: spacing,
  paddingX: spacing,
  paddingY: spacing,
  sizingW: T.literalEnum("fixed", "hug", "fill"),
  sizingH: T.literalEnum("fixed", "hug", "fill"),
  bg: pattern(COLOR, "#rrggbb, #rrggbbaa or empty"),
  radius: spacing,
}

// Version 0 on both sides; append migrations here (and in the client) when a prop changes.
const noMigrations = () => createShapePropsMigrationSequence({ sequence: [] })

export const boardSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    [LIVE_FRAME_TYPE]: { props: liveFrameProps },
    [UI_BLOCK_TYPE]: { props: uiBlockProps, migrations: noMigrations() },
    [AUTO_LAYOUT_FRAME_TYPE]: { props: autoLayoutFrameProps, migrations: noMigrations() },
  },
})
