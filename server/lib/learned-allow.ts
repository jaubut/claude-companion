// Learned-allow — phone says "yes" once, Companion remembers the shape and
// auto-approves the same shape next time without bothering the phone.
//
// Storage: SQLite at ~/.claude-companion/companion.db (same DB as
// push-tokens; we open our own connection on the same file — Bun's
// bun:sqlite handles concurrent connections fine for this volume).
//
// Pattern derivation (Bash): first command word, plus the second word for a
// short list of multi-verb binaries (git/bun/npm/yarn/pnpm/turso/docker/
// kubectl). That's it — no path normalization, no flag matching. Coarse on
// purpose so "git status" learned once covers every future "git status",
// but conservative: a learned "git push" will NOT match "git push --force"
// because the static DANGEROUS_BASH check fires first in autoJudge and
// returns "deny" before we even consult the learned table.
//
// Tools we won't learn (always re-prompt): rm, mv, cp, chmod, chown, sudo,
// dd, mkfs, fdisk, kill, killall, shutdown, reboot. The destructive
// surface is too high and a "yes" on `rm -rf /tmp/foo` shouldn't auto-allow
// `rm -rf /tmp/bar` next week.

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DB_DIR = join(homedir(), ".claude-companion")
const DB_PATH = join(DB_DIR, "companion.db")

mkdirSync(DB_DIR, { recursive: true })
const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS learned_allow (
    pattern    TEXT PRIMARY KEY,
    tool       TEXT NOT NULL,
    sample     TEXT NOT NULL,
    hits       INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_used  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_learned_allow_tool ON learned_allow(tool);
`)

// ── Multi-word binaries — keep the second token in the pattern ──────────────
const MULTI_VERB_BINARIES = new Set([
  "git", "bun", "bunx", "npm", "yarn", "pnpm", "npx",
  "turso", "docker", "kubectl", "gcloud", "aws", "az",
  "vercel", "railway", "fly", "stripe",
  "brew", "pip", "pip3", "cargo",
])

// ── Commands we refuse to learn — always re-prompt ──────────────────────────
const NEVER_LEARN = new Set([
  "rm", "mv", "cp", "chmod", "chown", "ln",
  "sudo", "dd", "mkfs", "fdisk", "parted",
  "kill", "killall", "pkill",
  "shutdown", "reboot", "halt",
])

function tokenize(cmd: string): string[] {
  // Split on whitespace, drop empties. Don't try to handle quoted args —
  // the first word is what matters for the pattern.
  return cmd.trim().split(/\s+/).filter(Boolean)
}

function isShellTool(tool: string): boolean {
  return tool === "Bash" || tool === "shell" || tool === "unified_exec" || tool === "exec_command"
}

/**
 * Derive a stable pattern from a tool call. Returns null if the call
 * shouldn't be learned (unsafe, unknown shape, etc).
 *
 * Bash patterns look like:
 *   "bash:git status"
 *   "bash:bun run"
 *   "bash:curl"
 *   "bash:ls"
 *   "bash:bash" (one-word commands)
 *
 * Edit/Write patterns look like:
 *   "edit:client/src/pages/foo.tsx"  (full file path — exact match only)
 */
export function patternFor(tool: string, input: Record<string, unknown>): string | null {
  if (isShellTool(tool)) {
    const cmd = String(input.command ?? input.cmd ?? "").trim()
    if (!cmd) return null

    // Don't learn chained commands — too easy to widen the blast radius
    // accidentally ("git status; rm -rf /").
    if (/[|;&]/.test(cmd)) return null

    const tokens = tokenize(cmd)
    const first = tokens[0]
    if (!first) return null

    const baseFirst = first.split("/").pop() ?? first
    if (NEVER_LEARN.has(baseFirst)) return null

    if (MULTI_VERB_BINARIES.has(baseFirst) && tokens.length > 1) {
      const second = tokens[1]
      // Don't learn flags as the verb (e.g. "git --version" → just "git")
      if (second?.startsWith("-")) return `bash:${baseFirst}`
      return `bash:${baseFirst} ${second}`
    }
    return `bash:${baseFirst}`
  }

  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    const fp = ((input.file_path as string) ?? "").trim()
    if (!fp) return null
    // Exact-path match only — editing one file doesn't imply consent for
    // any other file, even in the same directory.
    return `${tool.toLowerCase()}:${fp}`
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
  db.query(
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
  const row = db.query("SELECT 1 FROM learned_allow WHERE pattern = ? LIMIT 1").get(pattern) as { 1: number } | null
  if (!row) return false
  db.query("UPDATE learned_allow SET hits = hits + 1, last_used = ? WHERE pattern = ?").run(Date.now(), pattern)
  return true
}

export function listLearned(): LearnedEntry[] {
  return db
    .query("SELECT pattern, tool, sample, hits, created_at, last_used FROM learned_allow ORDER BY last_used DESC")
    .all() as LearnedEntry[]
}

export function forgetLearned(pattern: string): boolean {
  const res = db.query("DELETE FROM learned_allow WHERE pattern = ?").run(pattern)
  return res.changes > 0
}

export function clearLearned(toolFilter?: string): number {
  if (toolFilter) {
    return db.query("DELETE FROM learned_allow WHERE tool = ?").run(toolFilter).changes
  }
  return db.query("DELETE FROM learned_allow").run().changes
}

function sampleFor(tool: string, input: Record<string, unknown>): string {
  if (isShellTool(tool)) return String(input.command ?? input.cmd ?? "").trim().slice(0, 200)
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    return String(input.file_path ?? "")
  }
  return JSON.stringify(input).slice(0, 200)
}
