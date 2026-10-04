import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// TypeSafe "System One" (Jev) client for the server: typed questions about a
// state, calibrated answers in ~200 ms, no text generation. Direct HTTP (no
// SDK). Never throws: every failure is a `{ ok: false, error }` so the caller
// falls back to the old path. Docs: docs.typesafe.ai/api.md.

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const JEV_MODEL = "jev-latest"
export const JEV_TIMEOUT_MS = 2_000

export type ChoiceQuestion = { type: "choice"; instructions: unknown; criteria: Record<string, string | null> }
export type NoulQuestion = { type: "noul"; instructions: unknown; criteria?: { true?: string; false?: string } }
export type JevQuestion = ChoiceQuestion | NoulQuestion

export interface ChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
export interface NoulAnswer { type: "noul"; noul: number }
export type JevAnswer = ChoiceAnswer | NoulAnswer

export type JevOutcome =
  | { ok: true; model: string; answers: Record<string, JevAnswer>; latencyMs: number }
  | { ok: false; error: string; latencyMs: number }

export interface JevOpts {
  key?: string | null
  timeoutMs?: number
  endpoint?: string
  fetch?: typeof fetch
  now?: () => number
}

/**
 * Key sources, first hit wins: the vault store (secrets.env — what receipt-jev
 * reads, rotated by /key), its secrets.mirror sibling (the Mac's copy), the
 * process env, then ~/.config/tls-agent/env. Vault first on purpose: on
 * 2026-10-04 the Mac's tls-agent/env carried a stale key (HTTP 401) while the
 * mirror's worked, and the Mac launchd service has no tls-agent env at all.
 */
export function jevKeySources(env: Record<string, string | undefined>): string[] {
  const home = env.HOME || homedir()
  const vault = env.TLS_SECRETS_FILE || join(home, ".config", "tls-agent", "secrets.env")
  return [vault, join(dirname(vault), "secrets.mirror"), "$env", env.COMPANION_JEV_ENV_FILE || join(home, ".config", "tls-agent", "env")]
}

/** A `NAME=value` line's value: `export ` prefix, surrounding quotes and CR stripped. */
export function envLineValue(text: string, name: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim().replace(/^export\s+/, "")
    if (!line.startsWith(`${name}=`)) continue
    const v = line.slice(name.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2").trim()
    return v || null
  }
  return null
}

const unquote = (v: string | undefined): string | null => v?.replace(/\r/g, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim() || null

/** TYPESAFE_API_KEY from the first source that has one (jevKeySources), or null. */
export function jevKey(
  env: Record<string, string | undefined> = process.env,
  read: (p: string) => string | null = (p) => { try { return readFileSync(p, "utf8") } catch { return null } },
): string | null {
  for (const src of jevKeySources(env)) {
    const key = src === "$env" ? unquote(env.TYPESAFE_API_KEY) : (() => { const t = read(src); return t ? envLineValue(t, "TYPESAFE_API_KEY") : null })()
    if (key) return key
  }
  return null
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

function parseAnswer(v: unknown): JevAnswer | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  if (o.type === "noul") {
    const p = num(o.noul)
    return p === null ? null : { type: "noul", noul: p }
  }
  if (o.type === "choice" && typeof o.choice === "string") {
    const probabilities: Record<string, number> = {}
    if (o.probabilities && typeof o.probabilities === "object") {
      for (const [k, p] of Object.entries(o.probabilities as Record<string, unknown>)) {
        const n = num(p)
        if (n !== null) probabilities[k] = n
      }
    }
    const confidence = num(o.confidence) ?? probabilities[o.choice] ?? 0
    return { type: "choice", choice: o.choice, probabilities, confidence: Math.min(1, Math.max(0, confidence)) }
  }
  return null
}

/** Response body → answers; null when the shape is wrong. Unknown answer types are skipped. */
export function parseJevResponse(body: unknown): { model: string; answers: Record<string, JevAnswer> } | null {
  if (!body || typeof body !== "object") return null
  const o = body as Record<string, unknown>
  if (!o.answers || typeof o.answers !== "object") return null
  const answers: Record<string, JevAnswer> = {}
  for (const [k, v] of Object.entries(o.answers as Record<string, unknown>)) {
    const a = parseAnswer(v)
    if (a) answers[k] = a
  }
  return { model: typeof o.model === "string" ? o.model : JEV_MODEL, answers }
}

/** One System One evaluation. Missing key, HTTP error, timeout or bad body → `{ ok: false }`. */
export async function systemOne(state: unknown, questions: Record<string, JevQuestion>, opts: JevOpts = {}): Promise<JevOutcome> {
  const now = opts.now ?? Date.now
  const t0 = now()
  const fail = (error: string): JevOutcome => ({ ok: false, error, latencyMs: now() - t0 })
  const key = opts.key === undefined ? jevKey() : opts.key
  if (!key) return fail("no_key")
  const doFetch = opts.fetch ?? fetch
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  // Raced, not just aborted: the deadline holds even if a body read ignores the signal.
  const deadline = new Promise<JevOutcome>((resolve) => {
    timer = setTimeout(() => { ctl.abort(); resolve(fail("timeout")) }, opts.timeoutMs ?? JEV_TIMEOUT_MS)
  })
  const call = (async (): Promise<JevOutcome> => {
    try {
      const res = await doFetch(opts.endpoint ?? process.env.TYPESAFE_BASE_URL ?? JEV_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: JEV_MODEL, questions }),
        signal: ctl.signal,
      })
      if (!res.ok) return fail(`http_${res.status}`)
      const parsed = parseJevResponse(await res.json())
      return parsed ? { ok: true, ...parsed, latencyMs: now() - t0 } : fail("bad_body")
    } catch (err) {
      return fail(ctl.signal.aborted ? "timeout" : `network: ${(err as Error)?.name ?? "error"}`)
    }
  })()
  try {
    return await Promise.race([call, deadline])
  } finally {
    clearTimeout(timer)
  }
}
