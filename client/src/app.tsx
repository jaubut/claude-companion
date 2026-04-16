import { useRef, useState } from "react"
import { useCompanion, type ApprovalRequest } from "@/hooks/use-companion"
import { Wifi, WifiOff, Check, X, FileEdit, Terminal, Eye, FileText, Search, FolderSearch, Mic, MicOff, Send, MessageSquare } from "lucide-react"

const TOOL_ICONS: Record<string, typeof Terminal> = {
  Edit: FileEdit,
  Write: FileText,
  Read: Eye,
  Bash: Terminal,
  Grep: Search,
  Glob: FolderSearch,
}

export function App() {
  const { connected, pending, waitingForInput, claudeMessage, approve, deny, sendInput } = useCompanion()
  const [text, setText] = useState("")
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    sendInput(trimmed)
    setText("")
  }

  const toggleVoice = () => {
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
    <div className="h-dvh flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-2 px-4 py-3 shrink-0">
        {connected
          ? <Wifi className="w-3.5 h-3.5 text-[var(--green)]" />
          : <WifiOff className="w-3.5 h-3.5 text-[var(--red)]" />
        }
        <span className="text-xs text-[var(--muted)]">
          {!connected ? "Connecting..." : waitingForInput ? "Claude is asking..." : "Listening"}
        </span>
        <div className="flex-1" />
        {pending.length > 1 && (
          <span className="text-xs text-[var(--muted)] font-mono">
            {pending.length} queued
          </span>
        )}
      </header>

      {/* Main content area */}
      <div className="flex-1 flex flex-col items-center justify-center p-4 gap-4 overflow-y-auto">
        {/* Claude's question banner */}
        {waitingForInput && claudeMessage && (
          <div className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-5 py-4">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare className="w-4 h-4 text-[var(--blue)] shrink-0" />
              <span className="text-xs font-semibold text-[var(--blue)]">Claude is asking</span>
            </div>
            <div className="text-sm text-[var(--fg)] leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap">
              {claudeMessage}
            </div>
          </div>
        )}

        {/* Approval card stack */}
        {pending.length > 0 ? (
          <div className="relative w-full max-w-sm" style={{ height: "min(55dvh, 400px)" }}>
            {pending.slice(0, 3).map((req, i) => {
              const isTop = i === 0
              const offset = i * 8
              const scale = 1 - i * 0.04
              const opacity = 1 - i * 0.15

              return (
                <div
                  key={req.id}
                  className="absolute inset-0 transition-all duration-300 ease-out"
                  style={{
                    transform: `translateY(${offset}px) scale(${scale})`,
                    opacity,
                    zIndex: 10 - i,
                    pointerEvents: isTop ? "auto" : "none",
                  }}
                >
                  <ApprovalCard
                    request={req}
                    onApprove={approve}
                    onDeny={deny}
                  />
                </div>
              )
            })}
          </div>
        ) : !waitingForInput && (
          <div className="text-center">
            <div className="opacity-15 mb-4">
              {connected
                ? <Check className="w-20 h-20 mx-auto" />
                : <WifiOff className="w-20 h-20 mx-auto" />
              }
            </div>
            <div className="text-sm text-[var(--muted)]/60">
              {!connected ? "Connecting..." : "No pending approvals"}
            </div>
          </div>
        )}
      </div>

      {/* Persistent input bar — always visible */}
      <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2 pb-safe">
        <div className="flex items-center gap-2">
          {hasSpeech && (
            <button
              onClick={toggleVoice}
              className={`p-2.5 rounded-full shrink-0 transition-colors active:scale-95 ${
                listening
                  ? "bg-[var(--red)]/15 text-[var(--red)]"
                  : "text-[var(--muted)] active:text-[var(--fg)]"
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
            className="flex-1 bg-[var(--bg)] rounded-xl px-4 py-2.5 text-sm text-[var(--fg)] placeholder:text-[var(--muted)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--blue)] disabled:opacity-40"
          />
          <button
            onClick={handleSend}
            disabled={!connected || !text.trim()}
            className="p-2.5 rounded-full bg-[var(--blue)] text-black disabled:opacity-30 shrink-0 transition-opacity active:scale-95"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
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
    <div className="h-full flex flex-col rounded-3xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-2xl">
      {/* Tool info */}
      <div className="flex-1 flex flex-col justify-center px-6 py-8">
        <div className="flex items-center gap-4 mb-5">
          <div className="w-14 h-14 rounded-2xl bg-[var(--blue)]/15 flex items-center justify-center">
            <Icon className="w-7 h-7 text-[var(--blue)]" />
          </div>
          <span className="text-2xl font-bold">{request.tool}</span>
        </div>
        {summary && (
          <div className="text-base font-mono text-[var(--muted)] break-all leading-relaxed max-h-40 overflow-y-auto">
            {summary}
          </div>
        )}
      </div>

      {/* Big action buttons */}
      <div className="flex gap-3 p-4 pt-0">
        <button
          onClick={() => onDeny(request.id)}
          className="flex-1 flex flex-col items-center justify-center gap-2 py-8 rounded-2xl bg-[var(--red)]/10 text-[var(--red)] font-bold text-xl active:scale-95 transition-transform"
        >
          <X className="w-10 h-10" strokeWidth={2.5} />
          Deny
        </button>
        <button
          onClick={() => onApprove(request.id)}
          className="flex-[2] flex flex-col items-center justify-center gap-2 py-8 rounded-2xl bg-[var(--green)]/15 text-[var(--green)] font-bold text-xl active:scale-95 transition-transform"
        >
          <Check className="w-10 h-10" strokeWidth={2.5} />
          Approve
        </button>
      </div>
    </div>
  )
}

function getToolSummary(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Edit":
    case "Read":
    case "Write":
      return (input.file_path as string) ?? ""
    case "Bash":
      return (input.command as string)?.slice(0, 200) ?? ""
    case "Grep":
      return `/${input.pattern as string ?? ""}/`
    case "Glob":
      return (input.pattern as string) ?? ""
    default:
      return JSON.stringify(input).slice(0, 150)
  }
}

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}
