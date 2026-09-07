import { useEffect, useRef, useState } from "react"
import type { FeedEvent, Session } from "@/hooks/use-companion"
import { FeedLine } from "@/components/feed-line"
import { Wifi, ChevronsDown } from "lucide-react"

export function TerminalFeed({ feed, sessions, onPickKey }: { feed: FeedEvent[]; sessions: Session[]; onPickKey: (key: string) => void }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    if (!pinned) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [feed, pinned])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - (el.scrollTop + el.clientHeight)
    setPinned(distance < 48)
  }

  if (feed.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="text-center">
          <Wifi className="w-7 h-7 mx-auto text-muted/25 mb-3" />
          <p className="text-[13px] text-muted">Waiting for Claude...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full relative">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-5 py-3 font-mono text-[12px] leading-[1.55] text-fg/80"
      >
        {feed.map((ev) => (
          <FeedLine key={ev.id} ev={ev} sessions={sessions} onPickKey={onPickKey} />
        ))}
        <div className="h-4" />
      </div>
      {!pinned && (
        <button
          onClick={() => {
            setPinned(true)
            const el = scrollRef.current
            if (el) el.scrollTop = el.scrollHeight
          }}
          className="absolute bottom-3 right-4 flex items-center gap-1.5 px-3 py-1.5 rounded-full glass-card text-[11px] text-fg active:scale-95 transition-transform"
        >
          <ChevronsDown className="w-3.5 h-3.5" />
          Latest
        </button>
      )}
    </div>
  )
}
