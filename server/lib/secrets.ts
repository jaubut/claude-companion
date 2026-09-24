import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomBytes } from "node:crypto"

// Secret store for POST /api/secret — upserts NAME='value' into the agent env
// file (~/.config/tls-agent/env) so a token never passes through the chat,
// tmux, the transcript or the log. Only NAMES leave this module. Later: swap
// the file backend for the Phase vault behind the same four functions.
//
// Line format written: NAME='value' (or `export NAME='value'` when the file
// already uses export). Single quotes are literal in sh, systemd
// EnvironmentFile and lib/dotenv.ts alike, so `=` and spaces are safe; the
// only values refused are ones that could break out of the quotes or the line.

export const DEFAULT_ENV_PATH = join(homedir(), ".config", "tls-agent", "env")
// Sidecar with per-name updatedAt — the env file itself has no timestamps.
// Names + ISO dates only, never values.
export const DEFAULT_META_PATH = join(homedir(), ".claude-companion", "secret-meta.json")

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const MAX_VALUE = 8192

export function isValidSecretName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name)
}

export function isValidSecretValue(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_VALUE
    && !/['\\\r\n\0]/.test(value)
}

export interface SecretPaths { envPath: string; metaPath: string }
export interface SecretInfo { name: string; updatedAt: string | null }

const assignRe = (name: string) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`)
const ANY_ASSIGN = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

function readLines(path: string): string[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, "utf8")
  const lines = raw.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

// temp file in the same dir + rename = readers never see a half-written file.
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function readMeta(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

function writeMeta(path: string, meta: Record<string, string>): void {
  atomicWrite(path, JSON.stringify(meta, null, 2) + "\n")
}

/** Caller validates name + value first. Other lines are kept byte-for-byte. */
export function upsertSecret(paths: SecretPaths, name: string, value: string, now = new Date()): "added" | "updated" {
  const lines = readLines(paths.envPath)
  const re = assignRe(name)
  const useExport = lines.some((l) => /^\s*export\s+/.test(l) && ANY_ASSIGN.test(l))
  let action: "added" | "updated" = "added"
  const out: string[] = []
  for (const line of lines) {
    const m = re.exec(line)
    if (!m) { out.push(line); continue }
    // First match is replaced in place; later duplicates are dropped so a
    // `source` can't let a stale copy win.
    if (action === "added") out.push(`${m[1] ? "export " : ""}${name}='${value}'`)
    action = "updated"
  }
  if (action === "added") out.push(`${useExport ? "export " : ""}${name}='${value}'`)
  atomicWrite(paths.envPath, out.join("\n") + "\n")

  const meta = readMeta(paths.metaPath)
  meta[name] = now.toISOString()
  writeMeta(paths.metaPath, meta)
  return action
}

export function deleteSecret(paths: SecretPaths, name: string): boolean {
  const lines = readLines(paths.envPath)
  const re = assignRe(name)
  const kept = lines.filter((l) => !re.test(l))
  if (kept.length === lines.length) return false
  atomicWrite(paths.envPath, kept.length ? kept.join("\n") + "\n" : "")
  const meta = readMeta(paths.metaPath)
  delete meta[name]
  writeMeta(paths.metaPath, meta)
  return true
}

export function listSecrets(paths: SecretPaths): SecretInfo[] {
  const meta = readMeta(paths.metaPath)
  const names = new Set<string>()
  for (const line of readLines(paths.envPath)) {
    const m = ANY_ASSIGN.exec(line)
    if (m && !line.trim().startsWith("#")) names.add(m[2]!)
  }
  return [...names].sort().map((name) => ({ name, updatedAt: meta[name] ?? null }))
}

// ── Transport gate ──
// The server listens on plain http on 0.0.0.0. A secret may only arrive over
// an encrypted hop: loopback (Tailscale Serve terminates HTTPS and proxies to
// 127.0.0.1) or a tailnet peer (100.64.0.0/10, fd7a:115c:a1e0::/48 — WireGuard).
// A plain-LAN client, a forwarded `http` proto, or a plain-http non-local
// Origin is refused.
export function isTrustedSecretTransport(peerIp: string | null | undefined, req: Request): boolean {
  if (!peerIp || !isLoopbackOrTailnet(peerIp)) return false
  if ((req.headers.get("x-forwarded-proto") ?? "").toLowerCase() === "http") return false
  const origin = req.headers.get("origin")
  if (origin && origin !== "null") {
    try {
      const o = new URL(origin)
      if (o.protocol === "http:" && !isLoopbackOrTailnet(o.hostname.replace(/^\[|\]$/g, ""))) return false
    } catch {
      return false
    }
  }
  return true
}

function isLoopbackOrTailnet(host: string): boolean {
  const ip = host.toLowerCase().replace(/^::ffff:/, "")
  if (ip === "localhost" || ip === "::1" || /^127\./.test(ip)) return true
  const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip)
  if (m) { const b = Number(m[1]); return b >= 64 && b <= 127 }
  return ip.startsWith("fd7a:115c:a1e0:")
}

// ── Rate limit ──
// ponytail: one global fixed window — a single-user server; per-peer buckets
// if it ever serves more than one phone.
export function createRateLimiter(max: number, windowMs: number, now: () => number = Date.now) {
  let hits: number[] = []
  return (): boolean => {
    const t = now()
    hits = hits.filter((h) => t - h < windowMs)
    if (hits.length >= max) return false
    hits.push(t)
    return true
  }
}
