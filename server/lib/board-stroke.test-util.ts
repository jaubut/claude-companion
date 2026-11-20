import { b64Vecs } from "@tldraw/tlschema"
import type { BoardRoom } from "./board-room"

/** An Apple Pencil stroke as the client stores it: b64Vecs-encoded segments, shape-local points. */
export const putStroke = (room: BoardRoom, id: string, type: "draw" | "highlight", points: Array<{ x: number; y: number }>, at: { x: number; y: number }, scaleX = 1) =>
  room.updateStore((store) => {
    const segments = [{ type: "free", path: b64Vecs.encodePoints(points) }]
    const props = type === "draw"
      ? { color: "red", fill: "none", dash: "draw", size: "m", segments, isComplete: true, isClosed: false, isPen: true, scale: 1, scaleX, scaleY: 1 }
      : { color: "yellow", size: "m", segments, isComplete: true, isPen: true, scale: 1, scaleX, scaleY: 1 }
    store.put({ typeName: "shape", id, type, parentId: "page:page", index: "a1", x: at.x, y: at.y, rotation: 0, isLocked: false, opacity: 1, meta: {}, props } as never)
  })
