#!/usr/bin/env bun

import { loadDefaultDotEnv } from "./server/lib/dotenv"
loadDefaultDotEnv()

const subcommand = process.argv[2]?.toLowerCase()

if (subcommand === "init" || subcommand === "install") {
  const { init } = await import("./scripts/install")
  await init()
  process.exit(0)
}

if (subcommand === "uninstall" || subcommand === "remove") {
  const { uninstall } = await import("./scripts/install")
  await uninstall()
  process.exit(0)
}

if (subcommand === "print-token" || subcommand === "token") {
  const { printToken } = await import("./scripts/install")
  printToken()
  process.exit(0)
}

if (subcommand === "pair" || subcommand === "qr") {
  const { printPair } = await import("./scripts/pair")
  // Optional --url <override> after the subcommand
  const argv = process.argv.slice(3)
  let urlOverride: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--url" || a === "-u") {
      urlOverride = argv[i + 1]
      i++
    }
  }
  await printPair({ url: urlOverride })
  process.exit(0)
}

if (subcommand === "daemon") {
  const action = process.argv[3]?.toLowerCase()
  const daemon = await import("./scripts/daemon")
  switch (action) {
    case "install":
      await daemon.daemonInstall()
      break
    case "uninstall":
      await daemon.daemonUninstall()
      break
    case "status":
      await daemon.daemonStatus()
      break
    case "logs":
      await daemon.daemonLogs()
      break
    default:
      console.log(`Usage:
  bun cli.ts daemon install    Install LaunchAgent so the server auto-starts at login
  bun cli.ts daemon uninstall  Remove the LaunchAgent
  bun cli.ts daemon status     Show whether it's loaded + current PID
  bun cli.ts daemon logs       Tail the server log
`)
      process.exit(action ? 1 : 0)
  }
  process.exit(0)
}

if (subcommand === "menubar") {
  const action = process.argv[3]?.toLowerCase()
  const menubar = await import("./scripts/menubar")
  switch (action) {
    case "install":
      await menubar.menubarInstall()
      break
    case "uninstall":
      await menubar.menubarUninstall()
      break
    case "status":
      await menubar.menubarStatus()
      break
    case "build":
      await menubar.menubarBuild()
      break
    default:
      console.log(`Usage:
  bun cli.ts menubar install    Build menubar app + load LaunchAgent so it starts at login
  bun cli.ts menubar uninstall  Unload + remove the LaunchAgent
  bun cli.ts menubar status     Show bundle + agent + PID state
  bun cli.ts menubar build      (re)build the app without touching launchd
`)
      process.exit(action ? 1 : 0)
  }
  process.exit(0)
}

// Jev front door go-live numbers from the shadow log (jev_route_log).
if (subcommand === "jev-report") {
  const { Database } = await import("bun:sqlite")
  const { existsSync } = await import("node:fs")
  const { buildReport, formatReport, readRouteLog } = await import("./server/lib/jev-route-log")
  const { minConfidence } = await import("./server/lib/jev-router")
  const at = process.argv.indexOf("--days")
  const days = at > 0 && Number(process.argv[at + 1]) > 0 ? Number(process.argv[at + 1]) : 30
  const { companionDbPath } = await import("./server/lib/db-path")
  const path = companionDbPath()
  if (!existsSync(path)) {
    console.log(`no Companion db at ${path}`)
    process.exit(0)
  }
  const db = new Database(path, { readonly: true })
  let rows: ReturnType<typeof readRouteLog> = []
  try {
    rows = readRouteLog(db, Date.now() - days * 86_400_000)
  } catch {
    console.log("no jev_route_log yet — the server has not routed a message with this build")
    process.exit(0)
  }
  console.log(formatReport(buildReport(rows, minConfidence()), days))
  process.exit(0)
}

// Opus resolver dry run: real items, real read-only Opus, nothing executed (point COMPANION_DB_PATH at a copy).
if (subcommand === "resolver-dry-run") {
  const { resolverDryRun, formatDryRun } = await import("./server/wiring/resolver-dry-run")
  const arg = (name: string) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] ?? null : null }
  const limit = Number(arg("--limit")) > 0 ? Number(arg("--limit")) : 10
  const concurrency = Number(arg("--concurrency")) > 0 ? Number(arg("--concurrency")) : undefined
  const rows = await resolverDryRun({ limit, only: arg("--source"), concurrency, log: (m) => console.error(m) })
  console.log(formatDryRun(rows))
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}

// Trip classifier accuracy from companion.db trip_classify_log (auto-file rate, human overrides).
if (subcommand === "trip-report") {
  const { Database } = await import("bun:sqlite")
  const { existsSync } = await import("node:fs")
  const { homedir } = await import("node:os")
  const { join } = await import("node:path")
  const { readLogSince } = await import("./server/lib/trip-store")
  const { buildTripReport, formatTripReport } = await import("./server/lib/trip-report")
  const { autofileThreshold } = await import("./server/lib/trip-classify")
  const at = process.argv.indexOf("--days")
  const days = at > 0 && Number(process.argv[at + 1]) > 0 ? Number(process.argv[at + 1]) : 30
  const path = process.env.COMPANION_DB_PATH ?? join(homedir(), ".claude-companion", "companion.db")
  if (!existsSync(path)) {
    console.log(`no companion.db at ${path}`)
    process.exit(0)
  }
  const db = new Database(path, { readonly: true })
  let rows: ReturnType<typeof readLogSince> = []
  try {
    rows = readLogSince(db, Date.now() - days * 86_400_000)
  } catch {
    console.log("no trip_classify_log yet — the server has not classified a trip with this build")
    process.exit(0)
  }
  console.log(formatTripReport(buildTripReport(rows), days, autofileThreshold()))
  process.exit(0)
}

if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
  console.log(`Claude Companion

Usage:
  bun cli.ts                   Start the companion server (default)
  bun cli.ts init              Install Claude/Codex hooks + print pairing token
  bun cli.ts uninstall         Remove companion hook entries from Claude/Codex config
  bun cli.ts pair [--url URL]  Print a scannable QR + pairing token (auto-detects LAN IP)
  bun cli.ts print-token       Print the pairing URL + token without starting the server
  bun cli.ts daemon <action>   Manage the server LaunchAgent (install/uninstall/status/logs)
  bun cli.ts menubar <action>  Manage the menu bar app (install/uninstall/status/build)
  bun cli.ts jev-report [--days N]  Jev front-door shadow report (agreement, go-live bar)
  bun cli.ts trip-report [--days N] Trip classifier report (auto-file rate, human overrides)
  bun cli.ts resolver-dry-run [--limit N] [--source task|pr|proposal|body] [--concurrency N] [--json]
                                    What the Opus resolver WOULD do with the current items (nothing executed)
`)
  process.exit(0)
}

if (subcommand && subcommand.length > 0) {
  console.error(`unknown subcommand: ${subcommand}\nrun \`bun cli.ts help\` for usage.`)
  process.exit(1)
}

// Default: start the server.

import { createCompanionServer } from "./server/companion-server"
import { rehydrateSessions } from "./server/lib/rehydrate"
import { discoverLiveClaudes, expectFirstDiscovery } from "./server/lib/discover"
import { reapScrapeSessions } from "./server/lib/command-offpane"
import { startCodexFeedMonitor } from "./server/lib/codex-feed"
import { getAuthToken, maskToken } from "./server/lib/auth"
import { secureLogFile } from "./server/lib/log"
import { startMediaSweeper } from "./server/wiring/media"
import { startRecordsExpiry } from "./server/lib/records-expiry"
import { startReceiptQa } from "./server/wiring/receipt-qa"
import { dispatchWiring } from "./server/wiring/dispatch"
import { reconcileLiveOnBoot } from "./server/wiring/live"
import { startBodyInvestigate } from "./server/wiring/body-investigate"
import { startTriage } from "./server/wiring/triage"
import { startTrips } from "./server/wiring/trips"
import { startMyTasksWatch } from "./server/routes/my-tasks"

const PORT = Number(process.env.COMPANION_PORT) || 4245

// Before anything is logged: companion.log is 0600 from here on.
secureLogFile()

// Before the server accepts /ws: a phone that reconnects during boot waits
// (≤3 s) for the first discovery pass instead of receiving `sessions: []`.
expectFirstDiscovery()
const server = createCompanionServer(PORT)
// After loadDefaultDotEnv() above: the age cap must come from the configured value.
startMediaSweeper()
// ID-record expiry pushes, store host only (inert when COMPANION_VAULT_UPSTREAM is set).
startRecordsExpiry()
// Receipt QA frames/push + queue resume (worker inert upstream or with COMPANION_RECEIPT_QA=off).
startReceiptQa()
// Turso dispatch poller (orchestrator-one-queue): every 20 s + /hooks/dispatch-event nudges.
dispatchWiring.start()
// Live mode (P4): close this host's claimed Turso rows whose tmux worker did not survive the restart.
void reconcileLiveOnBoot().catch(() => { /* logged inside; never blocks boot */ })
// Body auto-investigation: close runs a restart interrupted, sweep in 60 s, then every 10 min.
startBodyInvestigate()
// Brain triage: recompute after every dispatch poll / proposal change; phrase new items in the background.
startTriage()
startTrips()
startMyTasksWatch()
const token = getAuthToken()

const dim = "\x1b[2m"
const reset = "\x1b[0m"
const cyan = "\x1b[36m"
const bold = "\x1b[1m"

console.log(`${dim}Claude Companion → http://0.0.0.0:${PORT}${reset}`)
console.log()
console.log(`${bold}Pairing${reset}`)
console.log(`  ${dim}URL  ${reset} http://<your-mac>:${PORT}`)
// Masked: this banner lands in companion.log on every boot.
console.log(`  ${dim}Token${reset} ${cyan}${maskToken(token)}${reset} ${dim}(full: cat ~/.claude-companion/auth.token, or bun cli.ts print-token)${reset}`)
console.log(`  ${dim}Paste both into the iOS app's Settings screen.${reset}`)
console.log()

let codexFeedStarted = false
function ensureCodexFeedMonitor(): void {
  if (codexFeedStarted) return
  codexFeedStarted = true
  startCodexFeedMonitor()
  console.log(`${dim}↯ watching local Codex rollout feed${reset}`)
}

// Discover live Claude/Codex processes first — gives us tty-keyed entries that
// work for inject on boot. Rehydrate then fills in anything that's recently
// active but not currently running.
// Hidden /help enumeration sessions (cc-scrape-*, lib/command-offpane.ts):
// register every one as hidden, then kill the ones a previous server left
// behind, BEFORE the first discovery — an orphaned hidden claude is never
// picked up as a user session. Unconfirmed kills are retried in the background.
reapScrapeSessions().catch(() => []).then(() => discoverLiveClaudes()).then(({ registered }) => {
  if (registered > 0) {
    console.log(`${dim}⚡ discovered ${registered} live agent process${registered === 1 ? "" : "es"}${reset}`)
  }
}).catch(() => { /* silent */ }).finally(() => {
  // The Codex feed importer resolves rollout events by thread id. Starting it
  // after discovery gives live Codex TTY rows their real thread ids first, so
  // replayed feed events land in the same rows the user can inject into.
  ensureCodexFeedMonitor()
})

const codexFeedFallback = setTimeout(ensureCodexFeedMonitor, 3000)
if (typeof (codexFeedFallback as unknown as { unref?: () => void }).unref === "function") {
  (codexFeedFallback as unknown as { unref: () => void }).unref()
}

rehydrateSessions().then(({ registered, scanned }) => {
  if (registered > 0) {
    console.log(`${dim}↻ rehydrated ${registered} session${registered === 1 ? "" : "s"} from ${scanned} recent transcript${scanned === 1 ? "" : "s"}${reset}`)
  }
}).catch(() => { /* silent */ })

// Periodic live-process re-scan. Hooks register sessions on prompt/tool fire,
// but an idle session that started after companion boot (e.g. `tmux new -d`
// spawn) can sit invisible until its first hook. Re-discovering on an
// interval keeps the picker honest without persisting state to disk —
// truth comes from /proc on each tick, never from a cached row that can
// drift out of sync with reality.
const DISCOVER_INTERVAL_MS = Number(process.env.COMPANION_DISCOVER_INTERVAL_MS ?? "60000")
if (DISCOVER_INTERVAL_MS > 0) {
  const rediscover = setInterval(() => {
    discoverLiveClaudes().catch(() => { /* silent */ })
  }, DISCOVER_INTERVAL_MS)
  if (typeof (rediscover as unknown as { unref?: () => void }).unref === "function") {
    (rediscover as unknown as { unref: () => void }).unref()
  }
}

console.log(`${dim}Phone approvals will appear here. Press Ctrl+C to stop.${reset}\n`)

process.on("SIGINT", () => {
  server.stop()
  process.exit(0)
})

process.on("SIGTERM", () => {
  server.stop()
  process.exit(0)
})
