// SUPER auto-approval mode — when on, every PreToolUse decision is allowed
// without phone roundtrip, EXCEPT for a tiny denylist of patterns that would
// be catastrophic to auto-approve (rm -rf /, force-push to main, DROP TABLE,
// fork bombs, dd to /dev, etc.). Those still bounce to the phone.
//
// State lives in `~/.claude-companion/super-auto.flag` (presence = enabled)
// so it survives server restarts. Toggle via /api/super-auto from the iOS
// app or by `touch`/`rm`-ing the file from a shell.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

const FLAG_PATH = join(homedir(), ".claude-companion", "super-auto.flag")

let cached: boolean = existsSync(FLAG_PATH)

export function isSuperAuto(): boolean {
  return cached
}

export function setSuperAuto(enabled: boolean): boolean {
  cached = enabled
  try {
    if (enabled) {
      mkdirSync(dirname(FLAG_PATH), { recursive: true })
      writeFileSync(FLAG_PATH, String(Date.now()))
    } else if (existsSync(FLAG_PATH)) {
      unlinkSync(FLAG_PATH)
    }
  } catch (err) {
    process.stderr.write(`[companion] super-auto persist failed: ${String(err)}\n`)
  }
  return cached
}

// Patterns that are NEVER auto-approved, even in SUPER mode. Conservative
// list — only operations that are irreversible AND impossible to issue
// "by accident" in a normal Claude turn (so Claude proposing one is itself
// a strong signal something is off and the human should look).
const CATASTROPHIC_BASH: RegExp[] = [
  // Recursive delete of root, $HOME, /Users/, /System, /Library, /private
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f?\b[^|;&]*\s+(\/|~\/?$|\$HOME|\/Users\/?(?:\s|$)|\/System\/|\/Library\/|\/private\/)/,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]?\b[^|;&]*\s+(\/|~\/?$|\$HOME|\/Users\/?(?:\s|$)|\/System\/|\/Library\/|\/private\/)/,
  // sudo rm — privilege escalation + delete is always a stop-and-think
  /\bsudo\s+rm\b/,
  // Force push to protected branches
  /\bgit\s+push\s+[^|;&]*(--force|-f)\b[^|;&]*\b(main|master|production|prod|release)\b/i,
  /\bgit\s+push\s+[^|;&]*\b(main|master|production|prod|release)\b[^|;&]*(--force|-f)\b/i,
  // Database obliteration
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  // Raw disk writes
  /\bdd\s+[^|;&]*\bof=\/dev\//i,
  /\bmkfs\./i,
  // Classic fork bomb
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // chmod world-writable on system roots
  /\bchmod\s+-R\s+(777|a\+w)\s+(\/|\/Users\/?$|\/System|\/Library)/,
  // curl-pipe-to-shell from non-localhost — auto-running unaudited code
  /\bcurl\s+[^|]*\bhttps?:\/\/(?!localhost|127\.0\.0\.1)[^\s|]+[^|]*\|\s*(sh|bash|zsh)\b/,
]

function isShellTool(tool: string): boolean {
  return tool === "Bash" || tool === "shell" || tool === "unified_exec" || tool === "exec_command"
}

export function isCatastrophic(tool: string, input: Record<string, unknown>): boolean {
  if (isShellTool(tool)) {
    const cmd = String(input.command ?? input.cmd ?? "")
    return CATASTROPHIC_BASH.some(re => re.test(cmd))
  }
  return false
}
