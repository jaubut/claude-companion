import { type FileHandle, open, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type AutoCompactDeps, AutoCompactor, type CompactTarget, type InputState, type PushKind, inScope, scopeFromEnv, thresholdFromEnv } from "../lib/auto-compact"
import { companionLog } from "../lib/log"
import { getSessionByKey, type Session } from "../lib/sessions"
import { readClaudeSessionFile } from "../lib/discover"
import { transcriptPath } from "../lib/session-titles"
import { injectRefusal, paneNotReady } from "../lib/inject-guard"
import { injectConfirmed } from "../lib/submit-confirm"
import { apnsConfigured } from "../lib/apns"
import { pushToAll } from "../lib/push"
import { openDialogFor, paneSnapshotFor, yieldPaneForInject } from "./dialogs"

// Real deps for lib/auto-compact.ts. Two hard rules on the inject:
//   - only into the session's OWN tmux pane: no pane → "unknown" input state →
//     the gate refuses; the delivery is passed without a tty so a failed
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
  // tty stripped: tmux only, never the osascript fallback.
  const res = await injectConfirmed(text, { ...s, tty: "" })
  return res.ok ? { ok: true } : { ok: false, error: res.error }
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
    interruptionLevel: kind === "countdown" ? "active" : "passive",
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
}

export const autoCompactor = new AutoCompactor(realAutoCompactDeps)

export function compactTargetFor(session: Session, transcriptPath: string | undefined, sessionId: string | undefined): CompactTarget | null {
  if (session.agent !== "claude" || !transcriptPath) return null
  return {
    key: session.key,
    name: session.title || session.label || session.key,
    sessionId: sessionId || session.sessionId,
    transcriptPath,
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
