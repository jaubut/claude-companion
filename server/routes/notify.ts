import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { companionDbPath } from "../lib/db-path"
import { companionLog } from "../lib/log"
import {
  type GateDeps, type NotifyInput, type NotifyStore,
  createNotifyGate, createNotifyStore, parseNotify, reportCounts, resolveMode,
} from "../lib/notify-gate"
import { runBrainCall } from "../lib/orchestrator-brain"
import { pushToAll } from "../lib/push"
import { type QueryFn, tursoQuery } from "../lib/turso"

// Notify gate API (RES-6TV5). Auth is the `/api/*` bearer gate in
// companion-server.ts. Contract: docs/notify-api.md.
//   POST /api/notify               {source, severity, title, body, dedupKey, actionable, url?} → {ok, id, decision, reason, mode, delivered}
//   GET  /api/notify/report?days=N  counts per source × decision (shadow review), N in 1–30, default 7

export const NOTIFY_MODEL = process.env.COMPANION_NOTIFY_MODEL || "claude-haiku-5-5"
export const PREFS_TTL_MS = 10 * 60_000
const JUDGE_TIMEOUT_MS = 20_000
const KILL_FILE = join(homedir(), ".claude", ".notify-gate-disabled")
const DAY_MS = 24 * 60 * 60_000

/** The newest resources note tagged notify-prefs, cached 10 min (a miss is cached too; an error is not). */
export function createPrefsReader(query: QueryFn, now: () => number = Date.now): () => Promise<string | null> {
  let cached: { body: string | null; at: number } | null = null
  return async () => {
    if (cached && now() - cached.at < PREFS_TTL_MS) return cached.body
    const rows = await query(
      "SELECT body FROM notes WHERE folder = ? AND tags LIKE ? ORDER BY updated_at DESC LIMIT 1",
      ["resources", '%"notify-prefs"%'],
    )
    const raw = rows[0]?.body
    const body = typeof raw === "string" ? raw : null
    cached = { body, at: now() }
    return body
  }
}

/** The model call, bounded: a slow model is a failure (the gate fails open). */
async function judgeWithHaiku(prompt: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), JUDGE_TIMEOUT_MS) })
  try {
    return await Promise.race([runBrainCall(NOTIFY_MODEL, prompt), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Same delivery as POST /api/push/broadcast. */
async function pushNotify(i: NotifyInput, id: number): Promise<void> {
  const r = await pushToAll({
    title: i.title,
    subtitle: i.source,
    body: i.body,
    category: "briefing",
    threadId: `notify-${i.source}`,
    userInfo: { notifyId: String(id), source: i.source, ...(i.url ? { url: i.url } : {}) },
  })
  companionLog(`\x1b[36mnotify push\x1b[0m sent=${r.sent}/${r.total} title="${i.title.slice(0, 40)}"`)
}

export interface NotifyRouteDeps extends Partial<GateDeps> {
  store?: NotifyStore
}

// companion.db opened lazily on first use, like the other stores (wiring/canvas.ts).
let liveStore: NotifyStore | null = null
function openStore(): NotifyStore {
  if (!liveStore) {
    const path = companionDbPath()
    mkdirSync(dirname(path), { recursive: true })
    const d = new Database(path)
    d.exec("PRAGMA busy_timeout = 3000")
    liveStore = createNotifyStore(d)
  }
  return liveStore
}

export function createNotifyRoute(deps: NotifyRouteDeps = {}) {
  const now = deps.now ?? Date.now
  const store = (): NotifyStore => deps.store ?? openStore()
  let gate: ReturnType<typeof createNotifyGate> | null = null
  const getGate = () => (gate ??= createNotifyGate({
    store: store(),
    mode: deps.mode ?? (() => resolveMode(process.env.COMPANION_NOTIFY_GATE, existsSync(KILL_FILE))),
    prefs: deps.prefs ?? createPrefsReader(tursoQuery, now),
    judge: deps.judge ?? judgeWithHaiku,
    push: deps.push ?? pushNotify,
    now,
    log: deps.log ?? companionLog,
  }))

  return async function handleNotifyRoute(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === "/api/notify" && req.method === "POST") {
      const raw = await req.json().catch(() => null)
      const parsed = parseNotify(raw)
      if (!parsed.ok) return Response.json({ ok: false, error: parsed.error }, { status: 400 })
      const r = await getGate()(parsed.input)
      return Response.json({ ok: true, id: r.id, decision: r.decision, reason: r.reason, mode: r.mode, delivered: r.delivered })
    }
    if (url.pathname === "/api/notify/report" && req.method === "GET") {
      const rawDays = url.searchParams.get("days")
      const days = rawDays === null ? 7 : Number(rawDays)
      if (!Number.isInteger(days) || days < 1 || days > 30) {
        return Response.json({ ok: false, error: "days must be an integer 1–30" }, { status: 400 })
      }
      const since = now() - days * DAY_MS
      const rows = store().report(since)
      return Response.json({ ok: true, days, since: new Date(since).toISOString(), rows, counts: reportCounts(rows) })
    }
    return null
  }
}

export const handleNotifyRoute = createNotifyRoute()
