import { useEffect, useState } from "react"
import type { FeedEvent, Session } from "@/hooks/use-companion"
import { SessionDot, SessionBadge } from "@/components/session-badge"
import { formatTime, formatDuration } from "@/lib/format"
import { TOOL_ICONS } from "@/lib/tool-summary"
import { fetchMedia, readAuthToken, type MediaResult } from "@/lib/media"
import { Terminal, User, MessageSquare, ImageOff } from "lucide-react"

export function FeedLine({ ev, sessions, onPickKey }: { ev: FeedEvent; sessions: Session[]; onPickKey: (key: string) => void }) {
  const time = formatTime(ev.ts)
  // Match the event to its originating session using the strongest identity
  // first. Matching by cwd alone mislabels events when two Claude windows
  // share a cwd (common when running both Claude + a subagent from the same
  // repo).
  const session =
    (ev.tty ? sessions.find(s => s.tty === ev.tty) : undefined) ??
    (ev.sessionId ? sessions.find(s => s.sessionId === ev.sessionId) : undefined) ??
    (ev.cwd ? sessions.find(s => s.cwd === ev.cwd) : undefined)
  const handlePick = (): void => {
    if (session?.key) onPickKey(session.key)
  }

  if (ev.kind === "user_prompt") {
    return (
      <div className="flex flex-col gap-1 py-2 border-t border-outline-variant/20 mt-2 pt-3 first:mt-0 first:border-t-0 first:pt-0">
        <div className="flex items-center gap-2">
          <span className="text-muted/50 shrink-0">{time}</span>
          <User className="w-3.5 h-3.5 text-accent shrink-0" />
          {session ? <SessionBadge session={session} onClick={handlePick} /> : null}
        </div>
        {ev.text && (
          <div className="whitespace-pre-wrap break-words text-fg pl-[52px]">{ev.text}</div>
        )}
      </div>
    )
  }

  if (ev.kind === "assistant_text") {
    return (
      <div className="flex gap-2 py-1">
        <span className="text-muted/40 shrink-0">{time}</span>
        <SessionDot session={session} onClick={handlePick} />
        <span className="whitespace-pre-wrap break-words text-fg/90 flex-1">{ev.text}</span>
      </div>
    )
  }

  if (ev.kind === "turn_end") {
    return (
      <div className="my-2 rounded-xl bg-fg/[0.03] border border-outline-variant/30 p-3">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted/60 mb-2">
          <MessageSquare className="w-3 h-3" />
          {session ? <SessionBadge session={session} onClick={handlePick} /> : null}
          <span className="ml-auto font-mono">{time}</span>
        </div>
        {ev.text ? (
          <div className="whitespace-pre-wrap break-words text-fg/90 text-[12px]">{ev.text}</div>
        ) : (
          <div className="text-muted/50 text-[11px] italic">turn ended</div>
        )}
      </div>
    )
  }

  if (ev.kind === "tool_start") {
    const Icon = TOOL_ICONS[ev.tool ?? ""] ?? Terminal
    return (
      <div className="flex items-start gap-2 py-1">
        <span className="text-muted/40 shrink-0">{time}</span>
        <SessionDot session={session} onClick={handlePick} />
        <Icon className="w-3.5 h-3.5 mt-0.5 text-muted shrink-0" />
        <span className="font-semibold text-fg shrink-0">{ev.tool}</span>
        {ev.summary && (
          <span className="text-muted break-all flex-1">{ev.summary}</span>
        )}
        {ev.verdict && <VerdictBadge verdict={ev.verdict} />}
      </div>
    )
  }

  if (ev.kind === "tool_end") {
    return (
      <div className="flex items-center gap-2 py-0.5 text-muted/60 text-[11px]">
        <span className="shrink-0">{time}</span>
        <SessionDot session={session} onClick={handlePick} />
        <span className="opacity-50 shrink-0">└</span>
        <span className="shrink-0">{ev.tool}</span>
        {typeof ev.durationMs === "number" && (
          <span className="font-mono opacity-70">{formatDuration(ev.durationMs)}</span>
        )}
      </div>
    )
  }

  if (ev.kind === "image" && ev.mediaId) {
    return (
      <div className="flex items-start gap-2 py-1">
        <span className="text-muted/40 shrink-0">{time}</span>
        <SessionDot session={session} onClick={handlePick} />
        <FeedImage mediaId={ev.mediaId} width={ev.width} height={ev.height} caption={ev.caption} />
      </div>
    )
  }

  return null
}

type ImageState = { status: "loading" } | MediaResult

function FeedImage({ mediaId, width, height, caption }: { mediaId: string; width?: number; height?: number; caption?: string }) {
  const [state, setState] = useState<ImageState>({ status: "loading" })
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let url = ""
    let live = true
    setState({ status: "loading" })
    void fetchMedia(mediaId, readAuthToken()).then(r => {
      if (r.status === "ok") url = r.url
      if (live) setState(r)
      else if (url) URL.revokeObjectURL(url)
    })
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [mediaId])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  // Reserve the box from the event's dimensions so the feed doesn't jump
  // when the bytes land.
  const aspect = width && height ? `${width} / ${height}` : undefined
  const alt = caption || "image"

  return (
    <figure className="flex flex-col gap-1 flex-1 min-w-0">
      {state.status === "ok" ? (
        <button type="button" onClick={() => setOpen(true)} className="self-start max-w-[240px]" aria-label={`Open ${alt} full size`}>
          <img src={state.url} alt={alt} width={width} height={height} style={{ aspectRatio: aspect }} className="block w-full h-auto max-h-48 object-contain rounded-lg border border-outline-variant/30" />
        </button>
      ) : state.status === "loading" ? (
        <div data-media-state="loading" style={{ aspectRatio: aspect ?? "4 / 3" }} className="w-[160px] max-h-48 rounded-lg bg-fg/[0.05] animate-pulse" />
      ) : (
        <div data-media-state={state.status} className="flex items-center gap-1.5 text-muted/60 text-[11px] italic">
          <ImageOff className="w-3.5 h-3.5" />
          {state.status === "expired" ? "image expired" : `image unavailable (${state.message})`}
        </div>
      )}
      {caption && <figcaption className="text-muted text-[11px] break-words">{caption}</figcaption>}
      {open && state.status === "ok" && (
        <div role="dialog" aria-label={alt} onClick={() => setOpen(false)} className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 cursor-zoom-out">
          <img src={state.url} alt={alt} className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </figure>
  )
}

function VerdictBadge({ verdict }: { verdict: NonNullable<FeedEvent["verdict"]> }) {
  const styles: Record<NonNullable<FeedEvent["verdict"]>, string> = {
    "auto-allow": "bg-green/10 text-green",
    "auto-deny": "bg-red/10 text-red",
    "approved": "bg-green/10 text-green",
    "denied": "bg-red/10 text-red",
    "pending": "bg-accent/15 text-accent",
  }
  const label: Record<NonNullable<FeedEvent["verdict"]>, string> = {
    "auto-allow": "auto",
    "auto-deny": "blocked",
    "approved": "ok",
    "denied": "denied",
    "pending": "asking",
  }
  return (
    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold ${styles[verdict]}`}>
      {label[verdict]}
    </span>
  )
}
