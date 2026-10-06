import { GaugeStore, MOD_FRESH_MS } from "../lib/gauge"
import { getSessionByKey, listSessions, type Session } from "../lib/sessions"
import { broadcast } from "../state"
import { autoCompactor } from "./auto-compact"

// Real deps for lib/gauge.ts: the registry resolves a session id to the key
// the phone uses, frames go out on the shared broadcast.

// The live session running `sessionId`; else the key the reporter named, as
// long as that session has not since moved to another session id.
export function resolveGaugeKey(sessionId: string, hint: string): string | null {
  const bySid = listSessions().find((s) => s.sessionId === sessionId)
  if (bySid) return bySid.key
  if (!hint) return null
  const s = getSessionByKey(hint)
  return s && (!s.sessionId || s.sessionId === sessionId) ? s.key : null
}

export const gauge = new GaugeStore({
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as unknown as { unref?: () => void }).unref?.()
    return t
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  resolveKey: resolveGaugeKey,
  // The literal type (already on the frame) is what archmap's frame scan reads.
  emit: (frame) => broadcast({ ...frame, type: "gauge" }),
})

// Stop-hook fallback: transcript context size for a Claude session. The read
// shares auto-compact's tail parser; the store ignores it while a mod report
// is fresh, so it is skipped up front in that case.
export async function gaugeFromTranscript(session: Session, transcriptPath: string | undefined, sessionId: string | undefined): Promise<void> {
  const sid = sessionId || session.sessionId
  if (session.agent !== "claude" || !transcriptPath || !sid) return
  if (gauge.modFreshFor(sid, MOD_FRESH_MS)) return
  const tokens = await autoCompactor.contextTokensOf(transcriptPath)
  if (tokens === null) return
  gauge.reportTranscript(sid, session.key, tokens, session.model)
}
