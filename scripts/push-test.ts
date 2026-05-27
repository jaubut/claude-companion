#!/usr/bin/env bun
/**
 * Manually fire a test push to every registered device. Used to iterate on
 * the iOS app without having to trigger a real Claude approval.
 *
 * Usage:
 *   bun scripts/push-test.ts approval
 *   bun scripts/push-test.ts question
 *   bun scripts/push-test.ts waiting
 *   bun scripts/push-test.ts approval "Bash" "rm -rf /tmp/junk"
 */

import { loadDefaultDotEnv } from "../server/lib/dotenv"
loadDefaultDotEnv()

import { sendApns, apnsConfigured, closeApnsSessions, type ApnsPayload } from "../server/lib/apns"
import { listTokens } from "../server/lib/push-tokens"

const [, , kind = "approval", arg1 = "", arg2 = ""] = process.argv

if (!apnsConfigured()) {
  console.error("APNs not configured. Set APNS_TEAM_ID, APNS_KEY_ID, APNS_KEY_P8_PATH, APNS_BUNDLE_ID.")
  process.exit(1)
}

const tokens = listTokens()
if (tokens.length === 0) {
  console.error("No registered devices. Launch the iOS app first to POST /api/register-token.")
  process.exit(1)
}

console.log(`Sending test '${kind}' push to ${tokens.length} device(s)...`)

let payload: ApnsPayload
if (kind === "approval") {
  const tool = arg1 || "Bash"
  const input = arg2 || "echo hello"
  payload = {
    title: "Approval needed (test)",
    body: `${tool}: ${input}`.slice(0, 180),
    category: "approval",
    userInfo: { approvalId: "test-" + Date.now(), sessionId: "test-session", cwd: process.cwd() },
  }
} else if (kind === "waiting") {
  payload = {
    title: "Claude is waiting (test)",
    body: arg1 || "Tap to respond",
    category: "waiting_input",
    userInfo: { cwd: process.cwd(), sessionId: "test-session", key: "" },
  }
} else if (kind === "question") {
  payload = {
    title: "Question asked (test)",
    body: arg1 || "Pick an answer in the app",
    category: "question",
    userInfo: { questionId: "test-" + Date.now(), sessionId: "test-session", cwd: process.cwd() },
  }
} else {
  console.error(`Unknown kind: ${kind}. Use 'approval', 'question', or 'waiting'.`)
  process.exit(1)
}

// Send one-by-one so we surface per-device errors instead of swallowing them.
let sent = 0
for (const t of tokens) {
  const r = await sendApns(t.token, t.environment, payload)
  const short = t.token.slice(0, 8) + "…" + t.token.slice(-4)
  if (r.ok) {
    console.log(`  ✓ ${short} (${t.environment}${t.deviceName ? ` · ${t.deviceName}` : ""}) → ${r.status}`)
    sent++
  } else {
    console.log(`  ✗ ${short} (${t.environment}${t.deviceName ? ` · ${t.deviceName}` : ""}) → ${r.status} ${r.reason ?? ""}`)
  }
}
console.log(`sent=${sent}/${tokens.length}`)
closeApnsSessions()
