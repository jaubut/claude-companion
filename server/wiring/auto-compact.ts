import { type FileHandle, open, readFile, stat } from "node:fs/promises"
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import {
  type AutoCompactDeps, AutoCompactor, type CompactionDone, type CompactTarget, type InputState, type PushKind,
  boundaryFromEnv, inScope, scopeFromEnv, thresholdFromEnv,
} from "../lib/auto-compact"
import { type KeepNote, type KeepPr, type KeepState, type SessionSnapshot, stateNextLines } from "../lib/auto-compact-keep"
import { type CompactionStats, compactionStats, ensureCompactionLog, insertCompaction } from "../lib/auto-compact-stats"
import { companionDbPath } from "../lib/db-path"
import { MINE } from "../lib/my-tasks"
import { prState, realGh } from "../lib/triage-pr"
import { type Row, tursoQuery } from "../lib/turso"
import { companionLog } from "../lib/log"
import { getSessionByKey, type Session } from "../lib/sessions"
import { readClaudeSessionFile } from "../lib/discover"
import { transcriptPath } from "../lib/session-titles"
import { injectRefusal, paneNotReady } from "../lib/inject-guard"
import { injectVerified } from "../lib/inject-verified"
import { paneRefOf } from "../lib/tmux-pane"
import { apnsConfigured } from "../lib/apns"
import { pushToAll } from "../lib/push"
import { openDialogFor, paneSnapshotFor, yieldPaneForInject } from "./dialogs"

// Real deps for lib/auto-compact.ts. Two hard rules on the inject:
//   - only into the session's OWN tmux pane: no pane → "unknown" input state →
//     the gate refuses (so herdr sessions, which have no tmux pane, are never
//     auto-compacted in v1 — likewise the /help scrape and dialog mirror); the delivery is passed without a tty so a failed
//     send-keys can never fall back to the AppleScript (focus-the-terminal)
//     path;
//   - the same guard as a phone inject (lib/inject-guard.ts): registered,
//     live tty, no companion flow on the pane, no dialog, empty input box —
//     then injectConfirmed (submit confirmation / pane lock).

function claudeSession(key: string): Session | null {
  const s = getSessionByKey(key)
  return s && s.agent === "claude" ? s : null
}

async function agentStatus(key: string): Promise<string> {
  const s = claudeSession(key)
  if (!s) return ""
  if (s.pid) {
    const file = await readClaudeSessionFile(s.pid)
    if (file?.status) return file.status
  }
  return s.agentStatus || ""
}

async function inputState(key: string): Promise<InputState> {
  const s = claudeSession(key)
  if (!s?.tmuxPane) return "unknown"
  const pane = await paneSnapshotFor(s)
  if (pane === undefined || pane === null) return "unknown"
  const reason = paneNotReady(pane)
  if (reason === null) return "empty"
  return reason === "input_not_empty" ? "typing" : "not_ready"
}

async function inject(key: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const s = claudeSession(key)
  if (!s) return { ok: false, error: "target_gone" }
  if (!s.tmuxPane) return { ok: false, error: "no_tmux_pane" }
  const paneFree = await yieldPaneForInject(s)
  const refusal = injectRefusal({
    lookup: key, target: s, paneFree,
    dialog: paneFree ? await openDialogFor(s) : null,
    pane: paneFree ? await paneSnapshotFor(s) : undefined,
  })
  if (refusal) return { ok: false, error: refusal.reason ? `${refusal.error}:${refusal.reason}` : refusal.error }
  // Typed in stages (never pasted: a pasted slash command does not run) +
  // read-back, Enter only if the input starts with `/compact keep:`
  // (lib/inject-verified.ts). tmux only, never the osascript fallback.
  const ref = paneRefOf(s)
  if (!ref) return { ok: false, error: "no_tmux_pane" }
  const res = await injectVerified(ref, text)
  if (res.ok) return { ok: true }
  await push("failed", { key, name: s.title || s.label || key, sessionId: s.sessionId || "", transcriptPath: "", cwd: s.cwd }, "Compact failed", `${s.title || s.label || key}: the /compact command did not land (${res.error}); nothing was submitted.`)
  return { ok: false, error: res.error }
}

function collapseId(key: string): string {
  return `compact-${createHash("sha1").update(key).digest("hex").slice(0, 16)}`
}

async function push(kind: PushKind, target: CompactTarget, title: string, body: string): Promise<void> {
  if (!apnsConfigured()) return
  const r = await pushToAll({
    title,
    body,
    category: kind === "countdown" ? "auto_compact" : "auto_compact_done",
    // A failure (not delivered, or delivered and not executed) needs eyes.
    interruptionLevel: kind === "done" ? "passive" : "active",
    threadId: `auto_compact:${target.key}`,
    // The result replaces the countdown banner instead of stacking under it.
    collapseId: collapseId(target.key),
    userInfo: {
      key: target.key,
      sessionId: target.sessionId,
      ...(kind === "countdown" ? { action: "auto_compact_cancel", cancelPath: "/api/auto-compact/cancel" } : {}),
    },
  })
  companionLog(`auto-compact push (${kind}) → ${r.sent}/${r.total} devices`)
}

// ── state-aware keep: resolve the session's pointers against durable state ──

const LOOKUP_MS = 8_000

function within<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), LOOKUP_MS).unref?.())]).catch(() => fallback)
}

// Live gh state for PRs whose repo is known; the transcript's last-seen state otherwise.
async function livePrs(prs: KeepPr[]): Promise<KeepPr[]> {
  return Promise.all(prs.slice(0, 6).map(async (p) => {
    if (!p.repo) return p
    const s = await within(prState(realGh, `https://github.com/${p.repo}/pull/${p.number}`), "unknown" as const)
    return s === "unknown" ? p : { ...p, state: s }
  }))
}

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ")

// The notes this session wrote (most recent first) + their open tasks; tasks
// assigned to Jeremie are the pending human steps.
async function noteState(snap: SessionSnapshot): Promise<{ notes: KeepNote[]; human: string[] }> {
  const ids = snap.noteIds.slice(0, 4)
  const refs = snap.refCodes.slice(0, 4)
  if (!ids.length && !refs.length) return { notes: [], human: [] }
  const where = [ids.length && `id IN (${marks(ids.length)})`, refs.length && `ref_code IN (${marks(refs.length)})`].filter(Boolean).join(" OR ")
  const rows = await tursoQuery(`SELECT id, ref_code FROM notes WHERE ${where} LIMIT 8`, [...ids, ...refs])
  const rank = (r: Row): number => {
    const i = ids.indexOf(String(r.id)); const j = refs.indexOf(String(r.ref_code ?? ""))
    return Math.min(i < 0 ? 99 : i, j < 0 ? 99 : j)
  }
  const human: string[] = []
  const notes = await Promise.all(rows.sort((a, b) => rank(a) - rank(b)).slice(0, 4).map(async (r) => {
    const id = String(r.id)
    const tasks = await tursoQuery("SELECT text, assignee FROM tasks WHERE note_id = ? AND done = 0 ORDER BY position LIMIT 12", [id])
    const mine = tasks.filter((t) => MINE.includes(String(t.assignee ?? "")))
    human.push(...mine.map((t) => String(t.text ?? "")))
    return { id, ref: String(r.ref_code ?? ""), openTasks: tasks.filter((t) => !mine.includes(t)).map((t) => String(t.text ?? "")) }
  }))
  return { notes, human }
}

// STATE.md of the session's repo: cwd, then up to the git root.
async function stateNext(cwd: string | undefined): Promise<string[]> {
  for (let dir = cwd; dir && dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, "STATE.md")
    if (existsSync(file)) return stateNextLines(await readFile(file, "utf8"))
    if (existsSync(join(dir, ".git"))) break
  }
  return []
}

async function keepState(target: CompactTarget, snap: SessionSnapshot): Promise<KeepState> {
  const [prs, notes, next] = await Promise.all([
    livePrs(snap.prs),
    within(noteState(snap), { notes: [], human: [] }),
    stateNext(target.cwd).catch(() => []),
  ])
  return { prs, notes: notes.notes, next, human: notes.human }
}

// ── compaction stats (companion.db, opened on first use) ────────────────────

let statsDb: Database | null = null

function stats(): Database {
  if (!statsDb) {
    const path = companionDbPath()
    mkdirSync(dirname(path), { recursive: true })
    statsDb = new Database(path)
    ensureCompactionLog(statsDb)
  }
  return statsDb
}

function recordCompaction(d: CompactionDone): void {
  insertCompaction(stats(), { at: d.at, sessionKey: d.target.key, name: d.target.name, trigger: d.trigger, preTokens: d.preTokens, postTokens: d.postTokens })
}

/** Auto-compactions this server completed since `sinceMs` (GET /api/body/tokens). */
export function compactionStatsSince(sinceMs: number): CompactionStats {
  return compactionStats(stats(), sinceMs)
}

export const realAutoCompactDeps: AutoCompactDeps = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as unknown as { unref?: () => void }).unref?.()
    return t
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  threshold: () => thresholdFromEnv(),
  transcriptSize: async (path) => {
    try { return (await stat(path)).size } catch { return null }
  },
  readTranscript: async (path, start, end) => {
    let fh: FileHandle | undefined
    try {
      fh = await open(path, "r")
      const buf = Buffer.alloc(Math.max(0, end - start))
      const { bytesRead } = await fh.read(buf, 0, buf.length, start)
      return buf.subarray(0, bytesRead).toString("utf8")
    } catch { return null } finally { await fh?.close() }
  },
  agentStatus,
  inputState,
  push,
  inject,
  log: (line) => companionLog(`\x1b[36m${line}\x1b[0m`),
  eligible: (target) => inScope(target, scopeFromEnv()),
  boundaryThreshold: () => boundaryFromEnv(),
  keepState,
  recordCompaction,
}

export const autoCompactor = new AutoCompactor(realAutoCompactDeps)

export function compactTargetFor(session: Session, transcriptPath: string | undefined, sessionId: string | undefined): CompactTarget | null {
  if (session.agent !== "claude" || !transcriptPath) return null
  return {
    key: session.key,
    name: session.title || session.label || session.key,
    sessionId: sessionId || session.sessionId,
    transcriptPath,
    cwd: session.cwd,
  }
}

// Test trigger: the registry has no transcript path, so derive it from the
// session's cwd + id (Claude's ~/.claude/projects layout).
export function compactTargetForKey(key: string, projectsDir = join(homedir(), ".claude", "projects")): CompactTarget | null {
  const s = claudeSession(key)
  if (!s?.sessionId || !s.cwd) return null
  return compactTargetFor(s, findTranscriptSync(s.cwd, s.sessionId, projectsDir), s.sessionId)
}

// cwd-derived path first; else `<sessionId>.jsonl` in any project dir (a
// session resumed from another folder keeps its file under the original one),
// newest if several. Neither → the cwd path, which test() reports unreadable.
export function findTranscriptSync(cwd: string, sessionId: string, projectsDir: string): string {
  const direct = transcriptPath(cwd, sessionId, projectsDir)
  if (existsSync(direct)) return direct
  let best: { path: string; mtime: number } | null = null
  let dirs: string[] = []
  try { dirs = readdirSync(projectsDir) } catch { /* no projects dir */ }
  for (const d of dirs) {
    const path = join(projectsDir, d, `${sessionId}.jsonl`)
    try {
      const mtime = statSync(path).mtimeMs
      if (!best || mtime > best.mtime) best = { path, mtime }
    } catch { /* not here */ }
  }
  return best?.path ?? direct
}
