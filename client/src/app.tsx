import { useEffect, useRef, useState } from "react"
import {
  useCompanion,
  type ApprovalRequest,
  type Activity,
  type FeedEvent,
  type Session,
} from "@/hooks/use-companion"
import { unlockAudio } from "@/lib/alert-sound"
import {
  Wifi, Check, X, FileEdit, Terminal, Eye, FileText, Search, FolderSearch,
  Mic, MicOff, Send, Volume2, VolumeX, Loader2, ChevronsDown, Globe, User,
  CornerDownLeft, ChevronDown, MessageSquare,
} from "lucide-react"

const TOOL_ICONS: Record<string, typeof Terminal> = {
  Edit: FileEdit,
  Write: FileText,
  Read: Eye,
  Bash: Terminal,
  Grep: Search,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
}

export function App() {
  const {
    connected, pending, waitingForInput, waitingMessage, waitingCwd,
    activity, feed, sessions, approve, deny, sendInput,
    soundEnabled, setSoundEnabled,
    targetCwd, setTargetCwd, effectiveTargetCwd,
    pinnedOffline, injectError, clearInjectError,
  } = useCompanion()
  const [text, setText] = useState("")
  const [listening, setListening] = useState(false)
  const [picking, setPicking] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  const handleSend = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    unlockAudio()
    sendInput(trimmed, effectiveTargetCwd || undefined)
    setText("")
  }

  const toggleSound = (): void => {
    unlockAudio()
    setSoundEnabled(!soundEnabled)
  }

  const toggleVoice = (): void => {
    unlockAudio()
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) return

    const recognition = new SR()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = "en-US"

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      const transcript = Array.from(e.results)
        .map(r => r[0]?.transcript ?? "")
        .join("")
      setText(transcript)

      const lastResult = e.results[e.results.length - 1]
      if (lastResult?.isFinal && transcript.trim()) {
        sendInput(transcript.trim(), effectiveTargetCwd || undefined)
        setText("")
      }
    }

    recognition.onend = () => setListening(false)
    recognition.onerror = () => setListening(false)

    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
  }

  const hasSpeech = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition)
  const pendingRequest = pending[0]

  return (
    <div className="h-dvh flex flex-col bg-bg overflow-hidden">
      {/* Status bar */}
      <header className="flex items-center gap-3 px-6 pt-5 pb-3 shrink-0">
        <div className={`w-2 h-2 rounded-full ${connected ? "bg-green" : "bg-red"}`} />
        <span className="text-[13px] font-semibold text-fg">
          {!connected ? "Offline" : pendingRequest ? "Asking" : waitingForInput ? "Done" : activity ? "Working" : "Idle"}
        </span>
        <div className="flex-1" />
        {pending.length > 1 && (
          <span className="text-xs text-muted font-mono">
            {pending.length} queued
          </span>
        )}
        <button
          onClick={toggleSound}
          aria-label={soundEnabled ? "Mute alerts" : "Unmute alerts"}
          className="p-1.5 -mr-1.5 rounded-full text-muted active:text-fg active:scale-95 transition-transform"
        >
          {soundEnabled
            ? <Volume2 className="w-[18px] h-[18px]" />
            : <VolumeX className="w-[18px] h-[18px]" />
          }
        </button>
      </header>

      {/* Live activity pill — only when feed is the focus */}
      {activity && !pendingRequest && (
        <ActivityPill activity={activity} />
      )}

      {/* Feed — always rendered, never overlapped */}
      <div className="flex-1 min-h-0">
        <TerminalFeed feed={feed} onPickCwd={setTargetCwd} />
      </div>

      {/* Docked asking panel — visible when an approval is pending */}
      {pendingRequest && (
        <ApprovalCard
          key={pendingRequest.id}
          request={pendingRequest}
          onApprove={(id) => { unlockAudio(); approve(id) }}
          onDeny={(id) => { unlockAudio(); deny(id) }}
        />
      )}

      {/* Input bar with target chip */}
      <div className="shrink-0 px-5 pt-2 pb-3 pb-safe space-y-2">
        {injectError && (
          <div
            onClick={clearInjectError}
            className="px-3 py-2 rounded-lg text-[11px] bg-red/15 text-red border border-red/30 active:scale-[0.98]"
          >
            {injectError.error === "target_gone"
              ? `⚠ pinned terminal isn't running — pick another session or unpin`
              : `⚠ inject failed (${injectError.error}) — check Accessibility permission for Terminal/iTerm`}
            <span className="float-right opacity-60">tap to dismiss</span>
          </div>
        )}
        <TargetBar
          sessions={sessions}
          effectiveCwd={effectiveTargetCwd}
          targetCwd={targetCwd}
          waitingCwd={waitingCwd}
          waitingForInput={waitingForInput}
          waitingMessage={waitingMessage}
          pinnedOffline={pinnedOffline}
          picking={picking}
          onTogglePick={() => setPicking(v => !v)}
          onPick={(cwd) => {
            setTargetCwd(cwd)
            setPicking(false)
          }}
        />

        <div className="glass-card flex items-center gap-2 px-4 py-2">
          {hasSpeech && (
            <button
              onClick={toggleVoice}
              className={`p-2 rounded-full shrink-0 transition-colors active:scale-95 ${
                listening
                  ? "text-red"
                  : "text-muted active:text-fg"
              }`}
            >
              {listening ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>
          )}
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSend() }}
            placeholder={waitingForInput ? "Reply…" : "Type into terminal…"}
            disabled={!connected}
            className="flex-1 bg-transparent py-2.5 text-sm text-fg placeholder:text-muted/40 focus:outline-none disabled:opacity-40"
          />
          <button
            onClick={handleSend}
            disabled={!connected || !text.trim()}
            className="p-2.5 rounded-full bg-accent text-bg disabled:opacity-20 shrink-0 transition-opacity active:scale-95"
          >
            <Send className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
    </div>
  )
}

function TargetBar({
  sessions, effectiveCwd, targetCwd, waitingCwd, waitingForInput, waitingMessage,
  pinnedOffline, picking, onTogglePick, onPick,
}: {
  sessions: Session[]
  effectiveCwd: string
  targetCwd: string
  waitingCwd: string
  waitingForInput: boolean
  waitingMessage: string
  pinnedOffline: boolean
  picking: boolean
  onTogglePick: () => void
  onPick: (cwd: string) => void
}) {
  if (sessions.length === 0 && !effectiveCwd) return null

  const showHint = waitingForInput && waitingMessage && waitingCwd === effectiveCwd
  const hue = hashHue(effectiveCwd)

  return (
    <div className="space-y-2">
      {showHint && (
        <div className="text-[11px] text-muted/70 px-1 line-clamp-2 italic">
          “{truncate(waitingMessage, 220)}”
        </div>
      )}
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-muted/60 shrink-0 flex items-center gap-1">
          <CornerDownLeft className="w-3 h-3" />
          send to
        </span>
        <button
          onClick={onTogglePick}
          disabled={sessions.length <= 1 && !effectiveCwd && !pinnedOffline}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-full glass-card text-fg disabled:opacity-50 active:scale-95 transition-transform ${pinnedOffline ? "ring-1 ring-red/50" : ""}`}
          style={{
            backgroundColor: pinnedOffline ? "hsl(0 70% 40% / 0.15)" : effectiveCwd ? `hsl(${hue} 70% 55% / 0.12)` : undefined,
            color: pinnedOffline ? "hsl(0 70% 75%)" : effectiveCwd ? `hsl(${hue} 70% 75%)` : undefined,
          }}
        >
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: pinnedOffline ? "hsl(0 70% 55%)" : `hsl(${hue} 70% 55%)` }}
          />
          <span className="font-semibold">{effectiveCwd ? sessionLabel(effectiveCwd) : "frontmost"}</span>
          {pinnedOffline && <span className="text-[10px] opacity-80">· offline</span>}
          {(sessions.length > 1 || pinnedOffline) && <ChevronDown className="w-3 h-3 opacity-60" />}
        </button>
        {targetCwd && (
          <button
            onClick={() => onPick("")}
            className="text-muted/50 underline-offset-2 hover:underline"
          >
            auto
          </button>
        )}
      </div>

      {picking && sessions.length > 0 && (
        <div className="glass-card p-1 max-h-48 overflow-y-auto space-y-0.5">
          <button
            onClick={() => onPick("")}
            className={`w-full text-left px-3 py-2 rounded-lg text-[12px] flex items-center gap-2 active:scale-[0.98] ${
              targetCwd === "" ? "bg-accent/10 text-accent" : "text-fg hover:bg-fg/5"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-muted/40" />
            <span className="font-semibold">Auto</span>
            <span className="text-muted/60 text-[11px]">most recent activity</span>
          </button>
          {sessions.map((s) => {
            const sHue = hashHue(s.cwd)
            const term = s.termProgram?.replace(/\.app$/i, "").replace(/_/g, " ")
            return (
              <button
                key={s.cwd}
                onClick={() => onPick(s.cwd)}
                className={`w-full text-left px-3 py-2 rounded-lg text-[12px] flex items-center gap-2 active:scale-[0.98] ${
                  targetCwd === s.cwd ? "bg-accent/10 text-accent" : "text-fg hover:bg-fg/5"
                }`}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0"
                  style={{ backgroundColor: `hsl(${sHue} 70% 55%)` }}
                />
                <span className="font-semibold truncate">{sessionLabel(s.cwd)}</span>
                <span className="flex-1 text-muted/60 text-[10px] font-mono truncate text-right">
                  {term ? `${term} · ` : ""}{s.tty.replace(/^\/dev\//, "") || "—"}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ActivityPill({ activity }: { activity: Activity }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsedSec = Math.max(0, Math.floor((now - activity.turnStartedAt) / 1000))
  const stale = now - activity.lastBeatAt > 30_000
  const toolSummary = [activity.tool, activity.summary && truncate(activity.summary, 40)].filter(Boolean).join(" ")

  return (
    <div className="px-5 pb-2 shrink-0">
      <div className={`flex items-center gap-2 px-3 py-2 rounded-full glass-card text-[12px] ${stale ? "text-red" : "text-muted"}`}>
        <Loader2 className={`w-3.5 h-3.5 shrink-0 ${stale ? "" : "animate-spin"}`} />
        {activity.cwd && <SessionBadge cwd={activity.cwd} />}
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

function TerminalFeed({ feed, onPickCwd }: { feed: FeedEvent[]; onPickCwd: (cwd: string) => void }) {
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
          <FeedLine key={ev.id} ev={ev} onPickCwd={onPickCwd} />
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

function FeedLine({ ev, onPickCwd }: { ev: FeedEvent; onPickCwd: (cwd: string) => void }) {
  const time = formatTime(ev.ts)
  const cwd = ev.cwd ?? ""

  if (ev.kind === "user_prompt") {
    return (
      <div className="flex flex-col gap-1 py-2 border-t border-outline-variant/20 mt-2 pt-3 first:mt-0 first:border-t-0 first:pt-0">
        <div className="flex items-center gap-2">
          <span className="text-muted/50 shrink-0">{time}</span>
          <User className="w-3.5 h-3.5 text-accent shrink-0" />
          <SessionBadge cwd={cwd} onClick={() => cwd && onPickCwd(cwd)} />
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
        <SessionDot cwd={cwd} onClick={() => cwd && onPickCwd(cwd)} />
        <span className="whitespace-pre-wrap break-words text-fg/90 flex-1">{ev.text}</span>
      </div>
    )
  }

  if (ev.kind === "turn_end") {
    // Show the final assistant message as the close-out instead of a horizontal divider.
    return (
      <div className="my-2 rounded-xl bg-fg/[0.03] border border-outline-variant/30 p-3">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted/60 mb-2">
          <MessageSquare className="w-3 h-3" />
          <SessionBadge cwd={cwd} onClick={() => cwd && onPickCwd(cwd)} />
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
        <SessionDot cwd={cwd} onClick={() => cwd && onPickCwd(cwd)} />
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
        <SessionDot cwd={cwd} onClick={() => cwd && onPickCwd(cwd)} />
        <span className="opacity-50 shrink-0">└</span>
        <span className="shrink-0">{ev.tool}</span>
        {typeof ev.durationMs === "number" && (
          <span className="font-mono opacity-70">{formatDuration(ev.durationMs)}</span>
        )}
      </div>
    )
  }

  return null
}

function hashHue(s: string): number {
  if (!s) return 210
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function sessionLabel(cwd: string): string {
  if (!cwd) return "—"
  const last = cwd.split("/").filter(Boolean).pop() ?? cwd
  return last.length > 18 ? last.slice(0, 17) + "…" : last
}

function SessionDot({ cwd, onClick }: { cwd: string; onClick?: () => void }) {
  const hue = hashHue(cwd)
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-1.5 h-1.5 rounded-full mt-[7px] shrink-0 active:scale-125 transition-transform"
      style={{ backgroundColor: `hsl(${hue} 70% 55%)` }}
      title={cwd}
      aria-label={cwd ? `Target ${cwd}` : "session"}
    />
  )
}

function SessionBadge({ cwd, onClick }: { cwd: string; onClick?: () => void }) {
  const hue = hashHue(cwd)
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider active:scale-95 transition-transform"
      style={{
        backgroundColor: `hsl(${hue} 70% 55% / 0.15)`,
        color: `hsl(${hue} 70% 70%)`,
      }}
      title={cwd}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ backgroundColor: `hsl(${hue} 70% 55%)` }}
      />
      {sessionLabel(cwd)}
    </button>
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

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s.toString().padStart(2, "0")}s`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m${rem.toString().padStart(2, "0")}s`
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}t`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

function ApprovalCard({
  request,
  onApprove,
  onDeny,
}: {
  request: ApprovalRequest
  onApprove: (id: string) => void
  onDeny: (id: string) => void
}) {
  const Icon = TOOL_ICONS[request.tool] ?? Terminal
  const summary = getToolSummary(request.tool, request.input)

  return (
    <div className="shrink-0 px-5 pt-2">
      <div className="w-full flex flex-col glass-card border border-accent/20">
        <div className="flex flex-col px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 mb-3">
            {request.cwd && <SessionBadge cwd={request.cwd} />}
            <span className="text-[10px] uppercase tracking-wider text-accent/80 font-semibold">approval needed</span>
          </div>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-accent-dim flex items-center justify-center shrink-0">
              <Icon className="w-5 h-5 text-accent" />
            </div>
            <span className="text-[18px] font-bold tracking-tight text-fg">{request.tool}</span>
          </div>
          {summary && (
            <div className="text-[12px] font-mono text-muted leading-relaxed whitespace-pre-wrap break-all max-h-[22dvh] overflow-y-auto">
              {summary}
            </div>
          )}
        </div>

        <div className="flex gap-2 px-3 pb-3">
          <button
            onClick={() => onDeny(request.id)}
            className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-red/8 text-red font-semibold text-sm active:scale-[0.97] transition-transform"
          >
            <X className="w-4 h-4" strokeWidth={2.5} />
            Deny
          </button>
          <button
            onClick={() => onApprove(request.id)}
            className="flex-[2] flex items-center justify-center gap-2 py-3 rounded-xl bg-green/10 text-green font-semibold text-sm active:scale-[0.97] transition-transform"
          >
            <Check className="w-4 h-4" strokeWidth={2.5} />
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

function getToolSummary(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Edit":
      return [
        input.file_path as string,
        input.old_string ? `\n- ${(input.old_string as string)}` : "",
        input.new_string ? `\n+ ${(input.new_string as string)}` : "",
      ].filter(Boolean).join("")
    case "Write":
      return [
        input.file_path as string,
        input.content ? `\n${(input.content as string)}` : "",
      ].filter(Boolean).join("")
    case "Read":
      return (input.file_path as string) ?? ""
    case "Bash":
      return (input.command as string) ?? ""
    case "Grep":
      return [
        `/${input.pattern as string ?? ""}/`,
        input.path ? ` in ${input.path as string}` : "",
      ].join("")
    case "Glob":
      return (input.pattern as string) ?? ""
    default:
      return JSON.stringify(input, null, 2)
  }
}

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}
