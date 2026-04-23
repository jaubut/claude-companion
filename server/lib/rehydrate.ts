// Rehydrate session registry on server boot from Claude Code JSONL transcripts.
// Without this, sessions that are idle when companion (re)starts stay invisible
// to the phone picker until the user triggers a hook-firing event in them.
//
// Heuristic: any transcript modified in the last REHYDRATE_WINDOW_MIN minutes
// is considered "live enough" to show in the picker. SessionEnd hook + the
// existing 60-min inactivity prune clear stale entries.

import { readdir, readFile, stat } from "node:fs/promises"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import { recordSession } from "./sessions"

const PROJECTS_DIR = join(homedir(), ".claude", "projects")
const REHYDRATE_WINDOW_MIN = 30

interface RehydrateResult { registered: number; scanned: number }

async function findCwd(filePath: string): Promise<string | null> {
  try {
    const text = await readFile(filePath, "utf-8")
    const lines = text.trim().split("\n")
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line || !line.includes('"cwd"')) continue
      try {
        const entry = JSON.parse(line) as { cwd?: string }
        if (entry.cwd) return entry.cwd
      } catch { /* skip malformed line */ }
    }
  } catch { /* unreadable */ }
  return null
}

export async function rehydrateSessions(): Promise<RehydrateResult> {
  const cutoff = Date.now() - REHYDRATE_WINDOW_MIN * 60 * 1000
  let registered = 0
  let scanned = 0

  let projectDirs: string[]
  try {
    projectDirs = await readdir(PROJECTS_DIR)
  } catch { return { registered: 0, scanned: 0 } }

  const seen = new Set<string>()

  for (const dir of projectDirs) {
    const dirPath = join(PROJECTS_DIR, dir)
    let files: string[]
    try {
      files = await readdir(dirPath)
    } catch { continue }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue
      const filePath = join(dirPath, file)
      scanned++

      let st
      try { st = await stat(filePath) } catch { continue }
      if (st.mtimeMs < cutoff) continue

      const cwd = await findCwd(filePath)
      if (!cwd || seen.has(cwd)) continue
      seen.add(cwd)

      const sessionId = basename(file, ".jsonl")
      recordSession({ cwd, sessionId })
      registered++
    }
  }

  return { registered, scanned }
}
