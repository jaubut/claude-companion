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
//   - a COPY (0600) of the user's .claude.json (onboarding done, project trust,
//     the cached feature flags built-ins depend on) — written to, then deleted;
//   - symlinks to exactly what the list is built from: skills, commands,
//     plugins, agents, output-styles, settings.json, settings.local.json;
//   - on macOS a symlink to ~/Library (keychain / preferences lookups).
// Credentials are NOT symlinked (claude refuses a symlinked
// .credentials.json): CLAUDE_SECURESTORAGE_CONFIG_DIR points secure storage
// at the real config dir, so Linux reads the real file and macOS derives the
// same keychain item name the user's sessions use (needs claude ≥ 2.1.284 —
// see command-offpane-launch.ts `secureStorageSupported`).
//
// cwd == the user's real HOME: launched there, the hidden claude (HOME = the
// throwaway dir) would read the REAL ~/.claude as PROJECT config on top of the
// user-level symlinks — every skill listed twice, and project-state writes
// landing in the real ~/.claude. So it is launched in the throwaway HOME
// itself instead: cwd == HOME again, exactly the user's situation, and the
// real ~/.claude loads once, through the symlinks. The copied .claude.json gets
// the home's project entry (trust) under the throwaway path.
//
// Where the throwaway dirs live — never a fixed, guessable /tmp path:
//   - $XDG_RUNTIME_DIR/cc-scrape-homes when XDG_RUNTIME_DIR is a real dir
//     owned by us with no group/other access (systemd's /run/user/<uid>);
//   - else one fs.mkdtemp dir per server process under os.tmpdir()
//     (`cc-scrape-homes-<pid>-XXXXXX`).
// Every dir is lstat-verified (ours, 0700, not a symlink) before anything is
// copied into it; a pre-created foreign or symlinked base is refused.

import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Linked read-through from the user's config dir, when present.
export const LINKED_CONFIG_ENTRIES = [
  "skills", "commands", "plugins", "agents", "output-styles", "settings.json", "settings.local.json",
] as const

export const HOMES_DIR_NAME = "cc-scrape-homes"
const MKDTEMP_PREFIX = `${HOMES_DIR_NAME}-`

export interface ScrapeHomeSource {
  home: string                 // the user's real HOME
  configDir: string            // the user's real config dir (~/.claude or $CLAUDE_CONFIG_DIR)
  configDirExplicit: boolean   // CLAUDE_CONFIG_DIR was set for the user's sessions
  platform: NodeJS.Platform
  cwd: string                  // the session's cwd (what the list is for)
}

export interface ScrapeHome {
  root: string
  cwd: string                  // where the hidden claude is launched
  env: Record<string, string>  // exported into the hidden session
  unset: string[]              // unset in the hidden session
}

// ── Private directories ────────────────────────────────────────────────────

export class UnsafeDirError extends Error {}

const myUid = (): number => process.getuid?.() ?? -1

// Ours, a real directory (not a symlink), no group/other access.
export async function verifyPrivateDir(path: string, uid = myUid()): Promise<void> {
  const st = await lstat(path)
  if (st.isSymbolicLink()) throw new UnsafeDirError(`${path} is a symlink`)
  if (!st.isDirectory()) throw new UnsafeDirError(`${path} is not a directory`)
  if (uid >= 0 && st.uid !== uid) throw new UnsafeDirError(`${path} is owned by uid ${st.uid}, not ${uid}`)
  if ((st.mode & 0o077) !== 0) throw new UnsafeDirError(`${path} has mode ${(st.mode & 0o777).toString(8)}, want 700`)
}

const isErrno = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code

// mkdir 0700 (never recursive, so no parent is created with our umask), then
// verify. An existing dir is accepted only if it passes the same check.
async function ensurePrivateDir(path: string, uid: number): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (err) {
    if (!isErrno(err, "EEXIST")) throw err
  }
  await verifyPrivateDir(path, uid)
}

export interface BaseOptions {
  env?: Record<string, string | undefined>
  tmp?: string
  uid?: number
  pid?: number
}

// XDG_RUNTIME_DIR itself must be private and ours to be used at all; if it is
// not, fall back to mkdtemp. Its cc-scrape-homes subdir, once we pick XDG,
// must pass the check or the base is REFUSED (someone pre-created it).
export async function resolveHomesBase(opts: BaseOptions = {}): Promise<string> {
  const env = opts.env ?? process.env
  const uid = opts.uid ?? myUid()
  const xdg = env.XDG_RUNTIME_DIR
  if (xdg) {
    const usable = await verifyPrivateDir(xdg, uid).then(() => true, () => false)
    if (usable) {
      const base = join(xdg, HOMES_DIR_NAME)
      await ensurePrivateDir(base, uid)
      return base
    }
  }
  const base = await mkdtemp(join(opts.tmp ?? tmpdir(), `${MKDTEMP_PREFIX}${opts.pid ?? process.pid}-`))
  await verifyPrivateDir(base, uid)
  return base
}

// One base per server process, re-verified on every use (a tmp cleaner may
// have removed a mkdtemp base; a new one is made then).
let baseMemo: Promise<string> | null = null
export async function currentHomesBase(): Promise<string> {
  if (baseMemo) {
    const base = await baseMemo.catch(() => null)
    if (base && await verifyPrivateDir(base).then(() => true, () => false)) return base
  }
  baseMemo = resolveHomesBase()
  return baseMemo
}

// The base this process uses, if one was made (the reaper never creates one).
export async function knownHomesBase(): Promise<string | null> {
  return baseMemo ? baseMemo.catch(() => null) : null
}

// ── The throwaway HOME ─────────────────────────────────────────────────────

// Where the user's global config lives: $CLAUDE_CONFIG_DIR/.claude.json when
// the config dir is explicit, ~/.claude.json otherwise.
export function globalConfigPath(src: Pick<ScrapeHomeSource, "home" | "configDir" | "configDirExplicit">): string {
  return src.configDirExplicit ? join(src.configDir, ".claude.json") : join(src.home, ".claude.json")
}

const exists = (p: string) => lstat(p).then(() => true, () => false)
const real = (p: string) => realpath(p).catch(() => p)

export async function isRealHome(cwd: string, home: string): Promise<boolean> {
  return (await real(cwd)) === (await real(home))
}

// The copy of .claude.json, with the home's project entry duplicated under the
// throwaway root when the hidden claude is launched there (trust carries over).
// Keyed by the path AND its realpath: claude keys projects by the resolved
// path (macOS tmpdir /var/folders/… is really /private/var/folders/…).
function remapHomeProject(raw: string, homeKeys: string[], rootKeys: string[]): string {
  try {
    const cfg = JSON.parse(raw) as { projects?: Record<string, unknown> }
    const entry = homeKeys.map((k) => cfg.projects?.[k]).find((e) => e !== undefined)
    if (!entry) return raw
    cfg.projects = { ...cfg.projects }
    for (const k of rootKeys) cfg.projects[k] = entry
    return JSON.stringify(cfg, null, 2)
  } catch {
    return raw
  }
}

export async function createScrapeHome(sessionName: string, src: ScrapeHomeSource, base?: string, uid = myUid()): Promise<ScrapeHome> {
  const dir = base ?? await currentHomesBase()
  await verifyPrivateDir(dir, uid)
  const root = join(dir, sessionName)
  // rm never follows a symlink: a stale entry of this name is removed, not its target.
  await rm(root, { recursive: true, force: true })
  await mkdir(root, { mode: 0o700 })
  await verifyPrivateDir(root, uid)
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

  const atHome = await isRealHome(src.cwd, src.home)
  // A copy, never a link: this is the file the hidden boot writes. 0600 and
  // O_EXCL ("wx"): never through something already sitting at that path.
  const globalCfg = globalConfigPath(src)
  const copyTo = src.configDirExplicit ? join(cfg, ".claude.json") : join(root, ".claude.json")
  const raw = await readFile(globalCfg, "utf8").catch(() => null)
  if (raw !== null) {
    const body = atHome ? remapHomeProject(raw, [src.home, await real(src.home)], [...new Set([root, await real(root)])]) : raw
    await writeFile(copyTo, body, { mode: 0o600, flag: "wx" })
  }

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
  return { root, cwd: atHome ? await real(root) : src.cwd, env, unset }
}

// fs.rm never follows symlinks: the linked skills/plugins/Library are untouched.
export async function removeScrapeHome(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

// ── Orphan sweep ───────────────────────────────────────────────────────────

export interface SweepOptions {
  keep: (name: string) => boolean        // live / tracked session names
  reapable: (name: string) => boolean    // session name whose owner is us or dead
  ownerDead: (pid: number) => boolean    // for whole mkdtemp bases
  selfPid: number
  env?: Record<string, string | undefined>
  tmp?: string
  uid?: number
}

// Homes left by a crashed server: inside the shared XDG base (by session
// name) and inside our own base; and whole mkdtemp bases of dead servers.
// Only dirs that verify as ours are touched.
export async function sweepOrphanHomes(opts: SweepOptions): Promise<void> {
  const uid = opts.uid ?? myUid()
  const env = opts.env ?? process.env
  const bases = new Set<string>()
  const own = await knownHomesBase()
  if (own) bases.add(own)
  if (env.XDG_RUNTIME_DIR) bases.add(join(env.XDG_RUNTIME_DIR, HOMES_DIR_NAME))
  for (const base of bases) {
    if (!(await verifyPrivateDir(base, uid).then(() => true, () => false))) continue
    let names: string[] = []
    try { names = await readdir(base) } catch { continue }
    for (const name of names) {
      if (opts.keep(name) || !opts.reapable(name)) continue
      await removeScrapeHome(join(base, name)).catch(() => undefined)
    }
  }
  const tmp = opts.tmp ?? tmpdir()
  let entries: string[] = []
  try { entries = await readdir(tmp) } catch { return }
  for (const e of entries) {
    const m = e.match(/^cc-scrape-homes-(\d+)-[A-Za-z0-9]+$/)
    if (!m) continue
    const pid = Number(m[1])
    if (pid === opts.selfPid || !opts.ownerDead(pid)) continue
    const path = join(tmp, e)
    if (!(await verifyPrivateDir(path, uid).then(() => true, () => false))) continue
    await removeScrapeHome(path).catch(() => undefined)
  }
}

// Tests only.
export function resetHomesBase(): void {
  baseMemo = null
}
