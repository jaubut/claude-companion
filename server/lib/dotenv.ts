import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Minimal .env loader. Populates process.env for keys that aren't already
// present in the shell environment. Used by both the main server entry
// (cli.ts) and standalone scripts (scripts/push-test.ts) so they share the
// same config file (~/.claude-companion/.env).
//
// Why not Bun's auto-load? Bun only auto-loads .env from CWD, which makes
// behaviour depend on where you launched Bun from. This loader uses an
// absolute, stable path instead.
export function loadDefaultDotEnv(): void {
  loadDotEnv(join(homedir(), ".claude-companion", ".env"))
}

export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return
  const raw = readFileSync(path, "utf8")
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!key || process.env[key] != null) continue
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    process.env[key] = val
  }
}
