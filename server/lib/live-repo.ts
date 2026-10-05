import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ShFn } from "./resolver-fix"

// The project → repo table (REPO_MAP), read as text, read-only, from
// claude-config's tools: `repo-map.ts` (claude-config #21 moved it there:
// `{ name, match: /re/flags, path: `${home}/dir`, project }`), or, on an older
// checkout, `dispatch-run.ts` (`{ match, path: `${HOME}/dir` }`). Neither is
// imported (dispatch-run runs on import; repo-map.ts lives outside this repo).
// First entry whose match hits AND whose directory exists on this host wins —
// dispatch-run's own rule. Used by live-mode cwd, the resolver's checkout
// lookup and the brain's project catalog.
//
// `requires: ["xcode"]` (claude-config, 2026-10-05) marks the iOS/macOS apps:
// code for them runs only on a host with macOS + xcodebuild (the Mac). Here,
// an Xcode repo on a host without Xcode counts as "no local checkout" for the
// resolver's fix run (→ forwarded to the Mac peer) and as `no_cwd` for live
// mode, even when a clone exists on this host.

export interface RepoEntry { match: RegExp; path: string; name?: string; project?: string; requires?: string[] }

const toolsDir = (): string => join(process.env.HOME || homedir(), ".claude", "tools")

/**
 * Where REPO_MAP is read from, in order. `COMPANION_REPO_MAP` pins one file;
 * `COMPANION_DISPATCH_RUN` (older override, tests) pins the legacy file;
 * else repo-map.ts, then dispatch-run.ts.
 */
export function repoMapCandidates(env: Record<string, string | undefined> = process.env): string[] {
  if (env.COMPANION_REPO_MAP) return [env.COMPANION_REPO_MAP]
  if (env.COMPANION_DISPATCH_RUN) return [env.COMPANION_DISPATCH_RUN]
  return [join(toolsDir(), "repo-map.ts"), join(toolsDir(), "dispatch-run.ts")]
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

/** The file REPO_MAP comes from + its text: the first candidate with ≥ 1 entry, else the first readable one. */
export function locateRepoMap(files: string[] = repoMapCandidates()): { file: string; source: string } | null {
  let fallback: { file: string; source: string } | null = null
  for (const file of files) {
    const source = readText(file)
    if (source === null) continue
    if (parseRepoMap(source, "/").length) return { file, source }
    fallback ??= { file, source }
  }
  return fallback
}

/** REPO_MAP source text (repo-map.ts, else dispatch-run.ts), or null when unreadable. */
export function readRepoMapSource(file?: string): string | null {
  return file ? readText(file) : locateRepoMap()?.source ?? null
}

// One entry per object literal: optional `name: "…"`, `match: /re/flags`,
// `path: `${HOME|home}/dir``, optional `project: "…"`, then any further simple
// fields (`requires: ["xcode"]`, `platform: "darwin"`, future ones: a string,
// a flat array or a boolean) — trailing comma allowed. Unknown fields are
// ignored, never a reason to drop the entry.
const ENTRY = new RegExp(
  String.raw`\{\s*(?:name:\s*"([^"\n]*)"\s*,\s*)?match:\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*)\s*,\s*` +
    String.raw`path:\s*` + "`" + String.raw`\$\{(?:HOME|home)\}\/([^` + "`" + String.raw`$]+)` + "`" +
    String.raw`\s*(?:,\s*project:\s*"([^"\n]*)"\s*)?` +
    String.raw`((?:,\s*[A-Za-z_]\w*:\s*(?:\[[^\]\n]*\]|"[^"\n]*"|true|false)\s*)*)` +
    String.raw`,?\s*\}`,
  "g",
)

/** Capabilities from the extra fields: `requires: ["xcode", …]`; `platform: "darwin"` reads as xcode. */
export function parseRequires(extra: string): string[] {
  const out = new Set<string>()
  const list = /requires:\s*\[([^\]\n]*)\]/.exec(extra)?.[1] ?? ""
  for (const m of list.matchAll(/["'`]([A-Za-z0-9_-]+)["'`]/g)) out.add(m[1]!.toLowerCase())
  if (/platform:\s*"darwin"/i.test(extra)) out.add("xcode")
  return [...out]
}

/** REPO_MAP entries parsed from repo-map.ts or dispatch-run.ts source; [] when none parse. */
export function parseRepoMap(source: string, home: string = process.env.HOME || homedir()): RepoEntry[] {
  const out: RepoEntry[] = []
  for (const m of source.matchAll(ENTRY)) {
    try {
      const e: RepoEntry = { match: new RegExp(m[2]!, m[3]!.replace(/[gy]/g, "")), path: join(home, m[4]!) }
      if (m[1]) e.name = m[1]
      const project = m[5] ?? /project:\s*"([^"\n]*)"/.exec(m[6] ?? "")?.[1]
      if (project) e.project = project
      const requires = parseRequires(m[6] ?? "")
      if (requires.length) e.requires = requires
      out.push(e)
    } catch { /* an entry this parser cannot read is skipped */ }
  }
  return out
}

// ── host capability (repo-map `requires`) ──────────────────────────────────

export interface HostProbe { platform: string; hasBin: (bin: string) => boolean }

let probe: HostProbe | null = null

/** This host: platform + PATH lookups (cached per process). */
export function realHost(): HostProbe {
  if (probe) return probe
  const seen = new Map<string, boolean>()
  const onPath = (bin: string): boolean =>
    /^[\w.-]+$/.test(bin) && spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { stdio: "ignore", timeout: 5000 }).status === 0
  probe = {
    platform: process.platform,
    hasBin: (bin) => {
      if (!seen.has(bin)) seen.set(bin, onPath(bin))
      return seen.get(bin)!
    },
  }
  return probe
}

/** Test seam: pin the host probe (null = the real host again). */
export function setHostProbe(p: HostProbe | null): void {
  probe = p
}

/** xcode = macOS with xcodebuild on PATH. Unknown capability → not met. */
export function hostHas(cap: string, host: HostProbe = realHost()): boolean {
  if (cap === "xcode") return host.platform === "darwin" && host.hasBin("xcodebuild")
  return false
}

/** Can this host run code for the entry (build / fix)? No `requires` → yes. */
export function hostCan(entry: Pick<RepoEntry, "requires"> | null | undefined, host: HostProbe = realHost()): boolean {
  return (entry?.requires ?? []).every((c) => hostHas(c, host))
}

const norm = (p: string): string => p.replace(/\/+$/, "")

/** The map entries for a local path (exact path, trailing slash tolerant). */
function entriesAt(path: string, entries: RepoEntry[]): RepoEntry[] {
  return entries.filter((e) => norm(e.path) === norm(path))
}

/** A mapped path this host may not run code in (an Xcode repo on a host without Xcode). */
export function pathBlockedHere(path: string | null | undefined, entries: RepoEntry[], host: HostProbe = realHost()): boolean {
  return !!path && entriesAt(path, entries).some((e) => !hostCan(e, host))
}

/** A note mapped (on any host) to a repo this host may not run code for. */
export function noteBlockedHere(hay: string, entries: RepoEntry[], host: HostProbe = realHost()): boolean {
  return entries.some((e) => e.match.test(hay) && !hostCan(e, host))
}

export const XCODE_LIVE_REASON = "Xcode repo — run live from the Mac"

/**
 * The resolver's fix-run checkout: `repo` when this host may run code in it,
 * else null — "no local checkout here", so seams.fix forwards to the Mac peer.
 */
export function fixRepoHere(repo: string | null, host: HostProbe = realHost(), source: string | null = readRepoMapSource()): string | null {
  if (!repo) return null
  if (source && pathBlockedHere(repo, parseRepoMap(source), host)) return null
  return repo
}

export interface RepoMapCheck { file: string | null; entries: number; local: number }

/** Startup self-check: where REPO_MAP was read and how many entries parsed (0 = every repo lookup fails). */
export function checkRepoMap(files: string[] = repoMapCandidates()): RepoMapCheck {
  const found = locateRepoMap(files)
  if (!found) return { file: null, entries: 0, local: 0 }
  const entries = parseRepoMap(found.source)
  return { file: found.file, entries: entries.length, local: new Set(entries.map((e) => e.path).filter(isDir)).size }
}

/** The log line for checkRepoMap; `warn` = loud (0 entries). */
export function repoMapCheckLine(c: RepoMapCheck, files: string[] = repoMapCandidates()): { warn: boolean; text: string } {
  if (!c.file) return { warn: true, text: `[repo-map] WARNING: no REPO_MAP file readable (tried ${files.join(", ")}) — no project resolves to a local checkout (live cwd, resolver fix runs, catalog)` }
  if (!c.entries) return { warn: true, text: `[repo-map] WARNING: 0 REPO_MAP entries parsed from ${c.file} — the format changed? Every local-checkout lookup will fail (live cwd, resolver fix runs, catalog)` }
  return { warn: false, text: `[repo-map] ${c.entries} REPO_MAP entries from ${c.file} (${c.local} checked out here)` }
}

export function isDir(p: string | null | undefined): p is string {
  if (!p) return false
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The local repo for a project note (id + title), or null when unmapped here. */
export function repoForNote(noteId: string, title: string | null, file?: string): string | null {
  const source = readRepoMapSource(file)
  if (source === null) return null
  const hay = `${noteId} ${title ?? ""}`
  for (const { match, path } of parseRepoMap(source)) if (match.test(hay) && isDir(path)) return path
  return null
}

export interface LiveCwdInput {
  explicit?: string | null; noteId?: string | null; noteTitle?: string | null; taskCwd?: string | null; channelCwd?: string | null
}

/**
 * Live cwd: the explicit one, else the note's mapped repo, else the proposal's
 * or the channel's cwd — the first that is a directory on this host. An Xcode
 * repo (note or path) on a host without Xcode → null with XCODE_LIVE_REASON.
 */
export function resolveLiveCwdWhy(c: LiveCwdInput, host: HostProbe = realHost()): { cwd: string | null; reason: string | null } {
  const source = readRepoMapSource()
  const entries = source ? parseRepoMap(source) : []
  const blocked = (p: string | null | undefined) => pathBlockedHere(p, entries, host)
  if (c.explicit) {
    if (blocked(c.explicit)) return { cwd: null, reason: XCODE_LIVE_REASON }
    return { cwd: isDir(c.explicit) ? c.explicit : null, reason: null }
  }
  if (c.noteId && noteBlockedHere(`${c.noteId} ${c.noteTitle ?? ""}`, entries, host)) return { cwd: null, reason: XCODE_LIVE_REASON }
  const mapped = c.noteId ? repoForNote(c.noteId, c.noteTitle ?? null) : null
  const cands = [mapped, c.taskCwd, c.channelCwd].filter(isDir)
  const cwd = cands.find((p) => !blocked(p)) ?? null
  return { cwd, reason: !cwd && cands.length ? XCODE_LIVE_REASON : null }
}

export function resolveLiveCwd(c: LiveCwdInput, host: HostProbe = realHost()): string | null {
  return resolveLiveCwdWhy(c, host).cwd
}

/**
 * A local checkout of `owner/repo`: the note's REPO_MAP entry first, then any
 * mapped path whose origin matches. Entries this host may not run code for
 * (Xcode repos without Xcode) are not candidates: the caller forwards to the peer.
 */
export async function localRepoFor(slug: string, hay: string, sh: ShFn, host: HostProbe = realHost()): Promise<string | null> {
  const source = readRepoMapSource()
  if (!source) return null
  const entries = parseRepoMap(source)
  const ordered = [...entries.filter((e) => e.match.test(hay)), ...entries.filter((e) => !e.match.test(hay))]
  const seen = new Set<string>()
  for (const e of ordered) {
    if (seen.has(e.path) || !isDir(e.path) || pathBlockedHere(e.path, entries, host)) continue
    seen.add(e.path)
    const r = await sh("git", ["-C", e.path, "remote", "get-url", "origin"], { cwd: e.path, timeoutMs: 10_000 })
    if (r.ok && r.out.trim().toLowerCase().replace(/\.git$/, "").endsWith(slug.toLowerCase())) return e.path
  }
  return null
}
