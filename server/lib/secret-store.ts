import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Add an agent key from the phone chat without it ever reaching a transcript.
//
// The user types `/key NAME value [host ...]` in any composer (session inject,
// WS input, orchestrator). Every chat entry point calls `handleKeyCommand`
// FIRST: a `/key` message is written to ~/.config/tls-agent/secrets.env and
// answered with the name only — it is never typed into a pane, recorded as a
// turn, broadcast or logged with its value.
//
// Store format and masking are owned by ~/.claude/tools/tls-secrets.py
// (`NAME='value'  # host ...`). We upsert one line (other lines kept verbatim)
// and then run its `sync`, which masks the key in the Claude sandbox. If sync
// fails, the store is rolled back: an unmasked key would be exported in clear
// into every session by tls-agent-env.

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/
const HOST_RE = /^[A-Za-z0-9*.-]+(:\d+)?$/
const CMD_RE = /^\/key(?:\s|$)/i

export interface KeyCommand { name: string; value: string; hosts: string[] }
export interface KeyResult { ok: boolean; name?: string; hosts?: string[]; error?: string; message: string }

export interface SecretDeps {
  storePath?: string
  sync?: () => Promise<{ ok: boolean; detail: string }>
}

export function isKeyCommand(text: string): boolean {
  return CMD_RE.test(text.trim())
}

// `/key NAME value [host ...]` → parts, or an error that never echoes the value.
export function parseKeyCommand(text: string): KeyCommand | { error: string } {
  const [, name = "", value = "", ...hosts] = text.trim().split(/\s+/)
  if (!NAME_RE.test(name)) return { error: "usage: /key NOM valeur [hôte ...] — NOM en MAJUSCULES_ET_CHIFFRES" }
  if (!value) return { error: `valeur manquante pour ${name}` }
  if (value.includes("'")) return { error: `valeur de ${name} refusée (apostrophe)` }
  const bad = hosts.find((h) => !HOST_RE.test(h))
  if (bad !== undefined) return { error: `hôte invalide: ${bad.slice(0, 40)}` }
  return { name, value, hosts }
}

export function defaultStorePath(): string {
  return process.env.TLS_SECRETS_FILE ?? join(homedir(), ".config", "tls-agent", "secrets.env")
}

// Replace NAME's line (or append it); every other line stays byte-identical.
export function upsertLine(content: string, cmd: KeyCommand): string {
  const line = `${cmd.name}='${cmd.value}'` + (cmd.hosts.length ? `  # ${cmd.hosts.join(" ")}` : "")
  const own = new RegExp(`^\\s*(?:export\\s+)?${cmd.name}=`)
  const kept = content.split("\n").filter((l) => l !== "" && !own.test(l))
  if (kept.length === 0) kept.push("# Agent secrets. NAME='value'  # hosts [scripts]   — see ~/.claude/tools/tls-secrets.py")
  return [...kept, line].join("\n") + "\n"
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}

async function runSync(): Promise<{ ok: boolean; detail: string }> {
  const script = join(homedir(), ".claude", "tools", "tls-secrets.py")
  if (!existsSync(script)) return { ok: false, detail: "tls-secrets.py introuvable" }
  const proc = Bun.spawn(["python3", script, "sync"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => proc.kill(), 30_000)
  const code = await proc.exited
  clearTimeout(timer)
  const out = (await new Response(code === 0 ? proc.stdout : proc.stderr).text()).trim()
  return { ok: code === 0, detail: out.slice(-200) }
}

export async function saveSecret(cmd: KeyCommand, deps: SecretDeps = {}): Promise<KeyResult> {
  const path = deps.storePath ?? defaultStorePath()
  const before = existsSync(path) ? readFileSync(path, "utf8") : null
  atomicWrite(path, upsertLine(before ?? "", cmd))
  const synced = await (deps.sync ?? runSync)()
  if (!synced.ok) {
    // No file before = remove it: an empty secrets.env would make
    // tls-agent-env switch to it and drop every other key.
    if (before === null) unlinkSync(path)
    else atomicWrite(path, before)
    return { ok: false, name: cmd.name, error: "sync_failed", message: `${cmd.name} NON enregistré — masquage échoué (${synced.detail}). Rien n'a changé.` }
  }
  const where = cmd.hosts.length ? cmd.hosts.join(" ") : "aucun hôte: jamais envoyé"
  return { ok: true, name: cmd.name, hosts: cmd.hosts, message: `🔑 ${cmd.name} enregistré (${where}). Redémarre la session pour l'utiliser.` }
}

// null = not a /key message, carry on as normal chat. Otherwise the message
// has been consumed and must go nowhere else.
export async function handleKeyCommand(text: string, deps: SecretDeps = {}): Promise<KeyResult | null> {
  if (!isKeyCommand(text)) return null
  const cmd = parseKeyCommand(text)
  if ("error" in cmd) return { ok: false, error: "bad_key_command", message: cmd.error }
  return saveSecret(cmd, deps)
}
