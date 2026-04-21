#!/usr/bin/env bun

import { createCompanionServer } from "./server/companion-server"
import { configSummary } from "./server/lib/web-push"

const PORT = Number(process.env.COMPANION_PORT) || 4245

const server = createCompanionServer(PORT)

const push = configSummary()
console.log(`\x1b[2mClaude Companion → http://0.0.0.0:${PORT}\x1b[0m`)
console.log(
  `\x1b[2mWeb Push → VAPID ready · ${push.subs} device${push.subs === 1 ? "" : "s"} subscribed\x1b[0m`,
)
console.log(`\x1b[2mPhone approvals will appear here. Press Ctrl+C to stop.\x1b[0m\n`)

process.on("SIGINT", () => {
  server.stop()
  process.exit(0)
})

process.on("SIGTERM", () => {
  server.stop()
  process.exit(0)
})
