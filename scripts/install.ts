import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { getAuthToken } from "../server/lib/auth"

// One-shot installer for Claude Companion.
//
// Replaces the README's seven manual setup steps with `bun cli.ts init`:
//   1. (optional) build the React client if dist/ is missing
//   2. copy hook scripts to ~/.claude/hooks/, +x
//   3. patch ~/.claude/settings.json — append companion entries to each
//      Claude Code hook event, preserving any non-companion hooks the user
//      has already configured. Idempotent.
//   4. print the pairing URL + bearer token so the user can paste into iOS.
//
// Reversible via `bun cli.ts uninstall`. Both commands always backup
// settings.json before writing.

const REPO_ROOT = resolve(import.meta.dir, "..")
const HOOKS_SRC = join(REPO_ROOT, "hooks")
const HOOKS_DST = join(homedir(), ".claude", "hooks")
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json")
const CLIENT_DIST = join(REPO_ROOT, "client", "dist", "index.html")

const dim = "\x1b[2m"
const reset = "\x1b[0m"
const cyan = "\x1b[36m"
const green = "\x1b[32m"
const yellow = "\x1b[33m"
const red = "\x1b[31m"
const bold = "\x1b[1m"

interface HookSpec {
  event: string
  matcher?: string
  script: string
  timeout?: number
}

const HOOKS: HookSpec[] = [
  { event: "PreToolUse", matcher: "Bash|Edit|Write|MultiEdit", script: "companion-approval.sh", timeout: 300 },
  { event: "PermissionRequest", script: "companion-permission.sh", timeout: 300 },
  { event: "PostToolUse", script: "companion-post-tool-use.sh" },
  { event: "UserPromptSubmit", script: "companion-user-prompt.sh" },
  { event: "Stop", script: "companion-stop.sh" },
  { event: "SessionStart", script: "companion-session-start.sh" },
  { event: "SessionEnd", script: "companion-session-end.sh" },
]

// _lib.sh is sourced by every hook script and isn't an event handler, but it
// still needs to land in HOOKS_DST or the scripts won't run.
const SUPPORT_SCRIPTS = ["_lib.sh"]

export async function init(): Promise<void> {
  console.log(`${bold}Claude Companion · install${reset}\n`)
  await ensureClientBuilt()
  copyHooks()
  patchSettings()
  printPairing()
  console.log(`\n${green}Done.${reset} Start the server: ${cyan}bun ${join(REPO_ROOT, "cli.ts")}${reset}`)
}

async function ensureClientBuilt(): Promise<void> {
  if (existsSync(CLIENT_DIST)) {
    console.log(`${dim}✓ client/dist already built${reset}`)
    return
  }
  console.log(`${dim}building client (this can take a minute on first run)…${reset}`)
  const clientDir = join(REPO_ROOT, "client")
  await runOrThrow(["bun", "install"], clientDir)
  await runOrThrow(["bun", "run", "build"], clientDir)
  console.log(`${green}✓${reset} client built`)
}

async function runOrThrow(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" })
  const code = await proc.exited
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited with code ${code}`)
}

function copyHooks(): void {
  if (!existsSync(HOOKS_SRC)) {
    console.error(`${red}! hooks source missing: ${HOOKS_SRC}${reset}`)
    process.exit(1)
  }
  mkdirSync(HOOKS_DST, { recursive: true })
  let copied = 0
  for (const spec of HOOKS) {
    if (copyOne(spec.script)) copied++
  }
  for (const support of SUPPORT_SCRIPTS) {
    copyOne(support)
  }
  console.log(`${green}✓${reset} installed ${copied} hook scripts → ${dim}${HOOKS_DST}${reset}`)
}

function copyOne(name: string): boolean {
  const src = join(HOOKS_SRC, name)
  const dst = join(HOOKS_DST, name)
  if (!existsSync(src)) {
    console.log(`${yellow}  ! source missing: ${name} — skipping${reset}`)
    return false
  }
  copyFileSync(src, dst)
  chmodSync(dst, 0o755)
  return true
}

// Mutates ~/.claude/settings.json:
//   - For each event in HOOKS, append a matcher block referencing the
//     installed script — but only if no existing block already references
//     the same destination path. Re-runs are no-ops.
//   - Backs up the original before writing.
//   - Refuses to touch the file if it isn't valid JSON.
function patchSettings(): void {
  const existed = existsSync(SETTINGS_PATH)
  let settings: SettingsShape = {}
  let raw = ""

  if (existed) {
    raw = readFileSync(SETTINGS_PATH, "utf8")
    try {
      settings = JSON.parse(raw)
    } catch {
      console.error(`${red}! ${SETTINGS_PATH} is not valid JSON — refusing to clobber${reset}`)
      console.error(`  Fix or remove the file, then re-run init.`)
      process.exit(1)
    }
    const backup = `${SETTINGS_PATH}.bak.${Date.now()}`
    writeFileSync(backup, raw)
    console.log(`${dim}backed up settings.json → ${backup}${reset}`)
  } else {
    mkdirSync(join(homedir(), ".claude"), { recursive: true })
  }

  if (!settings.hooks) settings.hooks = {}

  let added = 0
  let kept = 0
  for (const spec of HOOKS) {
    const dstScript = join(HOOKS_DST, spec.script)
    const eventArr = (settings.hooks[spec.event] ??= [])

    const alreadyHas = eventArr.some(
      (block) =>
        Array.isArray(block?.hooks) &&
        block.hooks.some((h) => h?.command === dstScript),
    )

    if (alreadyHas) {
      kept++
      continue
    }

    const hookEntry: HookEntry = { type: "command", command: dstScript }
    if (spec.timeout) hookEntry.timeout = spec.timeout
    const block: MatcherBlock = { hooks: [hookEntry] }
    if (spec.matcher) block.matcher = spec.matcher
    eventArr.push(block)
    added++
  }

  atomicWriteJSON(SETTINGS_PATH, settings)

  if (existed) {
    console.log(
      `${green}✓${reset} patched settings.json — added ${added} hook${added === 1 ? "" : "s"}, ${kept} already present`,
    )
  } else {
    console.log(`${green}✓${reset} created settings.json — added ${added} hook${added === 1 ? "" : "s"}`)
  }
}

function printPairing(): void {
  const token = getAuthToken()
  console.log()
  console.log(`${bold}Pairing${reset}`)
  console.log(`  ${dim}URL  ${reset} http://<your-mac>:4245`)
  console.log(`  ${dim}Token${reset} ${cyan}${token}${reset}`)
  console.log(`  ${dim}Paste both into the iOS app's Settings screen.${reset}`)
}

export async function uninstall(): Promise<void> {
  console.log(`${bold}Claude Companion · uninstall${reset}\n`)

  if (!existsSync(SETTINGS_PATH)) {
    console.log(`${yellow}no settings.json found — nothing to remove${reset}`)
    return
  }

  const raw = readFileSync(SETTINGS_PATH, "utf8")
  let settings: SettingsShape
  try {
    settings = JSON.parse(raw)
  } catch {
    console.error(`${red}! settings.json is not valid JSON — refusing to touch${reset}`)
    process.exit(1)
  }

  const backup = `${SETTINGS_PATH}.bak.${Date.now()}`
  writeFileSync(backup, raw)
  console.log(`${dim}backed up settings.json → ${backup}${reset}`)

  let removed = 0
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      const arr = settings.hooks[event]
      if (!Array.isArray(arr)) continue

      const trimmed: MatcherBlock[] = []
      for (const block of arr) {
        if (!block?.hooks || !Array.isArray(block.hooks)) {
          trimmed.push(block)
          continue
        }
        const before = block.hooks.length
        const remainingHooks = block.hooks.filter((h) => !isCompanionHook(h))
        removed += before - remainingHooks.length
        if (remainingHooks.length > 0) {
          trimmed.push({ ...block, hooks: remainingHooks })
        }
      }
      settings.hooks[event] = trimmed
      if (trimmed.length === 0) {
        delete settings.hooks[event]
      }
    }
  }

  atomicWriteJSON(SETTINGS_PATH, settings)
  console.log(`${green}✓${reset} removed ${removed} companion hook entr${removed === 1 ? "y" : "ies"}`)
  console.log(`${dim}note: scripts in ~/.claude/hooks/ are left in place; delete manually if desired.${reset}`)
  console.log(`${dim}note: ~/.claude-companion/auth.token is preserved for re-install.${reset}`)
}

export function printToken(): void {
  printPairing()
}

// MARK: - helpers

interface HookEntry {
  type: "command"
  command: string
  timeout?: number
}

interface MatcherBlock {
  matcher?: string
  hooks: HookEntry[]
}

interface SettingsShape {
  hooks?: Record<string, MatcherBlock[]>
  [key: string]: unknown
}

function isCompanionHook(h: HookEntry | unknown): boolean {
  if (typeof h !== "object" || h === null) return false
  const cmd = (h as HookEntry).command
  if (typeof cmd !== "string") return false
  // Match the script-name pattern rather than the full path so installs
  // moved between machines (or symlinked) still get cleaned up.
  return /\/companion-[a-z-]+\.sh$/.test(cmd)
}

function atomicWriteJSON(path: string, value: unknown): void {
  const out = JSON.stringify(value, null, 2) + "\n"
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, out)
  renameSync(tmp, path)
}
