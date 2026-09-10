import type { Activity, Session, WaitingEntry } from "@/hooks/use-companion"
import { SpawnSession } from "@/components/spawn-session"
import { hashHue, shortKey, truncate } from "@/lib/format"
import { CornerDownLeft, ChevronDown } from "lucide-react"

export function TargetBar({
  sessions, effectiveTarget, targetKey, waitingByKey, activities, targetWaiting,
  pinnedOffline, picking, onTogglePick, onPick,
}: {
  sessions: Session[]
  effectiveTarget: Session | null
  targetKey: string
  waitingByKey: Record<string, WaitingEntry>
  activities: Activity[]
  targetWaiting: WaitingEntry | null
  pinnedOffline: boolean
  picking: boolean
  onTogglePick: () => void
  onPick: (key: string) => void
}) {
  if (sessions.length === 0 && !effectiveTarget && !picking) return null

  // Which sessions are mid-turn right now. A pill with no key came from a hook
  // with no cwd, so it belongs to no row.
  const workingKeys = new Set(activities.map(a => a.key).filter(Boolean))

  // The hint belongs to the session we'd send to, not to whichever one
  // happened to finish its turn last.
  const hint = targetWaiting?.message ?? ""
  const hue = hashHue(effectiveTarget?.key ?? "")
  // `??` falls through only on null/undefined — an empty string label
  // (provisional session from discovery) would still render as "" and force
  // the "frontmost" fallback below. Use `||` and derive from the key/tty so
  // the chip reads e.g. "s009" instead of the misleading "frontmost".
  const label = effectiveTarget?.label
    || (effectiveTarget?.tty ? shortKey(`tty:${effectiveTarget.tty}`) : "")
    || (effectiveTarget?.key ? shortKey(effectiveTarget.key) : "")
    || (targetKey ? shortKey(targetKey) : "")

  return (
    <div className="space-y-2">
      {hint && (
        <div className="text-[11px] text-muted/70 px-1 line-clamp-2 italic">
          “{truncate(hint, 220)}”
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-muted/60 shrink-0 flex items-center gap-1">
          <CornerDownLeft className="w-3 h-3" />
          send to
        </span>
        <button
          onClick={onTogglePick}
          disabled={sessions.length <= 1 && !effectiveTarget && !pinnedOffline}
          className={`flex items-center gap-1.5 px-3 py-2.5 min-h-[44px] rounded-full glass-card text-fg disabled:opacity-50 active:scale-95 transition-transform ${pinnedOffline ? "ring-1 ring-red/50" : ""}`}
          style={{
            backgroundColor: pinnedOffline ? "hsl(0 70% 40% / 0.15)" : effectiveTarget ? `hsl(${hue} 70% 55% / 0.12)` : undefined,
            color: pinnedOffline ? "hsl(0 70% 75%)" : effectiveTarget ? `hsl(${hue} 70% 75%)` : undefined,
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: pinnedOffline ? "hsl(0 70% 55%)" : `hsl(${hue} 70% 55%)` }}
          />
          <span className="font-semibold">{label || "frontmost"}</span>
          {pinnedOffline && <span className="text-[10px] opacity-80">· offline</span>}
          {(sessions.length > 1 || pinnedOffline) && <ChevronDown className="w-3 h-3 opacity-60" />}
        </button>
        {targetKey && (
          <button
            onClick={() => onPick("")}
            className="px-2 py-2 min-h-[44px] text-muted/60 underline-offset-2 hover:underline active:scale-95 transition-transform"
          >
            auto
          </button>
        )}
      </div>

      {picking && (
        <div className="glass-card p-1 max-h-72 overflow-y-auto space-y-0.5">
          {sessions.length > 0 && (
            <button
              onClick={() => onPick("")}
              className={`w-full text-left px-3 py-3 min-h-[44px] rounded-lg text-[12px] flex items-center gap-2 active:scale-[0.98] ${
                targetKey === "" ? "bg-accent/10 text-accent" : "text-fg hover:bg-fg/5"
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-muted/40" />
              <span className="font-semibold">Auto</span>
              <span className="text-muted/60 text-[11px]">most recent activity</span>
            </button>
          )}
          {sessions.map((s) => {
            const sHue = hashHue(s.key)
            const term = s.termProgram?.replace(/\.app$/i, "").replace(/_/g, " ")
            const idle = !s.tty
            // One waiting state per row, with the kind that won precedence. A
            // server that predates Phase 11 sends no kind — read that as the
            // turn-end it always was.
            const waiting = waitingByKey[s.key]
            const waitingKind = waiting ? waiting.kind || "turn-end" : ""
            const answersTurn = waitingKind === "turn-end"
            return (
              <button
                key={s.key}
                onClick={() => onPick(s.key)}
                className={`w-full text-left px-3 py-3 min-h-[44px] rounded-lg text-[12px] flex items-center gap-2 active:scale-[0.98] ${
                  targetKey === s.key ? "bg-accent/10 text-accent" : "text-fg hover:bg-fg/5"
                } ${idle ? "opacity-50" : ""}`}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: `hsl(${sHue} 70% 55%)` }}
                />
                <span className="font-semibold truncate">{s.label || shortKey(s.key)}</span>
                {workingKeys.has(s.key) && (
                  // Which session is busy — the whole point of Phase 10. More
                  // than one row can carry it, next to the waiting dot below.
                  <span
                    title="working"
                    aria-label="working"
                    role="img"
                    className="w-1.5 h-1.5 rounded-full bg-green shrink-0 animate-pulse"
                  />
                )}
                {!!waiting && (
                  // Which session is waiting — the whole point of Phase 9. More
                  // than one row can carry this at the same time. A reason the
                  // composer cannot answer (approval, question, dialog) gets a
                  // muted, still dot so it reads as "blocked elsewhere".
                  <span
                    title={waitingKind}
                    aria-label={answersTurn ? "waiting for input" : `waiting · ${waitingKind}`}
                    role="img"
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${answersTurn ? "bg-accent animate-pulse" : "bg-accent/40"}`}
                  />
                )}
                {idle && <span className="text-[10px] text-muted/60 italic shrink-0">idle</span>}
                <span className="flex-1 text-muted/60 text-[10px] font-mono truncate text-right">
                  {term ? `${term} · ` : ""}{s.tty.replace(/^\/dev\//, "") || "no tty"}
                </span>
              </button>
            )
          })}
          <div className="border-t border-fg/5 my-1" />
          <SpawnSession sessions={sessions} />
        </div>
      )}
    </div>
  )
}
