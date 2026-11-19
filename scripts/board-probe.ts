#!/usr/bin/env bun
// A scripted board sync client (canvas-board-sync): a headless tldraw store
// synced to /api/board/sync, the same protocol the Canvas clients speak. Used
// by server/lib/board-room.test.ts and by hand:
//   COMPANION_PROBE_TOKEN=… bun scripts/board-probe.ts --url https://zettlab.tailfc45f2.ts.net [--note "text"]
// prints every shape change (id, type, text, meta.by) until Ctrl-C.
import { atom } from "@tldraw/state"
import { Store } from "@tldraw/store"
import * as syncCore from "@tldraw/sync-core"
import { type TLPersistentClientSocket, TLSyncClient } from "@tldraw/sync-core"
import { InstancePresenceRecordType, type TLRecord } from "@tldraw/tlschema"
import { buildShape, nextIndex, richTextToPlain } from "../server/lib/board-records"
import { boardSchema } from "../server/lib/board-schema"

// ClientWebSocketAdapter listens for browser online/visibility hints, the
// store's instance record reads window.devicePixelRatio and the store batches
// on animation frames: inert stand-ins outside a browser.
const g = globalThis as unknown as { window?: unknown; document?: unknown; requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown }
const inert = { addEventListener() {}, removeEventListener() {} }
g.window ??= { ...inert, devicePixelRatio: 1 }
g.document ??= { ...inert, hidden: false }
g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 16)
g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id)

type Rec = TLRecord & Record<string, unknown>
// The browser socket adapter tldraw's useSync uses: exported at runtime, left out of the 5.6.0 public types.
const { ClientWebSocketAdapter } = syncCore as unknown as { ClientWebSocketAdapter: new (getUri: () => string) => TLPersistentClientSocket<never, never> & { close(): void } }

export interface BoardProbe {
  store: Store<TLRecord>
  records(): Rec[]
  /** Put a note (page coordinates) on the first page; returns its id. */
  note(text: string, x?: number, y?: number): string
  /** Set this probe's presence (page = first page). */
  presence(selection: string[]): void
  /** Resolve once `pred` holds over the records (polled every 10 ms), else reject after `ms`. */
  waitFor(pred: (recs: Rec[]) => boolean, ms?: number): Promise<number>
  close(): void
}

export async function connectBoardProbe(opts: { url: string; token: string; user?: string }): Promise<BoardProbe> {
  const store = new Store<TLRecord>({ schema: boardSchema as never, props: { defaultName: "", assets: { upload: async () => ({ src: "" }), resolve: () => null, remove: async () => {} }, onMount: () => {} } })
  const presence = atom<TLRecord | null>("presence", null)
  const base = opts.url.replace(/^http/, "ws").replace(/\/$/, "")
  const sessionId = crypto.randomUUID().replace(/-/g, "")
  const socket = new ClientWebSocketAdapter(() => `${base}/api/board/sync?token=${encodeURIComponent(opts.token)}&sessionId=${sessionId}&storeId=${store.id}`)
  const records = () => store.allRecords() as Rec[]
  const firstPage = () => records().find((r) => r.typeName === "page")!.id
  let client: TLSyncClient<TLRecord> | null = null
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("probe: no sync within 8 s")), 8000)
    client = new TLSyncClient({
      store,
      socket,
      presence,
      presenceMode: atom("presenceMode", "full" as const),
      onLoad: () => { clearTimeout(timer); resolve() },
      onSyncError: (reason) => { clearTimeout(timer); reject(new Error(`probe: sync error ${reason}`)) },
    })
  })
  return {
    store,
    records,
    note(text, x = 0, y = 0) {
      const page = firstPage()
      const siblings = records().filter((r) => r.typeName === "shape" && r.parentId === page).map((r) => String(r.index))
      const rec = buildShape({ type: "note", parentId: page, index: nextIndex(siblings), x, y, text, by: opts.user ?? "probe" })
      store.put([rec as unknown as TLRecord])
      return rec.id
    },
    presence(selection) {
      presence.set(InstancePresenceRecordType.create({
        id: InstancePresenceRecordType.createId(sessionId),
        userId: `user:${sessionId}` as never,
        userName: opts.user ?? "probe",
        currentPageId: firstPage() as never,
        selectedShapeIds: selection as never,
        camera: { x: 0, y: 0, z: 1 },
        screenBounds: { x: 0, y: 0, w: 1200, h: 800 },
        lastActivityTimestamp: Date.now(),
      }) as TLRecord)
    },
    waitFor(pred, ms = 1000) {
      const start = performance.now()
      return new Promise((resolve, reject) => {
        const tick = () => {
          const took = performance.now() - start
          if (pred(records())) return resolve(took)
          if (took > ms) return reject(new Error(`probe: condition not met within ${ms} ms`))
          setTimeout(tick, 10)
        }
        tick()
      })
    },
    close() {
      client?.close()
      socket.close()
    },
  }
}

if (import.meta.main) {
  const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
  const url = arg("--url") ?? "http://127.0.0.1:4245"
  const token = process.env.COMPANION_PROBE_TOKEN ?? process.env.COMPANION_PEER_ZETTLAB_TOKEN ?? process.env.COMPANION_AUTH_TOKEN ?? ""
  if (!token) { console.error("board-probe: set COMPANION_PROBE_TOKEN (or COMPANION_PEER_ZETTLAB_TOKEN)"); process.exit(1) }
  const probe = await connectBoardProbe({ url, token })
  const shapes = probe.records().filter((r) => r.typeName === "shape")
  console.log(`connected: ${shapes.length} shapes`)
  const text = arg("--note")
  if (text) console.log(`put ${probe.note(text)}`)
  probe.store.listen(({ changes }) => {
    for (const r of [...Object.values(changes.added), ...Object.values(changes.updated).map(([, to]) => to)] as Rec[]) {
      if (r.typeName !== "shape") continue
      const props = r.props as { richText?: unknown }
      console.log(`${r.id} ${String(r.type)} "${richTextToPlain(props.richText)}" by=${String((r.meta as { by?: unknown }).by ?? "")}`)
    }
    for (const r of Object.values(changes.removed) as Rec[]) console.log(`removed ${r.id}`)
  }, { source: "remote", scope: "document" })
}
