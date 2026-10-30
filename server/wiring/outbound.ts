import { homedir } from "node:os"
import { join } from "node:path"
import { db } from "../lib/orchestrator-db"
import { type OutboundPayload, type OutboundSender, type OutboundStore, createOutboundStore, parseMessageId } from "../lib/outbound"

// Outbound approval, live instance (docs/orchestrator-triage-api.md#source-outbound):
// the companion.db store, the producer behind POST /api/orchestrator/outbound and
// the real sender, which shells to ~/.claude/tools/gmail.py (raw-MIME send for
// personal + hello@; never the claude.ai connector, it wraps links).

export const SEND_TIMEOUT_MS = 90_000

let live: OutboundStore | null = null
export function outboundStore(): OutboundStore {
  live ??= createOutboundStore(db)
  return live
}

const gmailPy = (): string => process.env.COMPANION_GMAIL_PY || join(homedir(), ".claude", "tools", "gmail.py")

/**
 * gmail.py argv for one payload; the body goes on stdin (no size/quoting limits, never in `ps`).
 * Kept in one place: adjust here if gmail.py's CLI differs.
 */
export function gmailArgv(p: OutboundPayload): string[] {
  return [
    "python3", gmailPy(), "send", "--account", p.account,
    ...p.to.flatMap((a) => ["--to", a]),
    ...p.cc.flatMap((a) => ["--cc", a]),
    "--subject", p.subject,
    ...(p.inReplyTo ? ["--in-reply-to", p.inReplyTo] : []),
    "--body-stdin",
  ]
}

/** The real sender: exit 0 = sent (message id parsed from stdout); anything else throws = not sent. */
export const gmailSender: OutboundSender = async (p) => {
  if (process.env.NODE_ENV === "test") throw new Error("real sender disabled under test")
  const proc = Bun.spawn(gmailArgv(p), { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  proc.stdin.write(p.body)
  await proc.stdin.end()
  const timer = setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, SEND_TIMEOUT_MS)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited,
    ])
    if (code !== 0) throw new Error(`gmail.py exited ${code}: ${stderr.trim().slice(0, 300) || stdout.trim().slice(0, 300)}`)
    return { messageId: parseMessageId(stdout) }
  } finally {
    clearTimeout(timer)
  }
}
