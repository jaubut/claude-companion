// Single writer for companion.log lines. Every line gets an ISO UTC timestamp
// so incidents (e.g. a "delivered (tmux)" with no matching UserPromptSubmit)
// can be dated from the log alone, without cross-referencing feed events.

import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

export function logPrefix(now: Date = new Date()): string {
  return `${DIM}${now.toISOString()} [companion]${RESET}`
}

// Every physical line carries the prefix: a multiline prompt excerpt or an
// error stack must stay datable line by line (Codex review of PR #56).
export function formatLogLines(msg: string, now: Date = new Date()): string {
  const prefix = logPrefix(now)
  return msg.split("\n").map((line) => `${prefix} ${line}`).join("\n") + "\n"
}

/** Write `[companion]` line(s) to stderr. `msg` may carry its own colours. */
export function companionLog(msg: string): void {
  process.stderr.write(formatLogLines(msg))
}

// launchd (StandardErrorPath) and systemd open companion.log before the
// server runs, with the service manager's umask (0644 in practice). The log
// carries prompt text and hook payloads, so the server narrows it to the
// owner at every start. Creates it 0600 when missing, so a service manager
// that opens it later appends to a private file. Never throws: a log it
// cannot chmod must not stop the server.
export const COMPANION_LOG_PATH = join(homedir(), ".claude-companion", "companion.log")

export function secureLogFile(path: string = process.env.COMPANION_LOG_PATH || COMPANION_LOG_PATH): boolean {
  try {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      closeSync(openSync(path, "a", 0o600))
    }
    chmodSync(path, 0o600)
    return true
  } catch {
    return false
  }
}
