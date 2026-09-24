// Single writer for companion.log lines. Every line gets an ISO UTC timestamp
// so incidents (e.g. a "delivered (tmux)" with no matching UserPromptSubmit)
// can be dated from the log alone, without cross-referencing feed events.

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

export function logPrefix(now: Date = new Date()): string {
  return `${DIM}${now.toISOString()} [companion]${RESET}`
}

/** Write one `[companion]` line to stderr. `msg` may carry its own colours. */
export function companionLog(msg: string): void {
  process.stderr.write(`${logPrefix()} ${msg}\n`)
}
