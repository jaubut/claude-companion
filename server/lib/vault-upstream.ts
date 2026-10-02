import { existsSync, statSync } from "node:fs"
import { hostname } from "node:os"
import { isAbsolute } from "node:path"
import { getAuthToken } from "./auth"
import { companionLog } from "./log"

// Upstream vault: this Companion server uses ANOTHER Companion server's vault
// (its /api/vault REST API) as the single source of truth instead of a local
// secrets.env. Opt-in by env:
//   COMPANION_VAULT_UPSTREAM  base URL — https://…, or http://127.0.0.1|localhost
//   COMPANION_VAULT_PULL_CMD  absolute path of an executable, run with no shell
//                             and no args after every successful upstream write
//                             (mirror refresh). Fire-and-forget, 30 s timeout,
//                             only its exit code is logged.
// Invalid values are ignored with one log line. Unset → this module is inert.
//
// The local guards (network gate, header-only bearer, write/read rate limits)
// run on THIS server before anything is forwarded; the upstream re-runs its
// own. Auth to the upstream is this server's own bearer, header only. The
// value travels only in the POST body. No log line here ever carries a value,
// the URL's query, the token or the upstream's response body.

export const UPSTREAM_TIMEOUT_MS = 10_000
const PULL_TIMEOUT_MS = 30_000
/** Set on forwarded requests; a server in upstream mode refuses one (loop). */
export const HOP_HEADER = "x-companion-vault-hop"

export interface UpstreamConfig { base: string; host: string }
export interface UpstreamReply { status: number; text: string; retryAfter: string | null; json: Record<string, unknown> | null }

const LOCAL_HTTP = new Set(["127.0.0.1", "localhost", "[::1]"])
const warned = new Set<string>()

function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return
  warned.add(key)
  companionLog(msg)
}

/** Parse + validate a base URL. null = invalid. */
export function parseUpstream(raw: string): UpstreamConfig | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const okScheme = u.protocol === "https:" || (u.protocol === "http:" && LOCAL_HTTP.has(u.hostname))
  if (!okScheme || u.username || u.password || u.search || u.hash) return null
  return { base: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, host: u.host }
}

/** The configured upstream, or null (unset or invalid → local store). */
export function vaultUpstream(): UpstreamConfig | null {
  const raw = process.env.COMPANION_VAULT_UPSTREAM?.trim()
  if (!raw) return null
  const cfg = parseUpstream(raw)
  if (!cfg) warnOnce(`up:${raw}`, "vault upstream ignored: COMPANION_VAULT_UPSTREAM must be https:// or http://127.0.0.1|localhost, no credentials/query")
  return cfg
}

/** The configured pull command, or null (unset or invalid). */
export function pullCommand(): string | null {
  const raw = process.env.COMPANION_VAULT_PULL_CMD?.trim()
  if (!raw) return null
  const ok = isAbsolute(raw) && existsSync(raw) && statSync(raw).isFile() && (statSync(raw).mode & 0o111) !== 0
  if (!ok) warnOnce(`pull:${raw}`, "vault pull cmd ignored: COMPANION_VAULT_PULL_CMD must be the absolute path of an executable file")
  return ok ? raw : null
}

/** `<device> via <hostname>`, kept within the upstream's 64-char cut. */
export function forwardedDevice(device: string): string {
  const suffix = ` via ${hostname()}`.replace(/[^\x20-\x7e]/g, "").slice(0, 40)
  const clean = (device || "unknown").replace(/[^\x20-\x7e]/g, "")
  return clean.slice(0, 64 - suffix.length) + suffix
}

const inflight = new Set<Promise<void>>()

/** Test seam: resolves once every pull started so far has exited. */
export async function pendingPulls(): Promise<void> {
  await Promise.all([...inflight])
}

/** Run the pull command (no shell, no args). Never throws, never logs output. */
export function runPull(): void {
  const cmd = pullCommand()
  if (!cmd) return
  const run = (async () => {
    try {
      const proc = Bun.spawn([cmd], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
      const timer = setTimeout(() => proc.kill(), PULL_TIMEOUT_MS)
      const code = await proc.exited
      clearTimeout(timer)
      companionLog(`vault pull exit=${code}`)
    } catch {
      companionLog("vault pull failed to start")
    }
  })()
  inflight.add(run)
  void run.finally(() => inflight.delete(run))
}

const UNREACHABLE = JSON.stringify({ ok: false, error: "upstream_unreachable", message: "Coffre distant injoignable — rien n'a changé." })

/**
 * Forward one vault call to the upstream. `path` is `/api/vault` or
 * `/api/vault/NAME` (NAME already validated). Network error, timeout or a
 * redirect → 502 upstream_unreachable. A 2xx write triggers the pull command.
 */
export async function forwardVault(cfg: UpstreamConfig, method: string, path: string, device: string, body?: Record<string, unknown>): Promise<UpstreamReply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${getAuthToken()}`,
    "x-companion-device": forwardedDevice(device),
    [HOP_HEADER]: "1",
  }
  if (body) headers["content-type"] = "application/json"
  let res: Response
  try {
    res = await fetch(cfg.base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      redirect: "manual", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (e) {
    companionLog(`vault upstream ${method} unreachable (${e instanceof Error ? e.name : "error"})`)
    return { status: 502, text: UNREACHABLE, retryAfter: null, json: JSON.parse(UNREACHABLE) }
  }
  if (res.status >= 300 && res.status < 400) {
    void res.body?.cancel()
    companionLog(`vault upstream ${method} refused redirect ${res.status}`)
    return { status: 502, text: UNREACHABLE, retryAfter: null, json: JSON.parse(UNREACHABLE) }
  }
  const text = await res.text().catch(() => "")
  let json: Record<string, unknown> | null = null
  try {
    const v = JSON.parse(text) as unknown
    if (v && typeof v === "object" && !Array.isArray(v)) json = v as Record<string, unknown>
  } catch { /* plain-text reply (e.g. the upstream's 401) */ }
  companionLog(`vault upstream ${method} → ${res.status}`)
  if (method !== "GET" && res.ok) runPull()
  return { status: res.status, text, retryAfter: res.headers.get("retry-after"), json }
}
