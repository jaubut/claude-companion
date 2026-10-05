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

export interface RepoEntry { match: RegExp; path: string; name?: string; project?: string }

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
// `path: `${HOME|home}/dir``, optional `project: "…"` (trailing comma allowed).
const ENTRY = new RegExp(
  String.raw`\{\s*(?:name:\s*"([^"\n]*)"\s*,\s*)?match:\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*)\s*,\s*` +
    String.raw`path:\s*` + "`" + String.raw`\$\{(?:HOME|home)\}\/([^` + "`" + String.raw`$]+)` + "`" +
    String.raw`\s*(?:,\s*project:\s*"([^"\n]*)"\s*)?,?\s*\}`,
  "g",
)

/** REPO_MAP entries parsed from repo-map.ts or dispatch-run.ts source; [] when none parse. */
export function parseRepoMap(source: string, home: string = process.env.HOME || homedir()): RepoEntry[] {
  const out: RepoEntry[] = []
  for (const m of source.matchAll(ENTRY)) {
    try {
      const e: RepoEntry = { match: new RegExp(m[2]!, m[3]!.replace(/[gy]/g, "")), path: join(home, m[4]!) }
      if (m[1]) e.name = m[1]
      if (m[5]) e.project = m[5]
      out.push(e)
    } catch { /* an entry this parser cannot read is skipped */ }
  }
  return out
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

/**
 * Live cwd: the explicit one, else the note's mapped repo, else the proposal's
 * or the channel's cwd — the first that is a directory on this host.
 */
export function resolveLiveCwd(c: {
  explicit?: string | null; noteId?: string | null; noteTitle?: string | null; taskCwd?: string | null; channelCwd?: string | null
}): string | null {
  if (c.explicit) return isDir(c.explicit) ? c.explicit : null
  const mapped = c.noteId ? repoForNote(c.noteId, c.noteTitle ?? null) : null
  return [mapped, c.taskCwd, c.channelCwd].find(isDir) ?? null
}

/** A local checkout of `owner/repo`: the note's REPO_MAP entry first, then any mapped path whose origin matches. */
export async function localRepoFor(slug: string, hay: string, sh: ShFn): Promise<string | null> {
  const source = readRepoMapSource()
  if (!source) return null
  const entries = parseRepoMap(source)
  const ordered = [...entries.filter((e) => e.match.test(hay)), ...entries.filter((e) => !e.match.test(hay))]
  const seen = new Set<string>()
  for (const e of ordered) {
    if (seen.has(e.path) || !isDir(e.path)) continue
    seen.add(e.path)
    const r = await sh("git", ["-C", e.path, "remote", "get-url", "origin"], { cwd: e.path, timeoutMs: 10_000 })
    if (r.ok && r.out.trim().toLowerCase().replace(/\.git$/, "").endsWith(slug.toLowerCase())) return e.path
  }
  return null
}
