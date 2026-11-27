import type { Database } from "bun:sqlite"
import { db as defaultDb } from "./orchestrator-db"
import type { PostgresSqlTag, TelemetrySink } from "./orchestrator-telemetry"

export const DEFAULT_COLD_SUMMARIZER_MODEL = "gemini-3.5-flash-lite"

export interface SessionSummaryRecord {
  sessionId: string
  summarizedUpToTurnId: number
  summaryMarkdown: string
  createdAt?: string
  updatedAt?: string
}

export function ensureSessionSummariesTable(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id TEXT PRIMARY KEY,
      summarized_up_to_turn_id INTEGER NOT NULL,
      summary_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `)
}

ensureSessionSummariesTable(defaultDb)

function isSqliteDb(sink: TelemetrySink): sink is Database {
  return typeof sink === "object" && sink !== null && "query" in sink && typeof sink.query === "function"
}

export async function upsertSessionSummary(
  sink: TelemetrySink,
  record: { sessionId: string; summarizedUpToTurnId: number; summaryMarkdown: string },
): Promise<void> {
  const sessionId = record.sessionId.trim().slice(0, 128)
  if (!sessionId) return
  const turnId = Number.isFinite(record.summarizedUpToTurnId) ? Math.max(0, Math.round(record.summarizedUpToTurnId)) : 0
  const markdown = record.summaryMarkdown.trim()

  if (isSqliteDb(sink)) {
    ensureSessionSummariesTable(sink)
    sink.query(
      `INSERT INTO session_summaries (session_id, summarized_up_to_turn_id, summary_markdown, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(session_id) DO UPDATE SET
         summarized_up_to_turn_id = excluded.summarized_up_to_turn_id,
         summary_markdown = excluded.summary_markdown,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).run(sessionId, turnId, markdown)
    return
  }

  await sink`
    INSERT INTO session_summaries (
      session_id, summarized_up_to_turn_id, summary_markdown, updated_at
    ) VALUES (
      ${sessionId}, ${turnId}, ${markdown}, NOW()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      summarized_up_to_turn_id = EXCLUDED.summarized_up_to_turn_id,
      summary_markdown = EXCLUDED.summary_markdown,
      updated_at = NOW();
  `
}

interface RawSummaryRow {
  session_id: string
  summarized_up_to_turn_id: number
  summary_markdown: string
  created_at: string
  updated_at: string
}

export function getSessionSummarySync(sqlite: Database = defaultDb, sessionId: string): SessionSummaryRecord | null {
  const clean = sessionId.trim()
  if (!clean) return null
  ensureSessionSummariesTable(sqlite)
  const row = sqlite
    .query("SELECT * FROM session_summaries WHERE session_id = ?")
    .get(clean) as RawSummaryRow | null
  if (!row) return null
  return {
    sessionId: row.session_id,
    summarizedUpToTurnId: Number(row.summarized_up_to_turn_id),
    summaryMarkdown: row.summary_markdown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function getSessionSummary(
  sink: Database | PostgresSqlTag,
  sessionId: string,
): Promise<SessionSummaryRecord | null> {
  if (isSqliteDb(sink)) return getSessionSummarySync(sink, sessionId)
  const clean = sessionId.trim()
  if (!clean) return null
  const res = await sink`
    SELECT session_id, summarized_up_to_turn_id, summary_markdown, created_at, updated_at
    FROM session_summaries
    WHERE session_id = ${clean}
    LIMIT 1;
  `
  if (!Array.isArray(res) || res.length === 0) return null
  const first = res[0] as Record<string, unknown> | undefined
  if (!first || typeof first.summary_markdown !== "string") return null
  return {
    sessionId: String(first.session_id ?? clean),
    summarizedUpToTurnId: Number(first.summarized_up_to_turn_id ?? 0),
    summaryMarkdown: first.summary_markdown,
    ...(typeof first.created_at === "string" ? { createdAt: first.created_at } : {}),
    ...(typeof first.updated_at === "string" ? { updatedAt: first.updated_at } : {}),
  }
}

export interface ColdTurnSummaryInput {
  id: number
  role: "user" | "assistant" | "tool"
  content: string
  toolName?: string
}

export type ColdSummarizerFn = (
  coldMessages: readonly ColdTurnSummaryInput[],
  priorSummary?: string,
  model?: string,
) => Promise<string>

/**
 * Deterministic structured Markdown fold used when no external LLM summarizer is configured or reachable,
 * preserving user intents, assistant decisions, and tool names without stack traces or raw payloads.
 */
export function buildDeterministicColdSummary(
  coldMessages: readonly ColdTurnSummaryInput[],
  priorSummary?: string,
  maxChars = 3_200,
): string {
  const bullets: string[] = []
  if (priorSummary?.trim()) {
    const cleanedPrior = priorSummary.replace(/^###\s+Cold Session Summary\s*/i, "").trim()
    if (cleanedPrior) bullets.push(cleanedPrior)
  }
  for (const m of coldMessages) {
    if (m.role === "tool") {
      bullets.push(`- Tool \`${m.toolName || "tool"}\` executed (${m.content.length} chars).`)
      continue
    }
    const oneLine = m.content.replace(/\s+/g, " ").trim().slice(0, 180)
    if (!oneLine) continue
    const label = m.role === "user" ? "User" : "Assistant"
    bullets.push(`- **${label} (turn ${m.id}):** ${oneLine}`)
  }
  const joined = bullets.join("\n")
  const clipped = joined.length > maxChars ? `…${joined.slice(joined.length - maxChars + 1)}` : joined
  return clipped
}

/**
 * Fold newly aged Cold Window messages (`id > summarizedUpToTurnId`) into `session_summaries`.
 */
export async function foldColdSessionSummary(opts: {
  sessionId: string
  coldMessages: readonly ColdTurnSummaryInput[]
  sink?: TelemetrySink
  summarizer?: ColdSummarizerFn
  model?: string
}): Promise<SessionSummaryRecord | null> {
  const sink = opts.sink ?? defaultDb
  const existing = await getSessionSummary(sink, opts.sessionId)
  const cursor = existing?.summarizedUpToTurnId ?? -1
  const unsummarized = opts.coldMessages.filter((m) => m.id > cursor)
  if (unsummarized.length === 0) return existing

  const maxTurnId = unsummarized.reduce((max, m) => Math.max(max, m.id), cursor)
  const model = opts.model ?? DEFAULT_COLD_SUMMARIZER_MODEL
  let summaryMarkdown: string
  if (opts.summarizer) {
    try {
      summaryMarkdown = (await opts.summarizer(unsummarized, existing?.summaryMarkdown, model)).trim()
    } catch {
      summaryMarkdown = buildDeterministicColdSummary(unsummarized, existing?.summaryMarkdown)
    }
  } else {
    summaryMarkdown = buildDeterministicColdSummary(unsummarized, existing?.summaryMarkdown)
  }

  await upsertSessionSummary(sink, {
    sessionId: opts.sessionId,
    summarizedUpToTurnId: maxTurnId,
    summaryMarkdown,
  })
  return {
    sessionId: opts.sessionId,
    summarizedUpToTurnId: maxTurnId,
    summaryMarkdown,
  }
}
