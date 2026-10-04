import type { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { BodyHost } from "./body-investigate"

// Body fixes for MAC components run LIVE ON THE MAC (Jeremie, 2026-10-04).
// A #Body card whose fix belongs to the Mac is recorded here with its owning
// host and cwd. Approving it on Zettlab never files a headless Turso task that
// Zettlab's dispatch-run could claim: the approval is forwarded to the Mac
// Companion (`POST /api/body/fix`), which runs it through its own live path
// (claimLive owner companion:<mac>, tmux worker, the fix's own cwd).
// Seams only: the store takes its Database; the wiring is wiring/body-fix.ts.

export const FIX_TIMEOUT_MS = 30_000

export interface FixCard {
  taskId: string
  host: string
  componentId: string
  cwd: string
  noteId: string
  agent: string
  title: string
  investigationId: string
}

export interface BodyFixStore {
  /** Zettlab side: the card → its owning host + cwd. */
  recordCard(card: FixCard, now: number): void
  card(taskId: string): FixCard | null
  /** Mac side: the forwarded fix id → the local proposal row that runs it. */
  recordRun(fixId: string, taskId: string, now: number): void
  run(fixId: string): string | null
}

interface CardRow {
  task_id: string; host: string; component_id: string; cwd: string; note_id: string; agent: string; title: string; investigation_id: string
}

export function createBodyFixStore(db: Database): BodyFixStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS body_fix_cards (
      task_id TEXT PRIMARY KEY, host TEXT NOT NULL, component_id TEXT NOT NULL, cwd TEXT NOT NULL,
      note_id TEXT NOT NULL, agent TEXT NOT NULL, title TEXT NOT NULL, investigation_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS body_fix_runs (
      fix_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `)
  return {
    recordCard(c, now) {
      db.query(
        "INSERT OR REPLACE INTO body_fix_cards (task_id, host, component_id, cwd, note_id, agent, title, investigation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(c.taskId, c.host, c.componentId, c.cwd, c.noteId, c.agent, c.title, c.investigationId, now)
    },
    card(taskId) {
      const r = db.query("SELECT * FROM body_fix_cards WHERE task_id = ?").get(taskId) as CardRow | null
      return r ? { taskId: r.task_id, host: r.host, componentId: r.component_id, cwd: r.cwd, noteId: r.note_id, agent: r.agent, title: r.title, investigationId: r.investigation_id } : null
    },
    recordRun(fixId, taskId, now) {
      db.query("INSERT OR IGNORE INTO body_fix_runs (fix_id, task_id, created_at) VALUES (?, ?, ?)").run(fixId, taskId, now)
    },
    run(fixId) {
      return (db.query("SELECT task_id FROM body_fix_runs WHERE fix_id = ?").get(fixId) as { task_id: string } | null)?.task_id ?? null
    },
  }
}

/** Does approving this card have to run on another host? */
/**
 * A fix's cwd as it exists on THIS host. Cards are written on Zettlab for Mac
 * components, so a path may carry `~` or the other host's home
 * (/home/aubut/… vs /Users/jeremieaubut/…): expand `~`, keep a path that exists,
 * else re-root a foreign home prefix onto this host's home.
 */
export function localizeCwd(cwd: string, home: string = homedir(), exists: (p: string) => boolean = existsSync): string {
  const c = cwd.trim()
  if (c === "~") return home
  if (c.startsWith("~/")) return join(home, c.slice(2))
  if (exists(c)) return c
  const m = c.match(/^\/(?:home|Users)\/[^/]+(\/.*)?$/)
  return m ? home + (m[1] ?? "") : c
}

export function fixRunsElsewhere(card: FixCard | null, local: BodyHost): boolean {
  return !!card && card.host === "mac" && local !== "mac"
}

// ── POST /api/body/fix body ──────────────────────────────────────────────────

export interface FixRequest {
  fixId: string
  host: string
  componentId: string
  prompt: string
  title: string
  cwd: string
  noteId: string
  agent: string
  investigationId: string
}

const s = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null)

export function parseFixRequest(raw: unknown): FixRequest | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be a JSON object" }
  const o = raw as Record<string, unknown>
  const fixId = s(o.fixId, 64)
  if (!fixId || !/^[A-Za-z0-9-]+$/.test(fixId)) return { error: "fixId invalid" }
  const req = {
    fixId, host: s(o.host, 32), componentId: s(o.componentId, 200), prompt: s(o.prompt, 20_000), title: s(o.title, 120),
    cwd: s(o.cwd, 500), noteId: s(o.noteId, 200), agent: s(o.agent, 64), investigationId: s(o.investigationId, 64) ?? "",
  }
  for (const k of ["host", "componentId", "prompt", "title", "cwd", "noteId", "agent"] as const) if (!req[k]) return { error: `${k} required` }
  if (!req.cwd!.startsWith("/")) return { error: "cwd must be absolute" }
  return req as FixRequest
}

export function fixRequestFor(card: FixCard, prompt: string): FixRequest {
  return {
    fixId: card.taskId, host: card.host, componentId: card.componentId, prompt, title: card.title, cwd: card.cwd,
    noteId: card.noteId, agent: card.agent, investigationId: card.investigationId,
  }
}

// ── Peer client ──────────────────────────────────────────────────────────────

export type PeerFixResult =
  | { kind: "ok"; json: Record<string, unknown> }
  | { kind: "refused"; status: number; json: Record<string, unknown> | null }
  | { kind: "unreachable"; reason: string }

/** POST the approved fix to the owning host. Network error / timeout / redirect → unreachable. */
export async function postFix(
  cfg: { base: string; token: string }, req: FixRequest, hopHeader: string, fetchFn: typeof fetch = fetch, timeoutMs = FIX_TIMEOUT_MS,
): Promise<PeerFixResult> {
  let res: Response
  try {
    res = await fetchFn(`${cfg.base}/api/body/fix`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", [hopHeader]: "1" },
      body: JSON.stringify(req),
    })
  } catch (e) {
    return { kind: "unreachable", reason: `${(e as Error)?.name ?? "error"}` }
  }
  if (res.status >= 300 && res.status < 400) return { kind: "unreachable", reason: `redirect ${res.status}` }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (res.ok && json?.ok === true && typeof json.dispatchTaskId === "string") return { kind: "ok", json }
  return { kind: "refused", status: res.ok ? 502 : res.status, json }
}
