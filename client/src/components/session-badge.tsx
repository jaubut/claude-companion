import type { Session } from "@/hooks/use-companion"
import { hashHue, shortKey } from "@/lib/format"

export function SessionDot({ session, onClick }: { session: Session | undefined; onClick?: () => void }) {
  const hue = hashHue(session?.key ?? "")
  const dot = (
    <span
      className="block w-1.5 h-1.5 rounded-full"
      style={{ backgroundColor: `hsl(${hue} 70% 55%)` }}
    />
  )
  // Non-tappable (no session or no handler): render a plain span so it doesn't
  // claim focus or a 44×44 hit area it can't actually use.
  if (!onClick || !session) {
    return (
      <span className="block shrink-0 mt-[7px]" aria-hidden="true">
        {dot}
      </span>
    )
  }
  // Tappable: inflate the hit target to 28×28 via padding, then collapse the
  // surrounding layout with a negative margin so the visual dot stays tiny.
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 p-3 -m-3 mt-[-5px] flex items-center justify-center active:scale-110 transition-transform"
      title={`${session.label} — ${session.cwd}`}
      aria-label={`Target ${session.label}`}
    >
      {dot}
    </button>
  )
}

export function SessionBadge({ session, onClick }: { session: Session; onClick?: () => void }) {
  const hue = hashHue(session.key)
  const label = session.label || shortKey(session.key)
  const inner = (
    <>
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: `hsl(${hue} 70% 55%)` }}
      />
      {label}
    </>
  )
  const style = {
    backgroundColor: `hsl(${hue} 70% 55% / 0.15)`,
    color: `hsl(${hue} 70% 70%)`,
  }
  // Static badge (ActivityPill, ApprovalCard header) — keep the compact pill
  // look, no tap affordance required.
  if (!onClick) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
        style={style}
        title={`${label} — ${session.cwd}`}
      >
        {inner}
      </span>
    )
  }
  // Tappable (feed rows) — grow to HIG minimum so it's reachable on iPhone.
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-2 min-h-[44px] rounded text-[10px] font-semibold uppercase tracking-wider active:scale-95 transition-transform"
      style={style}
      title={`${label} — ${session.cwd}`}
    >
      {inner}
    </button>
  )
}
