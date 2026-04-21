#!/usr/bin/env bun

import { createCompanionServer } from "./server/companion-server"
import { pushConfig } from "./server/lib/push"

const PORT = Number(process.env.COMPANION_PORT) || 4245

const server = createCompanionServer(PORT)

console.log(`\x1b[2mClaude Companion → http://0.0.0.0:${PORT}\x1b[0m`)
const push = pushConfig()
if (push) {
  console.log(`\x1b[2mPush notifications → ${push.url}${push.hasToken ? " (auth: bearer)" : ""}\x1b[0m`)
} else {
  console.log(`\x1b[2mPush notifications: disabled (set COMPANION_NTFY_TOPIC to enable)\x1b[0m`)
}
console.log(`\x1b[2mPhone approvals will appear here. Press Ctrl+C to stop.\x1b[0m\n`)

process.on("SIGINT", () => {
  server.stop()
  process.exit(0)
})

process.on("SIGTERM", () => {
  server.stop()
  process.exit(0)
})
