import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { SECRET_PATHS } from "./readonly-claude"

// Copies of the files a session sent with SendUserFile (t-server-filecards-1),
// served by GET /api/files/:id/:name so the phone can download them. A leaf
// lib: fs only. The feed event carries `/api/files/<id>/<name>`, never bytes.
//
// Layout: <dir>/<id>/<basename>, id = 32 hex of sha256(realpath\0size\0mtime),
// so the same file sent twice is one copy. The dir is COMPANION_SENT_FILES_DIR
// (tests) or ~/.claude-companion/sent-files. Lifetime is the store's, not the
// feed's: 7 days since last write/re-send, then a 1 GB cap oldest first —
// swept on every store and hourly (wiring/media.ts).
//
// Never copied: anything over 50 MB, non-regular files, and secrets — the
// read-only-claude deny list plus a few more, matched on the given path AND
// its realpath (a symlink to auth.token is refused). `~/.claude-companion/*`
// is top level only, so media/ and sent-files/ stay allowed.

export interface SentFile {
  id: string
  name: string
  path: string
}

const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_DIR_BYTES = 1024 * 1024 * 1024
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ID_RE = /^[a-f0-9]{32}$/

const DENY = [
  ...SECRET_PATHS,
  "**/.secrets", "**/.kb_*", "~/.config/telegram-bot.env", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "~/.claude-companion/*",
].map((p) => new Bun.Glob(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p))

export function sentFilesDir(): string {
  return process.env.COMPANION_SENT_FILES_DIR || join(homedir(), ".claude-companion", "sent-files")
}

export function isSentFileId(id: string): boolean {
  return ID_RE.test(id)
}

export function isSecretPath(path: string): boolean {
  return DENY.some((g) => g.match(path))
}

// The one stored file under an id, or null.
export function sentFilePath(id: string): { path: string; name: string } | null {
  if (!isSentFileId(id)) return null
  try {
    const names = readdirSync(join(sentFilesDir(), id)).filter((n) => !n.endsWith(".tmp"))
    return names.length === 1 ? { path: join(sentFilesDir(), id, names[0]!), name: names[0]! } : null
  } catch {
    return null
  }
}

// null = refused (secret, missing, not a file, too big) or the copy failed.
export async function storeSentFile(path: string): Promise<SentFile | null> {
  let real: string
  let size: number
  let mtimeMs: number
  try {
    real = realpathSync(path)
    if (isSecretPath(path) || isSecretPath(real)) return null
    const st = statSync(real)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return null
  }
  const id = createHash("sha256").update(`${real}\0${size}\0${mtimeMs}`).digest("hex").slice(0, 32)
  const name = basename(real)
  const dir = join(sentFilesDir(), id)
  const dest = join(dir, name)
  try {
    const now = new Date()
    if (sentFilePath(id)) {
      utimesSync(dir, now, now)
    } else {
      mkdirSync(dir, { recursive: true })
      const tmp = `${dest}.${process.pid}.tmp`
      await Bun.write(tmp, Bun.file(real))
      renameSync(tmp, dest)
    }
    sweepSentFiles(id)
    return { id, name, path: dest }
  } catch {
    return null
  }
}

// Age first, then the byte cap oldest-by-mtime. `keep` is never removed (the
// id just stored). Returns the ids removed.
export function sweepSentFiles(keep?: string): string[] {
  const root = sentFilesDir()
  const removed: string[] = []
  try {
    const entries = readdirSync(root)
      .filter(isSentFileId)
      .map((id) => {
        const dir = join(root, id)
        const bytes = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0)
        return { id, dir, bytes, mtime: statSync(dir).mtimeMs }
      })
      .sort((a, b) => a.mtime - b.mtime)
    let total = entries.reduce((n, e) => n + e.bytes, 0)
    const cutoff = Date.now() - MAX_AGE_MS
    for (const e of entries) {
      if (e.id === keep) continue
      if (e.mtime >= cutoff && total <= MAX_DIR_BYTES) continue
      rmSync(e.dir, { recursive: true, force: true })
      total -= e.bytes
      removed.push(e.id)
    }
  } catch { /* no dir yet */ }
  return removed
}
