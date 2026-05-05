import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  copyFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

// Menubar status app — separate binary, separate launchd job from the
// server. Runs the SwiftPM-built `Companion.app` bundle in the user's
// session so the status item registers with the menubar.
//
// Subcommands:
//   bun cli.ts menubar install     Build the app + write LaunchAgent + load it
//   bun cli.ts menubar uninstall   Unload + remove plist
//   bun cli.ts menubar status      Show whether it's loaded + current PID
//   bun cli.ts menubar build       (re)build the app without touching launchd

const LABEL = "com.techlabstudio.claude-companion-menubar"
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
const REPO_ROOT = resolve(import.meta.dir, "..")
const MAC_DIR = join(REPO_ROOT, "mac")
const BINARY_PATH = join(MAC_DIR, ".build", "release", "claude-companion-menubar")
const BUNDLE_PATH = join(MAC_DIR, ".build", "release", "Companion.app")
const BUNDLE_BINARY = join(BUNDLE_PATH, "Contents", "MacOS", "Companion")
const BUNDLE_INFO = join(BUNDLE_PATH, "Contents", "Info.plist")
const LOG_PATH = join(homedir(), ".claude-companion", "menubar.log")

const dim = "\x1b[2m"
const reset = "\x1b[0m"
const cyan = "\x1b[36m"
const green = "\x1b[32m"
const yellow = "\x1b[33m"
const red = "\x1b[31m"
const bold = "\x1b[1m"

export async function menubarBuild(): Promise<void> {
  if (!existsSync(MAC_DIR)) {
    console.error(`${red}! mac/ directory missing at ${MAC_DIR}${reset}`)
    process.exit(1)
  }
  console.log(`${dim}building menubar app (release)…${reset}`)
  await runOrThrow(["swift", "build", "-c", "release"], MAC_DIR)
  console.log(`${green}✓${reset} compiled ${dim}${BINARY_PATH}${reset}`)

  // The status item only registers reliably from a real .app bundle on
  // macOS 26+, so wrap the binary in a minimal one with LSUIElement=true.
  mkdirSync(join(BUNDLE_PATH, "Contents", "MacOS"), { recursive: true })
  copyFileSync(BINARY_PATH, BUNDLE_BINARY)
  // Preserve exec bit
  await runOrThrow(["chmod", "+x", BUNDLE_BINARY], MAC_DIR)
  writeFileSync(BUNDLE_INFO, INFO_PLIST)
  // Ad-hoc sign so Gatekeeper allows launchd to spawn it without prompting.
  await runQuiet(["codesign", "--force", "--sign", "-", BUNDLE_PATH])
  console.log(`${green}✓${reset} bundled at ${dim}${BUNDLE_PATH}${reset}`)
}

export async function menubarInstall(): Promise<void> {
  console.log(`${bold}Claude Companion · menubar install${reset}\n`)
  await menubarBuild()

  mkdirSync(dirname(PLIST_PATH), { recursive: true })
  mkdirSync(dirname(LOG_PATH), { recursive: true })
  writeFileSync(PLIST_PATH, renderPlist())
  console.log(`${green}✓${reset} wrote ${dim}${PLIST_PATH}${reset}`)

  // Reload (idempotent on re-install).
  await runQuiet(["launchctl", "unload", PLIST_PATH])
  const loaded = await runOrFail(["launchctl", "load", PLIST_PATH])
  if (!loaded) {
    console.error(`${red}! launchctl load failed${reset}`)
    process.exit(1)
  }
  console.log(`${green}✓${reset} loaded as ${cyan}${LABEL}${reset}`)
  console.log(`${dim}  the menubar icon should appear within a second.${reset}`)
}

export async function menubarUninstall(): Promise<void> {
  console.log(`${bold}Claude Companion · menubar uninstall${reset}\n`)
  if (!existsSync(PLIST_PATH)) {
    console.log(`${yellow}no LaunchAgent installed at ${PLIST_PATH}${reset}`)
    return
  }
  await runQuiet(["launchctl", "unload", PLIST_PATH])
  unlinkSync(PLIST_PATH)
  console.log(`${green}✓${reset} unloaded + removed plist`)
  console.log(`${dim}note: the .app bundle in ${BUNDLE_PATH} is preserved.${reset}`)
}

export async function menubarStatus(): Promise<void> {
  if (!existsSync(BUNDLE_PATH)) {
    console.log(`${dim}Bundle:    ${reset}${yellow}not built${reset}`)
    console.log(`${dim}build with: ${cyan}bun cli.ts menubar build${reset}`)
  } else {
    console.log(`${dim}Bundle:    ${reset}${green}built${reset} ${dim}(${BUNDLE_PATH})${reset}`)
  }
  if (!existsSync(PLIST_PATH)) {
    console.log(`${dim}Agent:     ${reset}${yellow}not installed${reset}`)
    return
  }
  console.log(`${dim}Agent:     ${reset}${green}installed${reset}`)

  const proc = Bun.spawn({ cmd: ["launchctl", "list", LABEL], stdout: "pipe", stderr: "pipe" })
  const text = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    console.log(`${dim}State:     ${reset}${yellow}loaded but not running${reset}`)
    return
  }
  const pidMatch = /"PID"\s*=\s*(\d+)/.exec(text)
  if (pidMatch) {
    console.log(`${dim}State:     ${reset}${green}running${reset} ${dim}(pid ${pidMatch[1]})${reset}`)
  } else {
    console.log(`${dim}State:     ${reset}${yellow}not currently running${reset}`)
  }
}

// MARK: - templates

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Companion</string>
    <key>CFBundleIdentifier</key>
    <string>com.techlabstudio.claude-companion-menubar</string>
    <key>CFBundleName</key>
    <string>Claude Companion</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsLocalNetworking</key>
        <true/>
    </dict>
</dict>
</plist>
`

function renderPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(BUNDLE_BINARY)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(LOG_PATH)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(LOG_PATH)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${escapeXml(homedir())}</string>
    </dict>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
</dict>
</plist>
`
}

// MARK: - helpers

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

async function runOrThrow(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`)
}

async function runOrFail(cmd: string[]): Promise<boolean> {
  const proc = Bun.spawn({ cmd, stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  return code === 0
}

async function runQuiet(cmd: string[]): Promise<void> {
  const proc = Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" })
  await proc.exited
}
