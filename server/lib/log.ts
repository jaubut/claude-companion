// Single writer for companion.log lines. Every line gets an ISO UTC timestamp
// so incidents (e.g. a "delivered (tmux)" with no matching UserPromptSubmit)
// can be dated from the log alone, without cross-referencing feed events.

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
