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
import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export interface TmuxResult { code: number; stdout: string; stderr?: string }

// tmux exits 1 with this when no server is running on the socket — i.e. every
// session is gone (the last one closing takes the server with it). That is a
// complete, empty inventory, unlike any other failure.
export function tmuxNoServer(r: TmuxResult): boolean {
  // Only a missing server/socket counts — "error connecting to … (Operation
  // not permitted)" and friends are failures, not an empty inventory.
  const err = r.stderr ?? ""
  return r.code === 1 && (/no server running/i.test(err) || /error connecting to .*\(No such file or directory\)/i.test(err))
}
export type TmuxRunner = (args: string[]) => Promise<TmuxResult>

// Spawn tmux, bounded. A wedged tmux must not hold the enumeration forever; a
// killed call reads as code -1 ("unknown"), never as a real tmux exit code.
export const defaultTmux: TmuxRunner = async (args) => {
  try {
    const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { p.kill() } catch { /* gone */ } }, 5_000)
    try {
      const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      const code = await p.exited
      return { code: timedOut ? -1 : code, stdout, stderr }
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

// Claude Code also loads project skills/commands from every ancestor's
// .claude/ (monorepo packages) and, in a linked git worktree, from the main
// worktree's — so those move the fingerprint too. The user config dir is
// already walked; an ancestor whose .claude IS it is skipped.
export function fingerprintSources(cwd: string, configDir: string, extraRoots: string[] = []): FingerprintSources {
  const skill = (n: string) => n === "SKILL.md"
  const command = (n: string) => n.endsWith(".md")
  const project = join(cwd, ".claude")
  const roots: string[] = []
  for (let dir = dirname(resolve(cwd)); ; dir = dirname(dir)) {
    if (join(dir, ".claude") !== resolve(configDir)) roots.push(dir)
    if (dirname(dir) === dir) break
  }
  for (const r of extraRoots) if (!roots.includes(r) && resolve(r) !== resolve(cwd)) roots.push(r)
  return {
    walk: [
      { dir: join(configDir, "skills"), match: skill },
      { dir: join(configDir, "commands"), match: command },
      { dir: join(project, "skills"), match: skill },
      { dir: join(project, "commands"), match: command },
      ...roots.flatMap((r) => [
        { dir: join(r, ".claude", "skills"), match: skill },
        { dir: join(r, ".claude", "commands"), match: command },
      ]),
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

// In a linked worktree, `.git` is a file: "gitdir: <main>/.git/worktrees/<n>".
// Returns the main worktree's root, or null.
export async function mainWorktreeRoot(cwd: string): Promise<string | null> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotgit = join(dir, ".git")
    const st = await stat(dotgit).catch(() => null)
    if (st?.isDirectory()) return null
    if (st?.isFile()) {
      const m = (await readFile(dotgit, "utf8").catch(() => "")).match(/^gitdir:\s*(.+)$/m)
      const gitdir = m?.[1]?.trim()
      if (!gitdir) return null
      const abs = resolve(dir, gitdir)
      const i = abs.lastIndexOf(`${"/"}.git${"/"}worktrees${"/"}`)
      return i >= 0 ? abs.slice(0, i) : null
    }
    if (dirname(dir) === dir) return null
  }
}

export async function fingerprintEntries(cwd: string, configDir: string): Promise<string[]> {
  const main = await mainWorktreeRoot(cwd)
  const src = fingerprintSources(cwd, configDir, main ? [main] : [])
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

// ── Secure storage (credentials) for the throwaway HOME ────────────────────

// The throwaway HOME (lib/command-offpane-home.ts) reaches the user's
// credentials through CLAUDE_SECURESTORAGE_CONFIG_DIR, which claude honours
// from 2.1.284. It is needed on Linux (the real .credentials.json) and on
// macOS with an explicit CLAUDE_CONFIG_DIR (the hashed keychain item name).
// An older claude ignores it and boots to the login screen — the enumeration
// is refused up front instead (Zettlab ran 2.1.281 when this landed).
export const SECURE_STORAGE_MIN_VERSION = "2.1.284"

// "2.1.284 (Claude Code)" → [2, 1, 284]; anything else → null.
export function parseClaudeVersion(text: string): number[] | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

export function versionAtLeast(text: string, min: string): boolean {
  const v = parseClaudeVersion(text)
  const want = parseClaudeVersion(min)
  if (!v || !want) return false
  for (let i = 0; i < 3; i++) {
    if (v[i]! !== want[i]!) return v[i]! > want[i]!
  }
  return true
}

export function needsSecureStorageDir(launch: Pick<ClaudeLaunch, "configDirExplicit">, platform: NodeJS.Platform): boolean {
  return platform !== "darwin" || launch.configDirExplicit
}

// null = fine to launch; otherwise why not. An unreadable version counts as
// too old wherever the variable is needed: spawning blind would land on login.
export function secureStorageProblem(launch: Pick<ClaudeLaunch, "bin" | "configDirExplicit">, version: string, platform: NodeJS.Platform): string | null {
  if (!needsSecureStorageDir(launch, platform)) return null
  if (versionAtLeast(version, SECURE_STORAGE_MIN_VERSION)) return null
  return `claude ${version} at ${launch.bin} is older than ${SECURE_STORAGE_MIN_VERSION} — update claude to ≥${SECURE_STORAGE_MIN_VERSION} for off-pane command list`
}
