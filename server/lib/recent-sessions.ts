// Recent interactive Claude sessions on this host, for the phone's terminal:
// the spawn sheet's "Recent sessions" (tap = a new terminal running
// `claude --resume <id>` in that folder) and the Resume chip's name after
// /exit prints `claude --resume <id>`.
//
// Read from the transcripts (~/.claude/projects/<dir>/<id>.jsonl): newest by
// mtime, only the head of each file (cwd, entrypoint, first prompt) — some
// are tens of MB. Headless runs (`claude -p`, entrypoint "sdk-cli": dispatch,
// resolver, scrapes) are left out: there is nothing to resume by hand.

import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { type TranscriptEntry, storedTitle, titleFromPrompt, userText } from "./session-titles"

export interface RecentSession {
  sessionId: string
  cwd: string
  title: string // "" when no prompt qualified yet
  updatedAt: number // ms epoch, the transcript's mtime
}

export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const HEAD_BYTES = 256 * 1024

async function readHead(path: string): Promise<string> {
  const fh = await open(path, "r")
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead).toString("utf8")
  } finally {
    await fh.close()
  }
}

// cwd, entrypoint and the first qualifying prompt from a transcript head.
export function parseHead(text: string): { cwd: string; entrypoint: string; title: string } {
  let cwd = ""
  let entrypoint = ""
  let title = ""
  const lines = text.split("\n")
  lines.pop() // the last line may be cut mid-record
  for (const line of lines) {
    let e: TranscriptEntry & { cwd?: unknown; entrypoint?: unknown }
    try { e = JSON.parse(line) } catch { continue }
    if (!cwd && typeof e.cwd === "string") cwd = e.cwd
    if (!entrypoint && typeof e.entrypoint === "string") entrypoint = e.entrypoint
    if (!title) {
      const t = userText(e)
      if (t !== null) title = titleFromPrompt(t) ?? ""
    }
    if (cwd && entrypoint && title) break
  }
  return { cwd, entrypoint, title }
}

export async function listRecentSessions(
  opts: { limit?: number; projectsDir?: string } = {},
): Promise<RecentSession[]> {
  const dir = opts.projectsDir ?? join(homedir(), ".claude", "projects")
  const limit = opts.limit ?? 20
  let projects: string[]
  try { projects = await readdir(dir) } catch { return [] }
  const files: { path: string; id: string; mtime: number }[] = []
  for (const p of projects) {
    let names: string[]
    try { names = await readdir(join(dir, p)) } catch { continue }
    for (const n of names) {
      const id = n.endsWith(".jsonl") ? n.slice(0, -6) : ""
      if (!SESSION_ID_RE.test(id)) continue
      const path = join(dir, p, n)
      try { files.push({ path, id, mtime: (await stat(path)).mtimeMs }) } catch { /* gone */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const out: RecentSession[] = []
  const seen = new Set<string>()
  // Headless runs dominate the newest files; read on until `limit` are found,
  // within a bound so one request never reads every transcript.
  for (const f of files.slice(0, limit * 15)) {
    if (out.length >= limit || seen.has(f.id)) continue
    seen.add(f.id)
    let head: string
    try { head = await readHead(f.path) } catch { continue }
    const h = parseHead(head)
    if (h.entrypoint !== "cli" || !h.cwd) continue
    out.push({ sessionId: f.id, cwd: h.cwd, title: storedTitle(f.id) ?? h.title, updatedAt: Math.round(f.mtime) })
  }
  return out
}
