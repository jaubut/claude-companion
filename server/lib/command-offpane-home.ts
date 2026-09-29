// A throwaway HOME for the hidden /help enumeration claude (lib/command-offpane.ts).
//
// Measured on 2.1.284 (see PR body): booting claude and typing /help writes
//   - ~/.claude.json      numStartups, projects[cwd].lastGracefulShutdown,
//                         cached feature flags, changelogLastFetched
//   - ~/.claude/history.jsonl   a "/help" line (the user's ↑ history)
//   - ~/.claude/sessions/<pid>.json   (ps-discovery reads these)
//   - ~/.claude/{teams,tasks,backups,cache}/…
// The user's own claudes write ~/.claude.json all day; a second writer racing
// them can lose their state. So the hidden claude never sees the real files:
// HOME points at a private 0700 temp dir holding
//   - a COPY of the user's .claude.json (onboarding done, project trust, the
//     cached feature flags built-ins depend on) — written to, then deleted;
//   - symlinks to exactly what the list is built from: skills, commands,
//     plugins, agents, output-styles, settings.json, settings.local.json;
//   - on macOS a symlink to ~/Library (keychain / preferences lookups).
// Credentials are NOT symlinked (claude refuses a symlinked
// .credentials.json): CLAUDE_SECURESTORAGE_CONFIG_DIR points secure storage
// at the real config dir, so Linux reads the real file and macOS derives the
// same keychain item name the user's sessions use.
//
// The dir is `<tmp>/cc-scrape-homes/<session name>`: the reaper can map an
// orphaned session back to its home and delete both.

import { copyFile, lstat, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const SCRAPE_HOMES_DIR = join(tmpdir(), "cc-scrape-homes")

// Linked read-through from the user's config dir, when present.
export const LINKED_CONFIG_ENTRIES = [
  "skills", "commands", "plugins", "agents", "output-styles", "settings.json", "settings.local.json",
] as const

export interface ScrapeHomeSource {
  home: string                 // the user's real HOME
  configDir: string            // the user's real config dir (~/.claude or $CLAUDE_CONFIG_DIR)
  configDirExplicit: boolean   // CLAUDE_CONFIG_DIR was set for the user's sessions
  platform: NodeJS.Platform
}

export interface ScrapeHome {
  root: string
  env: Record<string, string>  // exported into the hidden session
  unset: string[]              // unset in the hidden session
}

export function scrapeHomePath(sessionName: string, base = SCRAPE_HOMES_DIR): string {
  return join(base, sessionName)
}

// Where the user's global config lives: $CLAUDE_CONFIG_DIR/.claude.json when
// the config dir is explicit, ~/.claude.json otherwise.
export function globalConfigPath(src: Pick<ScrapeHomeSource, "home" | "configDir" | "configDirExplicit">): string {
  return src.configDirExplicit ? join(src.configDir, ".claude.json") : join(src.home, ".claude.json")
}

const exists = (p: string) => lstat(p).then(() => true, () => false)

export async function createScrapeHome(sessionName: string, src: ScrapeHomeSource, base = SCRAPE_HOMES_DIR): Promise<ScrapeHome> {
  await mkdir(base, { recursive: true, mode: 0o700 })
  const root = scrapeHomePath(sessionName, base)
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { mode: 0o700 })
  const cfg = join(root, ".claude")
  await mkdir(cfg, { mode: 0o700 })

  for (const name of LINKED_CONFIG_ENTRIES) {
    const target = join(src.configDir, name)
    if (await exists(target)) await symlink(target, join(cfg, name))
  }
  if (src.platform === "darwin") {
    const lib = join(src.home, "Library")
    if (await exists(lib)) await symlink(lib, join(root, "Library"))
  }
  // A copy, never a link: this is the file the hidden boot writes.
  const globalCfg = globalConfigPath(src)
  const copyTo = src.configDirExplicit ? join(cfg, ".claude.json") : join(root, ".claude.json")
  if (await exists(globalCfg)) await copyFile(globalCfg, copyTo)

  const env: Record<string, string> = { HOME: root }
  const unset: string[] = []
  if (src.configDirExplicit) env.CLAUDE_CONFIG_DIR = cfg
  else unset.push("CLAUDE_CONFIG_DIR")
  // macOS without an explicit config dir: the keychain item has no suffix,
  // which is what an UNSET secure-storage dir gives. Everywhere else, point
  // it at the real config dir (Linux: the real .credentials.json; macOS with
  // CLAUDE_CONFIG_DIR: the same hashed keychain name).
  if (src.configDirExplicit || src.platform !== "darwin") env.CLAUDE_SECURESTORAGE_CONFIG_DIR = src.configDir
  else unset.push("CLAUDE_SECURESTORAGE_CONFIG_DIR")
  return { root, env, unset }
}

// fs.rm never follows symlinks: the linked skills/plugins/Library are untouched.
export async function removeScrapeHome(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}
