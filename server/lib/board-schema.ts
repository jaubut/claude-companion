import { createTLSchema, defaultShapeSchemas } from "@tldraw/tlschema"
import { T } from "@tldraw/validate"

// The Canvas board's record schema (canvas-board-sync). A copy of the client's:
// tldraw's default shapes plus `live-frame`, whose props are copied from
// claude-companion-ios web/tldraw-canvas/src/LiveFrame.tsx `static props`.
// The server can't import that repo, so two guards keep them equal: the sync
// handshake refuses a client whose schema differs, and board-records.test.ts
// validates a live-frame literal built from LiveFrame's default props.
// Both repos pin every tldraw package to exactly 5.6.0 and bump together.

export const LIVE_FRAME_TYPE = "live-frame"

export const liveFrameProps = { w: T.number, h: T.number, html: T.string, title: T.string }

export const boardSchema = createTLSchema({
  shapes: { ...defaultShapeSchemas, [LIVE_FRAME_TYPE]: { props: liveFrameProps } },
})
