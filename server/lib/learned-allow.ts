// Learned-allow — phone says "yes" once, Companion remembers the shape and
// auto-approves the same shape next time without bothering the phone.
//
// Storage: the shared Companion sqlite (db-path.ts; same DB as
// push-tokens; we open our own connection on the same file — Bun's
// bun:sqlite handles concurrent connections fine for this volume).
//
// Pattern derivation (Bash): first command word, plus the subcommand for
// multi-verb binaries (git/bun/npm/docker/...): `bash:git push`, `bash:docker
// run`. No path normalization, no flag matching. A learned "git push" does NOT
// cover "git push --force": the static DANGEROUS_BASH check fires first in
// autoJudge and denies before the learned table is consulted.
//
// Never learned (always re-prompt) — one "yes" must not become a standing
// grant for arbitrary code, network egress, privilege or destruction:
//   - interpreters / shells / eval / exec wrappers (python*, node, bun, deno,
//     ruby, perl, sh, bash, zsh, eval, env, xargs, timeout, …)
//   - network tools (ssh, scp, rsync, curl, wget, nc, …)
//   - privilege and destructive verbs (sudo, su, rm, dd, chmod, chown, …)
//   - any command with a chain, pipe, redirect, substitution or subshell
//   - a multi-verb binary whose second word is a flag (`git -c x=y …`)
//   - a first/second word that is quoted, escaped or has a `$` (`"rm" -rf`)
//
// MCP tools learn per tool name (`mcp:<tool>`), except ones whose verb sends,
// deletes or executes something (see MCP_NEVER_LEARN).

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { companionDbPath } from "./db-path"

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS learned_allow (
    pattern    TEXT PRIMARY KEY,
    tool       TEXT NOT NULL,
    sample     TEXT NOT NULL,
    hits       INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_used  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_learned_allow_tool ON learned_allow(tool);
`

// Opened lazily, on first use, at companionDbPath() like the other stores —
// so a test (or an isolated verify server) never touches the real home db.
// `useLearnedAllowDb` is the explicit seam for tests that cannot control
// import order.
let db: Database | null = null

function open(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const d = new Database(path)
  d.exec(SCHEMA)
  return d
}

function store(): Database {
  if (!db) db = open(companionDbPath())
  return db
}

export function useLearnedAllowDb(path: string): void {
  try { db?.close() } catch { /* ignore */ }
  db = open(path)
}

// ── Multi-word binaries — keep the second token in the pattern ──────────────
const MULTI_VERB_BINARIES = new Set([
  "git", "npm", "yarn", "pnpm",
  "turso", "docker", "kubectl", "gcloud", "aws", "az",
  "vercel", "railway", "fly", "stripe",
  "brew", "pip", "pip3", "cargo", "gh",
])

// ── Commands we refuse to learn — always re-prompt ──────────────────────────
const NEVER_LEARN = new Set([
  // destructive / privilege
  "rm", "mv", "cp", "chmod", "chown", "chgrp", "ln",
  "sudo", "su", "doas", "pkexec", "dd", "mkfs", "fdisk", "parted",
  "kill", "killall", "pkill",
  "shutdown", "reboot", "halt",
  // interpreters, shells, eval and exec wrappers (run whatever follows)
  "node", "bun", "bunx", "npx", "pnpx", "deno", "ruby", "perl", "php", "lua", "osascript",
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh",
  "eval", "exec", "source", ".", "env", "xargs", "nohup", "time", "timeout", "nice", "watch", "command", "builtin",
  "uv", "uvx", "pipx",
  // network egress
  "ssh", "scp", "sftp", "rsync", "curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ftp",
])

// python, python3, python3.12, ipython, pypy3 …
const INTERPRETER_RE = /^(i?python[\d.]*|pypy[\d.]*)$/

// Chain, pipe, background, redirect, substitution, subshell, newline.
const COMPOUND_RE = /[|;&<>`()\n]|\$\(/
// A plain word: no quotes, escapes, `$`, globs.
const PLAIN_TOKEN_RE = /^[A-Za-z0-9_./+@:-]+$/

// MCP verbs that send, delete or execute: a "yes" on one email/deletion must
// not become a standing grant.
const MCP_NEVER_LEARN_RE = /send|delete|trash|remove|destroy|drop|purge|execute|exec|run|eval|pay|transfer|purchase|deploy|publish/i

function tokenize(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean)
}

function isShellTool(tool: string): boolean {
  return tool === "Bash" || tool === "shell" || tool === "unified_exec" || tool === "exec_command"
}

export function isMcpTool(tool: string): boolean {
  return tool.startsWith("mcp__")
}

function bashPattern(cmd: string): string | null {
  if (!cmd || COMPOUND_RE.test(cmd)) return null
  const tokens = tokenize(cmd)
  const first = tokens[0]
  if (!first || !PLAIN_TOKEN_RE.test(first) || first.includes("=")) return null
  const base = first.split("/").pop() ?? first
  if (!base || NEVER_LEARN.has(base) || INTERPRETER_RE.test(base)) return null
  if (!MULTI_VERB_BINARIES.has(base)) return `bash:${base}`
  const second = tokens[1]
  if (!second) return `bash:${base}`
  // `git -c core.sshCommand=… fetch`, `git -C dir push`: the verb hides
  // behind a flag, so there is no stable shape to learn.
  if (second.startsWith("-") || !PLAIN_TOKEN_RE.test(second)) return null
  return `bash:${base} ${second}`
}

/**
 * Derive a stable pattern from a tool call. Returns null if the call
 * shouldn't be learned (unsafe, unknown shape, etc).
 *
 *   "bash:git status"   "bash:docker run"   "bash:ls"
 *   "edit:/abs/path/foo.tsx"  (exact path only)
 *   "mcp:mcp__server__tool"   (per tool name)
 */
export function patternFor(tool: string, input: Record<string, unknown>): string | null {
  if (isShellTool(tool)) {
    return bashPattern(String(input.command ?? input.cmd ?? "").trim())
  }

  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    const fp = ((input.file_path as string) ?? "").trim()
    if (!fp) return null
    // Exact-path match only — editing one file doesn't imply consent for
    // any other file, even in the same directory.
    return `${tool.toLowerCase()}:${fp}`
  }

  if (isMcpTool(tool)) {
    const verb = tool.split("__").pop() ?? ""
    if (!verb || MCP_NEVER_LEARN_RE.test(verb)) return null
    return `mcp:${tool}`
  }

  return null
}

export interface LearnedEntry {
  pattern: string
  tool: string
  sample: string
  hits: number
  created_at: number
  last_used: number
}

/**
 * Record a "yes" decision so the same shape auto-allows next time.
 * No-op if the pattern is unlearnable (chained command, blocked verb).
 */
export function recordAllow(tool: string, input: Record<string, unknown>): void {
  const pattern = patternFor(tool, input)
  if (!pattern) return
  const sample = sampleFor(tool, input)
  const now = Date.now()
  store().query(
    "INSERT INTO learned_allow (pattern, tool, sample, hits, created_at, last_used) VALUES (?, ?, ?, 1, ?, ?) " +
    "ON CONFLICT(pattern) DO UPDATE SET hits = hits + 1, last_used = excluded.last_used",
  ).run(pattern, tool, sample, now, now)
}

/**
 * Returns true if the call matches a previously-learned allow.
 * Bumps last_used + hits on hit (so we can show "auto-approved 12 times"
 * later if we want a UI for it).
 */
export function isLearned(tool: string, input: Record<string, unknown>): boolean {
  const pattern = patternFor(tool, input)
  if (!pattern) return false
  const row = store().query("SELECT 1 FROM learned_allow WHERE pattern = ? LIMIT 1").get(pattern) as { 1: number } | null
  if (!row) return false
  store().query("UPDATE learned_allow SET hits = hits + 1, last_used = ? WHERE pattern = ?").run(Date.now(), pattern)
  return true
}

export function listLearned(): LearnedEntry[] {
  return store()
    .query("SELECT pattern, tool, sample, hits, created_at, last_used FROM learned_allow ORDER BY last_used DESC")
    .all() as LearnedEntry[]
}

export function forgetLearned(pattern: string): boolean {
  const res = store().query("DELETE FROM learned_allow WHERE pattern = ?").run(pattern)
  return res.changes > 0
}

export function clearLearned(toolFilter?: string): number {
  if (toolFilter) {
    return store().query("DELETE FROM learned_allow WHERE tool = ?").run(toolFilter).changes
  }
  return store().query("DELETE FROM learned_allow").run().changes
}

function sampleFor(tool: string, input: Record<string, unknown>): string {
  if (isShellTool(tool)) return String(input.command ?? input.cmd ?? "").trim().slice(0, 200)
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    return String(input.file_path ?? "")
  }
  return JSON.stringify(input).slice(0, 200)
}
