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

if (subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
  console.log(`Claude Companion

Usage:
  bun cli.ts                   Start the companion server (default)
  bun cli.ts init              Install hooks + patch ~/.claude/settings.json + print pairing token
  bun cli.ts uninstall         Remove companion hook entries from ~/.claude/settings.json
  bun cli.ts pair [--url URL]  Print a scannable QR + pairing token (auto-detects LAN IP)
  bun cli.ts print-token       Print the pairing URL + token without starting the server
  bun cli.ts daemon <action>   Manage the server LaunchAgent (install/uninstall/status/logs)
  bun cli.ts menubar <action>  Manage the menu bar app (install/uninstall/status/build)
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
import { discoverLiveClaudes } from "./server/lib/discover"
import { getAuthToken } from "./server/lib/auth"

const PORT = Number(process.env.COMPANION_PORT) || 4245

const server = createCompanionServer(PORT)
const token = getAuthToken()

const dim = "\x1b[2m"
const reset = "\x1b[0m"
const cyan = "\x1b[36m"
const bold = "\x1b[1m"

console.log(`${dim}Claude Companion → http://0.0.0.0:${PORT}${reset}`)
console.log()
console.log(`${bold}Pairing${reset}`)
console.log(`  ${dim}URL  ${reset} http://<your-mac>:${PORT}`)
console.log(`  ${dim}Token${reset} ${cyan}${token}${reset}`)
console.log(`  ${dim}Paste both into the iOS app's Settings screen.${reset}`)
console.log()

// Discover live claude-code processes first — gives us tty-keyed entries that
// work for inject on boot. Rehydrate then fills in anything that's recently
// active but not currently running.
discoverLiveClaudes().then(({ registered }) => {
  if (registered > 0) {
    console.log(`${dim}⚡ discovered ${registered} live claude process${registered === 1 ? "" : "es"}${reset}`)
  }
}).catch(() => { /* silent */ })

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
