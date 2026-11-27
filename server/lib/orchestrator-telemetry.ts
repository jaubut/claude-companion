import type { Database } from "bun:sqlite"
import { db as defaultDb } from "./orchestrator-db"

export interface TurnMetricRecord {
  turnId: string
  sessionId: string
  routeTier: string
  modelId: string
  thinkingLevel: string
  injectedSkillCount: number
  promptTokens: number
  cachedPromptTokens: number
  ttftMs: number
  totalLatencyMs: number
  toolCallCount: number
  toolErrorCount: number
}

export interface StoredTurnMetricRow extends TurnMetricRecord {
  createdAt: string
}

/** Tagged-template SQL client signature compatible with `postgres.js` and `Bun.SQL`. */
export type PostgresSqlTag = (strings: TemplateStringsArray, ...values: readonly (string | number)[]) => PromiseLike<unknown>

export type TelemetrySink = PostgresSqlTag | Database

const VALID_GEMINI4_THINKING_LEVELS = new Set(["low", "medium", "high", "xhigh"])

export function isGemini4Model(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase()
  return /(?:^|\/)gemini[- ]4\b/.test(lower) || lower.includes("gemini-pro-orchestrator")
}

/**
 * Normalize thinking level for telemetry and Gemini 4 safety:
 * Gemini 4 never accepts `thinking_level: "minimal"` (clamped to `"low"`).
 */
export function sanitizeThinkingLevel(modelId: string, rawLevel?: string | null): string {
  const cleaned = rawLevel?.trim().toLowerCase() ?? ""
  if (isGemini4Model(modelId)) {
    if (cleaned === "minimal" || !cleaned) {
      const m = /-(xhigh|high|medium|low)$/i.exec(modelId.trim()) ?? /\((xhigh|high|medium|low)\)$/i.exec(modelId.trim())
      const inferred = m?.[1]?.toLowerCase() ?? "low"
      return VALID_GEMINI4_THINKING_LEVELS.has(inferred) ? inferred : "low"
    }
    return VALID_GEMINI4_THINKING_LEVELS.has(cleaned) ? cleaned : "low"
  }
  if (cleaned) return cleaned
  const suffix = /-(xhigh|high|medium|low)$/i.exec(modelId.trim())?.[1]?.toLowerCase()
  return suffix ?? "medium"
}

export function ensureTurnMetricsTable(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS orchestrator_turn_metrics (
      turn_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      route_tier TEXT NOT NULL,
      model_id TEXT NOT NULL,
      thinking_level TEXT NOT NULL,
      injected_skill_count INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL,
      cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
      ttft_ms INTEGER NOT NULL,
      total_latency_ms INTEGER NOT NULL,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_error_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_session ON orchestrator_turn_metrics(session_id);
  `)
}

ensureTurnMetricsTable(defaultDb)

function clampNonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function normalizeRecord(r: TurnMetricRecord): TurnMetricRecord {
  const modelId = r.modelId.trim().slice(0, 64) || "unknown"
  return {
    turnId: r.turnId.trim().slice(0, 64),
    sessionId: r.sessionId.trim().slice(0, 128),
    routeTier: r.routeTier.trim().slice(0, 32) || "baseline",
    modelId,
    thinkingLevel: sanitizeThinkingLevel(modelId, r.thinkingLevel).slice(0, 16),
    injectedSkillCount: clampNonNegInt(r.injectedSkillCount),
    promptTokens: clampNonNegInt(r.promptTokens),
    cachedPromptTokens: clampNonNegInt(r.cachedPromptTokens),
    ttftMs: clampNonNegInt(r.ttftMs),
    totalLatencyMs: clampNonNegInt(r.totalLatencyMs),
    toolCallCount: clampNonNegInt(r.toolCallCount),
    toolErrorCount: clampNonNegInt(r.toolErrorCount),
  }
}

function isSqliteDb(sink: TelemetrySink): sink is Database {
  return typeof sink === "object" && sink !== null && "query" in sink && typeof sink.query === "function"
}

/**
 * Persist turn metrics to either a PostgreSQL tagged-template `sql` client
 * (`orchestrator_turn_metrics` with `thinking_level`) or Companion's local `bun:sqlite` `Database`.
 */
export async function logTurnMetrics(sink: TelemetrySink, rawRecord: TurnMetricRecord): Promise<void> {
  const record = normalizeRecord(rawRecord)
  if (!record.turnId || !record.sessionId) return

  if (isSqliteDb(sink)) {
    ensureTurnMetricsTable(sink)
    sink.query(
      `INSERT INTO orchestrator_turn_metrics (
        turn_id, session_id, route_tier, model_id, thinking_level,
        injected_skill_count, prompt_tokens, cached_prompt_tokens,
        ttft_ms, total_latency_ms, tool_call_count, tool_error_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET
        route_tier = excluded.route_tier,
        model_id = excluded.model_id,
        thinking_level = excluded.thinking_level,
        injected_skill_count = excluded.injected_skill_count,
        prompt_tokens = excluded.prompt_tokens,
        cached_prompt_tokens = excluded.cached_prompt_tokens,
        ttft_ms = excluded.ttft_ms,
        total_latency_ms = excluded.total_latency_ms,
        tool_call_count = excluded.tool_call_count,
        tool_error_count = excluded.tool_error_count`,
    ).run(
      record.turnId,
      record.sessionId,
      record.routeTier,
      record.modelId,
      record.thinkingLevel,
      record.injectedSkillCount,
      record.promptTokens,
      record.cachedPromptTokens,
      record.ttftMs,
      record.totalLatencyMs,
      record.toolCallCount,
      record.toolErrorCount,
    )
    return
  }

  await sink`
    INSERT INTO orchestrator_turn_metrics (
      turn_id, session_id, route_tier, model_id, thinking_level,
      injected_skill_count, prompt_tokens, cached_prompt_tokens,
      ttft_ms, total_latency_ms, tool_call_count, tool_error_count
    ) VALUES (
      ${record.turnId}, ${record.sessionId}, ${record.routeTier}, ${record.modelId},
      ${record.thinkingLevel}, ${record.injectedSkillCount}, ${record.promptTokens},
      ${record.cachedPromptTokens}, ${record.ttftMs}, ${record.totalLatencyMs},
      ${record.toolCallCount}, ${record.toolErrorCount}
    )
    ON CONFLICT (turn_id) DO UPDATE SET
      route_tier = EXCLUDED.route_tier,
      model_id = EXCLUDED.model_id,
      thinking_level = EXCLUDED.thinking_level,
      injected_skill_count = EXCLUDED.injected_skill_count,
      prompt_tokens = EXCLUDED.prompt_tokens,
      cached_prompt_tokens = EXCLUDED.cached_prompt_tokens,
      ttft_ms = EXCLUDED.ttft_ms,
      total_latency_ms = EXCLUDED.total_latency_ms,
      tool_call_count = EXCLUDED.tool_call_count,
      tool_error_count = EXCLUDED.tool_error_count;
  `
}

let pgClientUrl = ""
let pgClient: PostgresSqlTag | null = null

function resolveEnvPgClient(env: Record<string, string | undefined> = process.env): PostgresSqlTag | null {
  const url = env.DATABASE_URL?.trim() ?? ""
  if (!url) return null
  if (pgClient && pgClientUrl === url) return pgClient
  const bunSqlCtor = (Bun as unknown as { SQL?: new (conn: string) => PostgresSqlTag }).SQL
  if (typeof bunSqlCtor !== "function") return null
  try {
    pgClient = new bunSqlCtor(url)
    pgClientUrl = url
    return pgClient
  } catch {
    return null
  }
}

/** Record metrics into Companion's local SQLite store and (when `DATABASE_URL` is configured) PostgreSQL. */
export async function recordTurnMetrics(
  record: TurnMetricRecord,
  opts: { sqlite?: Database; pg?: PostgresSqlTag | null; env?: Record<string, string | undefined> } = {},
): Promise<void> {
  await logTurnMetrics(opts.sqlite ?? defaultDb, record)
  const pg = opts.pg !== undefined ? opts.pg : resolveEnvPgClient(opts.env)
  if (pg) {
    try {
      await logTurnMetrics(pg, record)
    } catch {
      /* best-effort Postgres mirror: never fail an interactive turn */
    }
  }
}

interface RawMetricRow {
  turn_id: string
  session_id: string
  route_tier: string
  model_id: string
  thinking_level: string
  injected_skill_count: number
  prompt_tokens: number
  cached_prompt_tokens: number
  ttft_ms: number
  total_latency_ms: number
  tool_call_count: number
  tool_error_count: number
  created_at: string
}

export function readTurnMetrics(sqlite: Database = defaultDb, sessionId?: string): StoredTurnMetricRow[] {
  ensureTurnMetricsTable(sqlite)
  const rows = (sessionId
    ? sqlite.query("SELECT * FROM orchestrator_turn_metrics WHERE session_id = ? ORDER BY rowid ASC").all(sessionId)
    : sqlite.query("SELECT * FROM orchestrator_turn_metrics ORDER BY rowid ASC").all()) as RawMetricRow[]
  return rows.map((r) => ({
    turnId: r.turn_id,
    sessionId: r.session_id,
    routeTier: r.route_tier,
    modelId: r.model_id,
    thinkingLevel: r.thinking_level,
    injectedSkillCount: Number(r.injected_skill_count),
    promptTokens: Number(r.prompt_tokens),
    cachedPromptTokens: Number(r.cached_prompt_tokens),
    ttftMs: Number(r.ttft_ms),
    totalLatencyMs: Number(r.total_latency_ms),
    toolCallCount: Number(r.tool_call_count),
    toolErrorCount: Number(r.tool_error_count),
    createdAt: r.created_at,
  }))
}

export interface ExtractedUsageMetrics {
  promptTokens?: number
  cachedPromptTokens?: number
  outputTokens?: number
}

function posInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined
}

/**
 * Extract prompt token and implicit-cache hit counts from Gemini Interactions API (`usage.total_cached_tokens`),
 * Gemini `generateContent` (`usageMetadata.cachedContentTokenCount`), `agy`, or `claude` stream-json events.
 */
export function extractUsageMetrics(raw: unknown): ExtractedUsageMetrics | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const root = raw as Record<string, unknown>
  const result = root.result && typeof root.result === "object" && !Array.isArray(root.result) ? (root.result as Record<string, unknown>) : null
  const message = root.message && typeof root.message === "object" && !Array.isArray(root.message) ? (root.message as Record<string, unknown>) : null

  const usageCandidates = [root.usage, root.usageMetadata, result?.usage, result?.usageMetadata, message?.usage]
    .filter((u): u is Record<string, unknown> => !!u && typeof u === "object" && !Array.isArray(u))

  if (usageCandidates.length === 0) return null

  const out: ExtractedUsageMetrics = {}
  for (const u of usageCandidates) {
    const cached = posInt(u.total_cached_tokens)
      ?? posInt(u.cachedContentTokenCount)
      ?? posInt(u.cached_prompt_tokens)
      ?? posInt(u.cached_tokens)
      ?? posInt(u.cache_read_input_tokens)
    if (cached !== undefined && out.cachedPromptTokens === undefined) out.cachedPromptTokens = cached

    const baseInput = posInt(u.promptTokenCount)
      ?? posInt(u.total_input_tokens)
      ?? posInt(u.prompt_tokens)
      ?? posInt(u.input_tokens)
    if (baseInput !== undefined && out.promptTokens === undefined) {
      // Anthropic reports `input_tokens` excluding `cache_read_input_tokens`; Gemini `promptTokenCount` / `total_input_tokens` already includes cached tokens.
      const cacheRead = posInt(u.cache_read_input_tokens) ?? 0
      const cacheCreate = posInt(u.cache_creation_input_tokens) ?? 0
      out.promptTokens = u.input_tokens !== undefined && u.promptTokenCount === undefined && u.total_input_tokens === undefined
        ? baseInput + cacheRead + cacheCreate
        : baseInput
    }

    const output = posInt(u.candidatesTokenCount) ?? posInt(u.total_output_tokens) ?? posInt(u.output_tokens)
    if (output !== undefined && out.outputTokens === undefined) out.outputTokens = output
  }

  return Object.keys(out).length > 0 ? out : null
}
