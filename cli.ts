#!/usr/bin/env bun

import { createCompanionServer } from "./server/companion-server"
import { rehydrateSessions } from "./server/lib/rehydrate"

const PORT = Number(process.env.COMPANION_PORT) || 4245

const server = createCompanionServer(PORT)

console.log(`\x1b[2mClaude Companion → http://0.0.0.0:${PORT}\x1b[0m`)

// Rehydrate session picker from recent Claude Code transcripts so idle
// sessions are visible immediately on phone load.
rehydrateSessions().then(({ registered, scanned }) => {
  if (registered > 0) {
    console.log(`\x1b[2m↻ rehydrated ${registered} session${registered === 1 ? "" : "s"} from ${scanned} recent transcript${scanned === 1 ? "" : "s"}\x1b[0m`)
  }
}).catch(() => { /* silent */ })

console.log(`\x1b[2mPhone approvals will appear here. Press Ctrl+C to stop.\x1b[0m\n`)

process.on("SIGINT", () => {
  server.stop()
  process.exit(0)
})

process.on("SIGTERM", () => {
  server.stop()
  process.exit(0)
})
