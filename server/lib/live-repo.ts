import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Live mode (orchestrator-one-queue P4) needs a cwd for the tmux worker. The
// project → repo mapping lives in dispatch-run.ts's REPO_MAP, which is not
// exported (the file runs on import). It is read here as text, read-only:
// each `{ match: /re/flags, path: `${HOME}/dir` }` entry, first one whose
// directory exists on this host wins — dispatch-run's own rule.

export interface RepoEntry { match: RegExp; path: string }

function dispatchRunPath(): string {
  return process.env.COMPANION_DISPATCH_RUN || join(process.env.HOME || homedir(), ".claude", "tools", "dispatch-run.ts")
}

const ENTRY = /\{\s*match:\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*)\s*,\s*path:\s*`\$\{HOME\}\/([^`$]+)`\s*\}/g

/** REPO_MAP entries parsed from dispatch-run.ts source; [] when unreadable. */
export function parseRepoMap(source: string, home: string = process.env.HOME || homedir()): RepoEntry[] {
  const out: RepoEntry[] = []
  for (const m of source.matchAll(ENTRY)) {
    try {
      out.push({ match: new RegExp(m[1]!, m[2]!.replace(/[gy]/g, "")), path: join(home, m[3]!) })
    } catch { /* an entry this parser cannot read is skipped */ }
  }
  return out
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
export function repoForNote(noteId: string, title: string | null, file: string = dispatchRunPath()): string | null {
  let source: string
  try {
    source = readFileSync(file, "utf8")
  } catch {
    return null
  }
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
