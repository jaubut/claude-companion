import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

// Session titles — the chat's name on the phone. Taken from the first real
// prompt of a session (the way chat apps name a thread), persisted by Claude
// session id so a companion restart, ps-discovery, or transcript rehydrate
// gets the same name back. Before the feature (or when the hook was missed)
// the title is recovered from the transcript's first user message.

const DB_DIR = join(homedir(), ".claude-companion")
const DB_PATH = process.env.COMPANION_DB_PATH ?? join(DB_DIR, "companion.db")
mkdirSync(DB_DIR, { recursive: true })
const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS session_titles (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`)

export const TITLE_MAX = 48
const DEFAULT_PROJECTS_DIR = join(homedir(), ".claude", "projects")

// Prompts often arrive wrapped in injected XML (system reminders, IDE
// selection, command output). Drop those blocks and keep what the user typed.
function stripInjectedXml(text: string): string {
  return text
    .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, " ")
}

// A prompt worth naming a chat after: not a slash command, not bash-mode, not
// leftover markup, not a fragment.
export function titleFromPrompt(text: string): string | null {
  const t = stripInjectedXml(text).replace(/\s+/g, " ").trim()
  if (t.length < 4) return null
  if (t.startsWith("/") || t.startsWith("!") || t.startsWith("<")) return null
  if (t.length <= TITLE_MAX) return t
  const cut = t.slice(0, TITLE_MAX)
  const sp = cut.lastIndexOf(" ")
  return `${(sp > 24 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

export function rememberTitle(sessionId: string, title: string): void {
  if (!sessionId || !title) return
  db.query("INSERT OR REPLACE INTO session_titles (session_id, title, created_at) VALUES (?, ?, ?)").run(sessionId, title, Date.now())
}

export function storedTitle(sessionId: string): string | null {
  if (!sessionId) return null
  const row = db.query("SELECT title FROM session_titles WHERE session_id = ?").get(sessionId) as { title: string } | null
  return row?.title ?? null
}

// Transcripts live under ~/.claude/projects/<cwd with / → ->/<sessionId>.jsonl
// (same mapping discover.ts uses).
export function transcriptPath(cwd: string, sessionId: string, projectsDir = DEFAULT_PROJECTS_DIR): string {
  return join(projectsDir, cwd.replace(/\//g, "-"), `${sessionId}.jsonl`)
}

interface TranscriptEntry {
  type?: string
  message?: { role?: string; content?: unknown }
}

function userText(entry: TranscriptEntry): string | null {
  if (entry.type !== "user" || entry.message?.role !== "user") return null
  const c = entry.message.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) {
    for (const part of c) {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        const t = (part as { text?: unknown }).text
        if (typeof t === "string") return t
      }
    }
  }
  return null
}

// The transcript for a session id: at the cwd-derived path, else wherever it
// lives under the projects dir (a session that was started elsewhere, or
// resumed into a different folder, keeps its file under the original dir).
async function findTranscript(cwd: string, sessionId: string, projectsDir: string): Promise<string | null> {
  const direct = transcriptPath(cwd, sessionId, projectsDir)
  try {
    await readFile(direct, { encoding: "utf-8", flag: "r" })
    return direct
  } catch { /* fall through */ }
  let dirs: string[]
  try {
    dirs = await readdir(projectsDir)
  } catch {
    return null
  }
  for (const d of dirs) {
    const candidate = join(projectsDir, d, `${sessionId}.jsonl`)
    try {
      await stat(candidate)
      return candidate
    } catch { /* next */ }
  }
  return null
}

// First user message of the transcript that qualifies as a title.
export async function titleFromTranscript(cwd: string, sessionId: string, projectsDir = DEFAULT_PROJECTS_DIR): Promise<string | null> {
  if (!sessionId) return null
  const path = await findTranscript(cwd, sessionId, projectsDir)
  if (!path) return null
  let text: string
  try {
    text = await readFile(path, "utf-8")
  } catch {
    return null
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"user"')) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    const t = userText(entry)
    if (t === null) continue
    const title = titleFromPrompt(t)
    if (title) return title
  }
  return null
}

// Stored title first, else recover it from the transcript and store it.
export async function resolveTitle(cwd: string, sessionId: string): Promise<string | null> {
  const stored = storedTitle(sessionId)
  if (stored) return stored
  const fromTranscript = await titleFromTranscript(cwd, sessionId)
  if (fromTranscript) rememberTitle(sessionId, fromTranscript)
  return fromTranscript
}
