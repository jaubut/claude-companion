import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { writeLimiter } from "./vault-guard"

// Companion Vault: list / add / rotate / change hosts / delete the agent
// secrets in ~/.config/tls-agent/secrets.env — values are WRITE-ONLY.
//
// Store format and masking are owned by ~/.claude/tools/tls-secrets.py:
// one line per key, `NAME='value'  # host [host ...] [scripts|plain]`. Every
// write here touches one line only (every other line and comment stays
// byte-identical), is atomic + 0600, then runs `tls-secrets.py sync` so the
// key is masked in the Claude sandbox. If sync fails the store is rolled
// back: an unmasked key would be exported in clear into every new session.
// Each successful write appends {ts, action, name, hosts, device_claimed,
// transport, peer} to vault-audit.jsonl — never the value. `device_claimed`
// is the client's own x-companion-device header (spoofable, informative only);
// transport + peer come from the server's view of the connection. No value is
// ever returned, logged or broadcast by this module.
//
// No sync tool on this host (tls-secrets.py absent) → every mutation is a 501
// `vault_unavailable` before secrets.env is read or written; listing still works.
//
// The `/key NAME value [--hosts a,b]` chat command (session inject, WS input,
// orchestrator) goes through the same upsert: every chat entry point calls
// `handleKeyCommand` FIRST so the value never reaches a pane or transcript.

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
// example.com, *.example.com, optional :port.
const HOST_RE = /^(\*\.)?([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+(:\d{1,5})?$/
const MAX_HOSTS = 5
// Mirrors tls-secrets.py LINE_RE: 1 = NAME=value (raw), 2 = name, 3 = tags.
const LINE_RE = /^(\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(?:'[^']*'|"[^"]*"|\S*))\s*(?:#\s*(.*))?$/
// Non-host tags tls-secrets.py understands; kept across rotate / host changes.
const FLAGS = new Set(["scripts", "plain"])
const HEADER = "# Agent secrets. NAME='value'  # hosts [scripts]   — see ~/.claude/tools/tls-secrets.py"

export type SyncFn = () => Promise<{ ok: boolean; detail: string }>
export type VaultAction = "created" | "updated" | "hosts" | "deleted"

/** Who asked for a write, as recorded in the audit log. */
export interface AuditOrigin { device_claimed: string; transport: string; peer: string }

export interface VaultEntry { name: string; hosts: string[]; scripts: boolean; updated_at: string | null }
export interface VaultResult {
  ok: boolean
  status: number
  name?: string
  hosts?: string[]
  action?: VaultAction
  error?: string
  message: string
  /** Seconds, set on 429 rate_limited. */
  retry_after?: number
}

// Test seam: tests swap `sync` for a mock instead of spawning python.
export const vaultDeps: { sync: SyncFn } = { sync: runSync }

export function storePath(): string {
  return process.env.TLS_SECRETS_FILE ?? join(homedir(), ".config", "tls-agent", "secrets.env")
}

export function syncToolPath(): string {
  return process.env.TLS_SECRETS_TOOL ?? join(homedir(), ".claude", "tools", "tls-secrets.py")
}

/** Writes are only possible where the masking sync tool exists. */
export function vaultWritable(): boolean {
  return existsSync(syncToolPath())
}

export function auditPath(): string {
  return process.env.TLS_VAULT_AUDIT_FILE ?? join(homedir(), ".config", "tls-agent", "vault-audit.jsonl")
}

// ── Validation (errors never echo the value) ──

export function validName(name: unknown): name is string {
  return typeof name === "string" && NAME_RE.test(name)
}

export function validValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8192 && !/['"\x00-\x1f\x7f]/.test(value)
}

export function validHosts(hosts: unknown): hosts is string[] {
  return Array.isArray(hosts) && hosts.length <= MAX_HOSTS && hosts.every((h) => typeof h === "string" && h.length <= 253 && HOST_RE.test(h))
}

// ── Pure line editing ──

interface Parsed { index: number; raw: string; name: string; tags: string[] }

function parseLines(content: string): { lines: string[]; entries: Parsed[] } {
  const lines = content.split("\n")
  const entries: Parsed[] = []
  lines.forEach((line, index) => {
    const m = LINE_RE.exec(line)
    if (!m || line.trimStart().startsWith("#")) return
    entries.push({ index, raw: m[1]!.trim(), name: m[2]!, tags: (m[3] ?? "").split(/\s+/).filter(Boolean) })
  })
  return { lines, entries }
}

function withTags(assign: string, tags: string[]): string {
  return assign + (tags.length ? `  # ${tags.join(" ")}` : "")
}

/** Names + tags per key, first occurrence wins. Never exposes a value. */
export function listNames(content: string): { name: string; hosts: string[]; scripts: boolean }[] {
  const seen = new Set<string>()
  const out: { name: string; hosts: string[]; scripts: boolean }[] = []
  for (const e of parseLines(content).entries) {
    if (seen.has(e.name)) continue
    seen.add(e.name)
    out.push({ name: e.name, hosts: e.tags.filter((t) => !FLAGS.has(t)), scripts: e.tags.includes("scripts") })
  }
  return out
}

/**
 * Rewrite NAME's line in place: `value` given → new value (flags kept),
 * `value` undefined → value untouched, only hosts change. Later duplicate
 * lines for NAME are dropped. `null` remove → delete. Returns null if NAME
 * is absent and there is nothing to create.
 */
export function editLine(content: string, name: string, change: { value?: string; hosts?: string[]; remove?: boolean }): string | null {
  const { lines, entries } = parseLines(content)
  const own = entries.filter((e) => e.name === name)
  const first = own[0]
  if (!first && (change.remove || change.value === undefined)) return null

  const flags = first ? first.tags.filter((t) => FLAGS.has(t)) : []
  const hosts = change.hosts ?? (first ? first.tags.filter((t) => !FLAGS.has(t)) : [])
  const assign = change.value !== undefined ? `${name}='${change.value}'` : first!.raw
  const line = withTags(assign, [...hosts, ...flags])

  if (!first) {
    const body = content === "" ? [HEADER] : lines.slice(0, content.endsWith("\n") ? -1 : undefined)
    return [...body, line].join("\n") + "\n"
  }
  const drop = new Set(own.slice(1).map((e) => e.index))
  if (change.remove) drop.add(first.index)
  else lines[first.index] = line
  return lines.filter((_, i) => !drop.has(i)).join("\n")
}

// ── IO ──

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function readStore(): string | null {
  const path = storePath()
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

async function runSync(): Promise<{ ok: boolean; detail: string }> {
  const script = syncToolPath()
  if (!existsSync(script)) return { ok: false, detail: "tls-secrets.py introuvable" }
  const proc = Bun.spawn(["python3", script, "sync"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => proc.kill(), 30_000)
  const code = await proc.exited
  clearTimeout(timer)
  const out = (await new Response(code === 0 ? proc.stdout : proc.stderr).text()).trim()
  return { ok: code === 0, detail: out.slice(-200) }
}

function toOrigin(o: string | Partial<AuditOrigin>): AuditOrigin {
  const raw = typeof o === "string" ? { device_claimed: o } : o
  return { device_claimed: raw.device_claimed ?? "unknown", transport: raw.transport ?? "unknown", peer: raw.peer ?? "unknown" }
}

function audit(action: VaultAction, name: string, hosts: string[], origin: AuditOrigin): void {
  const path = auditPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), action, name, hosts, ...origin }) + "\n", { mode: 0o600 })
}

function lastAuditTimes(): Map<string, string> {
  const out = new Map<string, string>()
  const path = auditPath()
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line) as { ts?: unknown; name?: unknown }
      if (typeof e.name === "string" && typeof e.ts === "string") out.set(e.name, e.ts)
    } catch { /* skip torn / blank lines */ }
  }
  return out
}

// ponytail: one global write lock — the store is one small file edited by hand-rare writes.
let lock: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn)
  lock = run.catch(() => undefined)
  return run
}

// Write, sync, roll back on sync failure, audit on success.
async function commit(before: string | null, after: string, action: VaultAction, name: string, hosts: string[], origin: AuditOrigin, secret?: string): Promise<VaultResult> {
  const path = storePath()
  atomicWrite(path, after)
  const synced = await vaultDeps.sync().catch((e: unknown) => ({ ok: false, detail: String(e) }))
  if (!synced.ok) {
    // No file before = remove it: an empty secrets.env would make
    // tls-agent-env switch to it and drop every other key.
    if (before === null) unlinkSync(path)
    else atomicWrite(path, before)
    const detail = secret ? synced.detail.split(secret).join("•••") : synced.detail
    return { ok: false, status: 500, name, error: "sync_failed", message: `${name} NON enregistré — masquage échoué (${detail}). Rien n'a changé.` }
  }
  audit(action, name, hosts, origin)
  return { ok: true, status: 200, name, hosts, action, message: messageFor(action, name, hosts) }
}

function messageFor(action: VaultAction, name: string, hosts: string[]): string {
  if (action === "deleted") return `${name} supprimé.`
  const where = hosts.length ? hosts.join(" ") : "aucun hôte: jamais envoyé"
  return `🔑 ${name} ${action === "hosts" ? "→" : "enregistré"} (${where}). Actif à la prochaine session.`
}

function bad(error: string, message: string, status = 400): VaultResult {
  return { ok: false, status, error, message }
}

const UNAVAILABLE = (): VaultResult => bad("vault_unavailable", "Coffre en lecture seule sur cet hôte (tls-secrets.py absent) — rien n'a changé.", 501)

// ── Vault operations ──

export function listSecrets(): VaultEntry[] {
  const times = lastAuditTimes()
  return listNames(readStore() ?? "").map((e) => ({ ...e, updated_at: times.get(e.name) ?? null }))
}

/** Create or replace a value (rotate). */
export function upsertSecret(input: { name?: unknown; value?: unknown; hosts?: unknown }, origin: string | Partial<AuditOrigin> = "unknown"): Promise<VaultResult> {
  if (!vaultWritable()) return Promise.resolve(UNAVAILABLE())
  const hosts = input.hosts ?? []
  if (!validName(input.name)) return Promise.resolve(bad("bad_name", "NOM en MAJUSCULES_ET_CHIFFRES (2–64)"))
  if (!validValue(input.value)) return Promise.resolve(bad("bad_value", `valeur de ${input.name} refusée (vide, guillemet ou retour de ligne)`))
  if (!validHosts(hosts)) return Promise.resolve(bad("bad_hosts", `hôtes invalides (max ${MAX_HOSTS}, ex. api.example.com ou *.example.com)`))
  const { name, value } = input
  return serialized(async () => {
    const before = readStore()
    const existed = listNames(before ?? "").some((e) => e.name === name)
    const after = editLine(before ?? "", name, { value, hosts })!
    return commit(before, after, existed ? "updated" : "created", name, hosts, toOrigin(origin), value)
  })
}

/** Change where the value may be injected; value untouched. */
export function setSecretHosts(name: string, hosts: unknown, origin: string | Partial<AuditOrigin> = "unknown"): Promise<VaultResult> {
  if (!vaultWritable()) return Promise.resolve(UNAVAILABLE())
  if (!validName(name)) return Promise.resolve(bad("bad_name", "NOM en MAJUSCULES_ET_CHIFFRES (2–64)"))
  if (!validHosts(hosts)) return Promise.resolve(bad("bad_hosts", `hôtes invalides (max ${MAX_HOSTS}, ex. api.example.com ou *.example.com)`))
  return serialized(async () => {
    const before = readStore()
    const after = editLine(before ?? "", name, { hosts })
    if (after === null) return bad("not_found", `${name} introuvable`, 404)
    return commit(before, after, "hosts", name, hosts, toOrigin(origin))
  })
}

export function deleteSecret(name: string, origin: string | Partial<AuditOrigin> = "unknown"): Promise<VaultResult> {
  if (!vaultWritable()) return Promise.resolve(UNAVAILABLE())
  if (!validName(name)) return Promise.resolve(bad("bad_name", "NOM en MAJUSCULES_ET_CHIFFRES (2–64)"))
  return serialized(async () => {
    const before = readStore()
    const after = editLine(before ?? "", name, { remove: true })
    if (after === null) return bad("not_found", `${name} introuvable`, 404)
    return commit(before, after, "deleted", name, [], toOrigin(origin))
  })
}

// ── `/key` chat command ──

const CMD_RE = /^\/key(?:\s|$)/i

export function isKeyCommand(text: string): boolean {
  return CMD_RE.test(text.trim())
}

const KEY_USAGE = "usage: /key NOM valeur [--hosts a.io,b.io] — valeur en UN seul mot (espace → écran Vault)"

/**
 * Grammar: `/key NAME VALUE` or `/key NAME VALUE --hosts h1,h2`. Anything else
 * (a value with a space, a bare trailing host) is rejected — never guessed —
 * so half a value can't be silently stored and the rest treated as hosts.
 * Errors never echo the value.
 */
export function parseKeyCommand(text: string): { name: string; value: string; hosts: string[] } | { error: string } {
  const [, name = "", value = "", ...rest] = text.trim().split(/\s+/)
  if (!validName(name)) return { error: `${KEY_USAGE} — NOM en MAJUSCULES_ET_CHIFFRES` }
  if (!value || value === "--hosts") return { error: `${KEY_USAGE} — valeur manquante` }
  if (rest.length === 0) return { name, value, hosts: [] }
  if (rest.length === 2 && rest[0] === "--hosts") return { name, value, hosts: rest[1]!.split(",").filter(Boolean) }
  return { error: `${KEY_USAGE} — texte en trop après la valeur: rien enregistré` }
}

/** `/key NAME value [--hosts a,b]` → vault upsert. null = not a /key message. */
export async function handleKeyCommand(text: string, origin: Partial<AuditOrigin> = {}): Promise<VaultResult | null> {
  if (!isKeyCommand(text)) return null
  const wait = writeLimiter.take()
  if (wait !== null) return { ...bad("rate_limited", `Trop d'écritures au coffre — réessaie dans ${wait}s.`, 429), retry_after: wait }
  const parsed = parseKeyCommand(text)
  if ("error" in parsed) return bad("bad_key_command", parsed.error)
  return upsertSecret(parsed, { device_claimed: "chat", transport: "chat", ...origin })
}
