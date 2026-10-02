// Session identity helpers for lib/sessions.ts: key derivation, labels, and
// the socket-travels-with-its-pane merge rule. Pure; no registry state.

import type { Session } from "./sessions"

export function deriveKey(meta: Partial<Session> & { cwd: string }): string {
  const agent = meta.agent === "codex" ? "codex" : "claude"
  if (meta.tty) return `${agent}:tty:${meta.tty}`
  if (meta.iTermSessionId) return `${agent}:iterm:${meta.iTermSessionId}`
  if (meta.sessionId) return `${agent}:sid:${meta.sessionId}`
  return `${agent}:cwd:${meta.cwd}`
}

export function hasTtyIdentity(key: string): boolean {
  return key.startsWith("tty:") || key.includes(":tty:")
}

export function hasStrongIdentity(key: string): boolean {
  return hasTtyIdentity(key) || key.startsWith("iterm:") || key.includes(":iterm:")
}

function basename(cwd: string): string {
  if (!cwd) return ""
  return cwd.split("/").filter(Boolean).pop() ?? cwd
}

// Tail of the tty for disambiguation when two sessions share a cwd.
// macOS `/dev/ttys017` → `s017`; Linux `/dev/pts/8` → `pts8`. Empty if we
// don't have a tty yet. (Linux ttys used to fall through untagged, which is
// why every Linux-host session launched from $HOME was labelled "aubut".)
export function ttyTag(tty: string): string {
  const mac = tty.match(/ttys?(\d+)$/)
  if (mac) return `s${mac[1]}`
  const pts = tty.match(/pts\/(\d+)$/)
  return pts ? `pts${pts[1]}` : ""
}

export function makeLabel(cwd: string, tty: string): string {
  const base = basename(cwd)
  const tag = ttyTag(tty)
  if (!base && !tag) return ""
  if (!tag) return base
  if (!base) return tag
  return `${base} · ${tag}`
}

// The socket travels with the pane: a record that gains a NEW pane without a
// socket must not keep the old pane's socket (it would address the new id on
// the wrong server). Same pane, or no pane in this update → sticky.
export function mergeTmuxSocket(meta: Partial<Session>, prev: Session | undefined): string {
  if (meta.tmuxSocket) return meta.tmuxSocket
  if (meta.tmuxPane && meta.tmuxPane !== prev?.tmuxPane) return ""
  return prev?.tmuxSocket ?? ""
}
