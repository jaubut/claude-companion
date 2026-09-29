// How the hidden /help enumeration (lib/command-offpane.ts) finds claude, and
// what its cache key is made of. Split out so both are testable without tmux.
//
// Launch: the hidden session is a tmux session, so it starts from the tmux
// server's global environment — the same one the user's own tmux sessions do.
// The binary is resolved on THAT PATH once, and the same absolute path is used
// for `--version` (the fingerprint) and for the launch.
//
// Fingerprint: cwd + binary + version + mtimes of every file the list is built
// from, so the cache re-runs only when one of them changed.

import { createHash } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

export interface TmuxResult { code: number; stdout: string }
export type TmuxRunner = (args: string[]) => Promise<TmuxResult>

// Spawn tmux, bounded. A wedged tmux must not hold the enumeration forever; a
// killed call reads as code -1 ("unknown"), never as a real tmux exit code.
export const defaultTmux: TmuxRunner = async (args) => {
  try {
    const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { p.kill() } catch { /* gone */ } }, 5_000)
    try {
      const stdout = await new Response(p.stdout).text()
      const code = await p.exited
      return { code: timedOut ? -1 : code, stdout }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { code: -1, stdout: "" }
  }
}

// How the hidden claude is launched — resolved ONCE per enumeration and used
// for both `--version` (the fingerprint) and the tmux launch, so the two can
// never disagree about which binary they mean.
export interface ClaudeLaunch {
  bin: string                    // absolute path
  env: Record<string, string>    // exported into the hidden session (PATH)
  configDir: string              // the user's config dir: settings/skills/commands/plugins
  configDirExplicit: boolean     // CLAUDE_CONFIG_DIR is set for the user's sessions
  home: string                   // the user's real HOME
}

// ── Resolving claude the way the user's session does ───────────────────────

// Where claude usually lives when the PATH we were given doesn't have it (a
// launchd/systemd server with a bare PATH and no tmux server yet).
function fallbackDirs(home: string): string[] {
  return [join(home, ".local", "bin"), join(home, ".claude", "local"), join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
}

// `tmux show-environment -g`: `NAME=value` lines, `-NAME` for removed ones.
export function parseTmuxEnv(out: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=")
    if (eq <= 0 || line.startsWith("-")) continue
    env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

export interface ResolveDeps {
  tmux: TmuxRunner
  which: (cmd: string, path: string) => string | null
  processEnv: Record<string, string | undefined>
  home: string
}

// The hidden session is a tmux session, so its shell starts from the tmux
// SERVER's global environment — the same one the user's `cc-*`/`claude-*`
// tmux sessions start from. Resolve against that PATH and take
// CLAUDE_CONFIG_DIR from it too: set there → the user's claudes use it; absent
// or explicitly removed (`-CLAUDE_CONFIG_DIR`) → they don't, whatever the
// companion's own env says. Only with no tmux server at all (nothing to ask;
// new-session would then start one from OUR env) does the process env count.
export async function resolveClaudeLaunch(deps: ResolveDeps): Promise<ClaudeLaunch | null> {
  const r = await deps.tmux(["show-environment", "-g"]).catch(() => ({ code: -1, stdout: "" }))
  const tmuxEnv = r.code === 0 ? parseTmuxEnv(r.stdout) : null
  const path = tmuxEnv?.PATH ?? deps.processEnv.PATH ?? ""
  const configDirEnv = tmuxEnv ? tmuxEnv.CLAUDE_CONFIG_DIR : deps.processEnv.CLAUDE_CONFIG_DIR
  const bin = deps.which("claude", path) ?? deps.which("claude", fallbackDirs(deps.home).join(":"))
  if (!bin) return null
  const env: Record<string, string> = {}
  if (path) env.PATH = path
  return {
    bin, env,
    configDir: configDirEnv || join(deps.home, ".claude"),
    configDirExplicit: !!configDirEnv,
    home: deps.home,
  }
}

export const defaultWhich = (cmd: string, path: string): string | null => Bun.which(cmd, { PATH: path }) ?? null

// `<bin> --version` for exactly the binary the hidden session will exec.
const VERSION_TTL_MS = 60_000
const versionMemo = new Map<string, { at: number; value: string }>()
export async function claudeVersion(launch: ClaudeLaunch, now = Date.now()): Promise<string> {
  const memo = versionMemo.get(launch.bin)
  if (memo && now - memo.at < VERSION_TTL_MS) return memo.value
  let value = "unknown"
  try {
    const p = Bun.spawn([launch.bin, "--version"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, ...launch.env } })
    const timer = setTimeout(() => { try { p.kill() } catch { /* gone */ } }, 5_000)
    const out = (await new Response(p.stdout).text()).trim()
    clearTimeout(timer)
    if ((await p.exited) === 0 && out) value = out
  } catch { /* unknown */ }
  versionMemo.set(launch.bin, { at: now, value })
  return value
}

// ── Fingerprint ────────────────────────────────────────────────────────────

// Every file the command list is built from. Directories are walked (depth-
// bounded — skills are `<name>/SKILL.md`, commands may be namespaced one or
// two levels deep); each matching file contributes its path and mtime, so an
// added, removed, renamed or edited skill/command moves the fingerprint.
// Directory mtimes are deliberately NOT included: claude rewrites
// ~/.claude/skills/synced/<id>/ (claude.ai-synced skills) on every start, so
// the hidden session itself would invalidate the cache it just filled.
const WALK_DEPTH = 4
const MAX_ENTRIES = 5_000

export interface FingerprintSources {
  walk: Array<{ dir: string; match: (name: string) => boolean }>
  files: string[]
}

export function fingerprintSources(cwd: string, configDir: string): FingerprintSources {
  const skill = (n: string) => n === "SKILL.md"
  const command = (n: string) => n.endsWith(".md")
  const project = join(cwd, ".claude")
  return {
    walk: [
      { dir: join(configDir, "skills"), match: skill },
      { dir: join(configDir, "commands"), match: command },
      { dir: join(project, "skills"), match: skill },
      { dir: join(project, "commands"), match: command },
    ],
    files: [
      join(configDir, "settings.json"),
      join(configDir, "settings.local.json"),
      join(configDir, "plugins", "installed_plugins.json"),
      join(project, "settings.json"),
      join(project, "settings.local.json"),
    ],
  }
}

async function mtimeOf(path: string): Promise<string> {
  try { return String((await stat(path)).mtimeMs) } catch { return "-" }
}

async function walkMtimes(dir: string, match: (name: string) => boolean, depth: number, out: string[]): Promise<void> {
  if (out.length >= MAX_ENTRIES || depth < 0) return
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    if (out.length >= MAX_ENTRIES) return
    const path = join(dir, e.name)
    // Skills are often symlinked in: follow the link to see what it is.
    const isDir = e.isDirectory() || (e.isSymbolicLink() && await stat(path).then((s) => s.isDirectory(), () => false))
    if (isDir) { if (depth > 0) await walkMtimes(path, match, depth - 1, out) }
    else if (match(e.name)) out.push(`${path}:${await mtimeOf(path)}`)
  }
}

export async function fingerprintEntries(cwd: string, configDir: string): Promise<string[]> {
  const src = fingerprintSources(cwd, configDir)
  const out: string[] = []
  for (const w of src.walk) await walkMtimes(w.dir, w.match, WALK_DEPTH, out)
  for (const f of src.files) out.push(`${f}:${await mtimeOf(f)}`)
  return out
}

export async function computeFingerprint(cwd: string, launch: ClaudeLaunch, version: string): Promise<string> {
  const h = createHash("sha1")
  for (const e of await fingerprintEntries(cwd, launch.configDir)) h.update(e).update("\n")
  return [cwd, launch.bin, version, h.digest("hex")].join("|")
}
