import { getSessionByKey, listSessions } from "./sessions"

// Claude Code session id → the session registry key the phone uses. Shared by
// the producers that report by session id (context gauge, copy progress).

// The live session running `sessionId`; else the key the reporter named, as
// long as that session has not since moved to another session id.
export function resolveSessionKey(sessionId: string, hint: string): string | null {
  const bySid = listSessions().find((s) => s.sessionId === sessionId)
  if (bySid) return bySid.key
  if (!hint) return null
  const s = getSessionByKey(hint)
  return s && (!s.sessionId || s.sessionId === sessionId) ? s.key : null
}
