import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from "@tldraw/sync-core"
import type { TLRecord } from "@tldraw/tlschema"
import { companionDbPath } from "./db-path"
import { companionLog } from "./log"
import { externalizeDataUrls } from "./board-assets"
import { boardSchema } from "./board-schema"
import type { BoardRecord } from "./board-records"

// The Canvas board document (canvas-board-sync): one tldraw sync room, `main`,
// on the brain host. Clients (Mac Canvas, iPad) are replicas over the sync WS;
// agents edit through room.updateStore (lib/board-tools.ts). Every commit lands
// in companion.db (board_documents / board_tombstones / board_metadata), so
// there is no snapshot file and nothing to debounce.

export type BoardRoom = TLSocketRoom<TLRecord, void>

let room: BoardRoom | null = null
let db: Database | null = null
let importChain: Promise<unknown> = Promise.resolve()

/** The room, opened on first use from companion.db (COMPANION_DB_PATH in tests). */
export function boardRoom(): BoardRoom {
  if (room && !room.isClosed()) return room
  const path = companionDbPath()
  mkdirSync(dirname(path), { recursive: true })
  db = new Database(path)
  db.exec("PRAGMA busy_timeout = 5000")
  const storage = new SQLiteSyncStorage<TLRecord>({ sql: new NodeSqliteWrapper(db, { tablePrefix: "board_" }) })
  room = new TLSocketRoom<TLRecord, void>({
    schema: boardSchema,
    storage,
    log: { warn: (...a: unknown[]) => companionLog(`board warn ${a.map(String).join(" ")}`), error: (...a: unknown[]) => companionLog(`board error ${a.map(String).join(" ")}`) },
  })
  return room
}

/** Close the room and its sqlite handle (tests reopen to prove persistence). */
export function closeBoardRoom(): void {
  room?.close()
  db?.close()
  room = null
  db = null
}

export function boardRecords(r: BoardRoom = boardRoom()): BoardRecord[] {
  return r.getCurrentSnapshot().documents.map((d) => d.state as unknown as BoardRecord)
}

export interface PresenceRecord {
  id: string
  userName?: string
  currentPageId?: string
  selectedShapeIds?: string[]
  camera?: { x: number; y: number; z: number }
  screenBounds?: { x: number; y: number; w: number; h: number }
  lastActivityTimestamp?: number | null
}

/**
 * Who is on the board, newest activity first. getPresenceRecords() is @internal
 * in @tldraw/sync-core 5.6.0 (exact pin + board-room.test.ts): this adapter is
 * its only caller, and it fails open to [] if the method goes away.
 */
export function boardPresence(r: BoardRoom = boardRoom()): PresenceRecord[] {
  const fn = (r as unknown as { getPresenceRecords?: () => Record<string, unknown> }).getPresenceRecords
  if (typeof fn !== "function") return []
  try {
    const recs = Object.values(fn.call(r)) as PresenceRecord[]
    return recs.sort((a, b) => (b.lastActivityTimestamp ?? 0) - (a.lastActivityTimestamp ?? 0))
  } catch {
    return []
  }
}

/** Close reason for a client on an older board schema; the Canvas shows it as is. */
export const BOARD_CLIENT_TOO_OLD = "CLIENT_TOO_OLD: Mettre à jour le Canvas"

/**
 * Why a sync client's schema can't join the board, or null. tldraw's room only
 * compares the sequences both sides have, so it accepts a client missing one
 * (a pre-S1 Canvas, which then drops its live sync on the first ui-block) or
 * carrying one the server lacks. Any difference is refused at connect:
 * a sequence missing or lower → BOARD_CLIENT_TOO_OLD, unknown or higher →
 * SERVER_TOO_OLD. A malformed schema is left to the room.
 */
export function boardSchemaMismatch(schema: unknown): string | null {
  const ours = boardSchema.serialize().sequences
  const theirs = (schema as { sequences?: unknown } | null)?.sequences
  if (!theirs || typeof theirs !== "object") return null
  const t = theirs as Record<string, unknown>
  for (const [id, v] of Object.entries(t)) {
    if (typeof v !== "number") return null
    if (!Object.hasOwn(ours, id) || v > ours[id]!) return "SERVER_TOO_OLD"
  }
  return Object.entries(ours).some(([id, v]) => !Object.hasOwn(t, id) || (t[id] as number) < v) ? BOARD_CLIENT_TOO_OLD : null
}

export type ImportResult = { ok: true; imported: number } | { ok: false; status: number; error: string }

const DOCUMENT_TYPES = new Set(["document", "page", "shape", "binding", "asset"])

/**
 * Load a device's legacy board into an empty room. `getSnapshot(store)`'s
 * `{document:{store,schema}}` or a bare `{store,schema}`. Serialized on one
 * chain with the empty check inside it: when the Mac and the iPad import at
 * once, one wins and the other gets 409 board_not_empty.
 */
export function importBoard(snapshot: unknown, r: BoardRoom = boardRoom()): Promise<ImportResult> {
  const run = importChain.then(() => importNow(snapshot, r))
  importChain = run.catch(() => undefined)
  return run
}

function importNow(snapshot: unknown, r: BoardRoom): ImportResult {
  if (boardRecords(r).some((rec) => rec.typeName === "shape")) return { ok: false, status: 409, error: "board_not_empty" }
  const snap = (snapshot as { document?: unknown }).document ?? snapshot
  const { store, schema } = snap as { store?: unknown; schema?: unknown }
  if (!store || typeof store !== "object" || !schema || typeof schema !== "object") return { ok: false, status: 400, error: "bad_snapshot" }
  // After the empty check, so a refused import writes no asset files.
  externalizeDataUrls(store as Record<string, unknown>)
  const docs: Record<string, BoardRecord> = {}
  for (const [id, rec] of Object.entries(store as Record<string, BoardRecord>)) {
    if (rec && typeof rec === "object" && DOCUMENT_TYPES.has(rec.typeName)) docs[id] = rec
  }
  try {
    // Migrate to our schema, then validate every record before anything is written.
    const migrated = boardSchema.migrateStoreSnapshot({ store: docs, schema } as never)
    if (migrated.type !== "success") return { ok: false, status: 400, error: "bad_snapshot" }
    const records = Object.values(migrated.value) as unknown as BoardRecord[]
    for (const rec of records) boardSchema.types[rec.typeName as TLRecord["typeName"]].validate(rec)
    r.loadSnapshot({ store: migrated.value, schema: boardSchema.serialize() })
    return { ok: true, imported: records.filter((x) => x.typeName === "shape").length }
  } catch (err) {
    companionLog(`board import refused: ${(err as Error)?.message ?? String(err)}`.slice(0, 300))
    return { ok: false, status: 400, error: "bad_snapshot" }
  }
}
