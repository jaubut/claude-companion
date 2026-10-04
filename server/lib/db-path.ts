import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

// The one place that knows where Companion's sqlite lives. Every bun:sqlite
// store (orchestrator, learned-allow, session-titles, push-tokens,
// approval-history, receipt-qa) resolves through here so COMPANION_DB_PATH
// isolates all of them at once. Under `bun test` (NODE_ENV=test) with no
// override, a per-process throwaway file — never the real home db.
export function companionDbPath(): string {
  if (process.env.COMPANION_DB_PATH) return process.env.COMPANION_DB_PATH
  if (process.env.NODE_ENV === "test") return join(tmpdir(), `companion-test-${process.pid}.db`)
  return join(homedir(), ".claude-companion", "companion.db")
}
