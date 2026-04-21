import { useEffect, useRef, useState } from "react"
import { useCompanion, type ApprovalRequest, type Activity } from "@/hooks/use-companion"
import { unlockAudio } from "@/lib/alert-sound"
import { disablePush, enablePush, getSubscription, isPushSupported } from "@/lib/push"
import { Wifi, WifiOff, Check, X, FileEdit, Terminal, Eye, FileText, Search, FolderSearch, Mic, MicOff, Send, MessageSquare, Volume2, VolumeX, Loader2, Bell, BellOff } from "lucide-react"

const TOOL_ICONS: Record<string, typeof Terminal> = {
  Edit: FileEdit,
  Write: FileText,
  Read: Eye,
  Bash: Terminal,
  Grep: Search,
  Glob: FolderSearch,
}

export function App() {
  const { connected, pending, waitingForInput, claudeMessage, activity, approve, deny, sendInput, soundEnabled, setSoundEnabled } = useCompanion()
  const [text, setText] = useState("")
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    unlockAudio()
    sendInput(trimmed)
    setText("")
  }

  const toggleSound = () => {
    unlockAudio()
    setSoundEnabled(!soundEnabled)
  }

  // ── Push notifications ─────────────────────────────────────────────────
  type PushState = "unknown" | "unavailable" | "off" | "on" | "working"
  const [pushState, setPushState] = useState<PushState>("unknown")
  const [pushHint, setPushHint] = useState<string | null>(null)

  useEffect(() => {
    if (!isPushSupported()) {
      setPushState("unavailable")
      return
    }
    void getSubscription().then(sub => setPushState(sub ? "on" : "off"))
  }, [])

  const togglePush = async () => {
    if (pushState === "unavailable" || pushState === "working") return
    setPushState("working")
    setPushHint(null)
    if (pushState === "on") {
      await disablePush()
      setPushState("off")
      return
    }
    const r = await enablePush()
    if (r.ok) {
      setPushState("on")
    } else {
      setPushState("off")
      setPushHint(r.reason ?? "Could not enable notifications")
    }
  }

  const toggleVoice = () => {
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
        sendInput(transcript.trim())
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

  return (
    <div className="h-dvh flex flex-col bg-bg">
      {/* Status bar */}
      <header className="flex items-center gap-3 px-6 pt-5 pb-3 shrink-0">
        <div className={`w-2 h-2 rounded-full ${connected ? "bg-green" : "bg-red"}`} />
        <span className="text-[13px] font-semibold text-fg">
          {!connected ? "Offline" : waitingForInput ? "Asking" : "Connected"}
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
          className="p-1.5 rounded-full text-muted active:text-fg active:scale-95 transition-transform"
        >
          {soundEnabled
            ? <Volume2 className="w-[18px] h-[18px]" />
            : <VolumeX className="w-[18px] h-[18px]" />
          }
        </button>
        {pushState !== "unavailable" && (
          <button
            onClick={togglePush}
            aria-label={pushState === "on" ? "Disable push notifications" : "Enable push notifications"}
            disabled={pushState === "working"}
            className={`p-1.5 -mr-1.5 rounded-full active:scale-95 transition-transform ${
              pushState === "on" ? "text-fg" : "text-muted active:text-fg"
            }`}
          >
            {pushState === "on"
              ? <Bell className="w-[18px] h-[18px]" />
              : <BellOff className="w-[18px] h-[18px]" />}
          </button>
        )}
      </header>
      {pushHint && (
        <div className="px-5 py-2 text-[12px] text-muted bg-surface-container-low border-b border-outline-variant/40">
          {pushHint}
        </div>
      )}

      {/* Live activity pill — shows Claude is actually working */}
      {activity && !waitingForInput && pending.length === 0 && (
        <ActivityPill activity={activity} />
      )}

      {/* Main content — scrolls the outer box, inner column stays centered
          when content is short and grows past the viewport when it's long. */}
      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full flex flex-col items-center justify-center px-5 py-6 gap-5">
          {/* Claude question — no height cap, the outer scroll handles long text */}
          {waitingForInput && claudeMessage && (
            <div className="glass-card w-full max-w-sm px-6 py-5">
              <div className="flex items-center gap-2.5 mb-3">
                <MessageSquare className="w-4 h-4 text-accent shrink-0" />
                <span className="text-[13px] font-semibold text-accent">Claude is asking</span>
              </div>
              <div className="text-sm text-fg/90 leading-relaxed whitespace-pre-wrap break-words">
                {claudeMessage}
              </div>
            </div>
          )}

          {/* Approval card — rendered directly in the flow column. No stack
              container, no fixed height. The column's padding gives it room;
              the outer scroll picks up anything that overflows the viewport.
              The queued-count lives in the status bar, so we don't need the
              visual stack. */}
          {pending.length > 0 ? (
            <ApprovalCard
              key={pending[0]!.id}
              request={pending[0]!}
              onApprove={(id) => { unlockAudio(); approve(id) }}
              onDeny={(id) => { unlockAudio(); deny(id) }}
            />
          ) : !waitingForInput && (
            <IdleState connected={connected} />
          )}
        </div>
      </div>

      {/* Input bar */}
      <div className="shrink-0 px-5 py-4 pb-safe">
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
            placeholder={waitingForInput ? "Reply to Claude..." : "Type into terminal..."}
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

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s.toString().padStart(2, "0")}s`
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}t`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

function IdleState({ connected }: { connected: boolean }) {
  return (
    <div className="glass-card w-full max-w-sm px-8 py-10 text-center">
      <div className="mb-5">
        {connected
          ? <Wifi className="w-8 h-8 mx-auto text-muted/25" />
          : <WifiOff className="w-8 h-8 mx-auto text-muted/25" />
        }
      </div>
      <p className="text-[13px] text-muted">
        {!connected ? "Connecting..." : "No pending approvals"}
      </p>
    </div>
  )
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
    <div className="w-full max-w-sm flex flex-col glass-card">
      {/* Tool info — grows with content; no internal scrollers */}
      <div className="flex flex-col px-7 pt-8 pb-6">
        {request.cwd && (
          <p className="text-xs text-muted font-mono mb-4 truncate">
            {request.cwd.split("/").pop()}
          </p>
        )}
        <div className="flex items-center gap-4 mb-6">
          <div className="w-14 h-14 rounded-2xl bg-accent-dim flex items-center justify-center shrink-0">
            <Icon className="w-7 h-7 text-accent" />
          </div>
          <span className="text-[26px] font-bold tracking-tight text-fg">{request.tool}</span>
        </div>
        {summary && (
          <div className="text-[13px] font-mono text-muted leading-relaxed whitespace-pre-wrap break-all">
            {summary}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 px-5 pb-5">
        <button
          onClick={() => onDeny(request.id)}
          className="flex-1 flex flex-col items-center justify-center gap-2.5 py-7 rounded-2xl bg-red/8 text-red font-semibold text-lg active:scale-[0.97] transition-transform"
        >
          <X className="w-8 h-8" strokeWidth={2.5} />
          Deny
        </button>
        <button
          onClick={() => onApprove(request.id)}
          className="flex-[2] flex flex-col items-center justify-center gap-2.5 py-7 rounded-2xl bg-green/10 text-green font-semibold text-lg active:scale-[0.97] transition-transform"
        >
          <Check className="w-8 h-8" strokeWidth={2.5} />
          Approve
        </button>
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
