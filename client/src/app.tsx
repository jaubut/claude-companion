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
  const { connected, pending, waitingForInput, approve, deny, sendInput } = useCompanion()
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

      // Auto-send on final result
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

      {/* Card stack area */}
      <div className="flex-1 flex items-center justify-center p-4">
        {pending.length === 0 && !waitingForInput ? (
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
        ) : pending.length > 0 ? (
          <div className="relative w-full max-w-sm" style={{ height: "min(70dvh, 480px)" }}>
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
        ) : (
          /* Waiting for input — big input card */
          <div className="w-full max-w-sm">
            <div className="rounded-3xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden shadow-2xl">
              <div className="px-6 py-8 text-center">
                <div className="w-14 h-14 rounded-2xl bg-[var(--blue)]/15 flex items-center justify-center mx-auto mb-4">
                  <MessageSquare className="w-7 h-7 text-[var(--blue)]" />
                </div>
                <div className="text-lg font-bold mb-1">Claude is waiting</div>
                <div className="text-sm text-[var(--muted)]">Type or dictate your response</div>
              </div>

              <div className="px-4 pb-4 space-y-3">
                {/* Text input */}
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                  placeholder="Your response..."
                  rows={3}
                  className="w-full bg-[var(--bg)] rounded-2xl px-4 py-3 text-base text-[var(--fg)] placeholder:text-[var(--muted)]/40 focus:outline-none focus:ring-1 focus:ring-[var(--blue)] resize-none"
                />

                {/* Action row */}
                <div className="flex gap-3">
                  {hasSpeech && (
                    <button
                      onClick={toggleVoice}
                      className={`flex items-center justify-center w-16 py-4 rounded-2xl transition-all active:scale-95 ${
                        listening
                          ? "bg-[var(--red)]/15 text-[var(--red)]"
                          : "bg-[var(--border)] text-[var(--muted)]"
                      }`}
                    >
                      {listening ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
                    </button>
                  )}
                  <button
                    onClick={handleSend}
                    disabled={!text.trim()}
                    className="flex-1 flex items-center justify-center gap-2 py-4 rounded-2xl bg-[var(--blue)]/15 text-[var(--blue)] font-bold text-lg active:scale-95 transition-transform disabled:opacity-30"
                  >
                    <Send className="w-6 h-6" />
                    Send
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
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
