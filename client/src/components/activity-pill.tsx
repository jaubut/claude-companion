import { useEffect, useState } from "react"
import type { Activity, Session } from "@/hooks/use-companion"
import { SessionBadge } from "@/components/session-badge"
import { formatElapsed, formatTokens, truncate } from "@/lib/format"
import { Loader2 } from "lucide-react"

export function ActivityPill({ activity, sessions }: { activity: Activity; sessions: Session[] }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsedSec = Math.max(0, Math.floor((now - activity.turnStartedAt) / 1000))
  const stale = now - activity.lastBeatAt > 30_000
  const toolSummary = [activity.tool, activity.summary && truncate(activity.summary, 40)].filter(Boolean).join(" ")
  // The issued key is the exact match (PRJ-OR1T Phase 10); the tty/sessionId/cwd
  // chain still resolves a pill that arrived without one.
  const session = (activity.key ? sessions.find(s => s.key === activity.key) : undefined)
    ?? (activity.tty ? sessions.find(s => s.tty === activity.tty) : undefined)
    ?? (activity.sessionId ? sessions.find(s => s.sessionId === activity.sessionId) : undefined)
    ?? (activity.cwd ? sessions.find(s => s.cwd === activity.cwd) : undefined)

  return (
    <div className="px-5 pb-2 shrink-0">
      <div className={`flex items-center gap-2 px-3 py-2 rounded-full glass-card text-[12px] ${stale ? "text-red" : "text-muted"}`}>
        <Loader2 className={`w-3.5 h-3.5 shrink-0 ${stale ? "" : "animate-spin"}`} />
        {session && <SessionBadge session={session} />}
        <span className="font-semibold text-fg">{activity.verb}...</span>
        <span className="font-mono">{formatElapsed(elapsedSec)}</span>
        {activity.tokens > 0 && (
          <>
            <span className="opacity-40">·</span>
            <span className="font-mono">{formatTokens(activity.tokens)}</span>
          </>
        )}
        {toolSummary && (
          <>
            <span className="opacity-40">·</span>
            <span className="font-mono truncate">{toolSummary}</span>
          </>
        )}
      </div>
    </div>
  )
}
