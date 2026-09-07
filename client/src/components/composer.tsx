import { useRef, useState } from "react"
import { unlockAudio } from "@/lib/alert-sound"
import { Mic, MicOff, Send } from "lucide-react"

export function Composer({
  connected, waitingForInput, sendTarget, sendInput, onFocusInput,
}: {
  connected: boolean
  waitingForInput: boolean
  sendTarget: string
  sendInput: (text: string, key?: string) => void
  onFocusInput: () => void
}) {
  const [text, setText] = useState("")
  const [listening, setListening] = useState(false)
  const [history, setHistory] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("companion.history")
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : []
    } catch { return [] }
  })
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  const pushHistory = (entry: string): void => {
    const trimmed = entry.trim()
    if (!trimmed) return
    setHistory(prev => {
      const next = [trimmed, ...prev.filter(h => h !== trimmed)].slice(0, 50)
      try { localStorage.setItem("companion.history", JSON.stringify(next)) } catch {}
      return next
    })
  }

  // Filter history against current input. Empty input → most recent 4. Non-empty
  // → prefix matches first, then substring matches, dropping the current text
  // itself so we don't suggest what the user just typed verbatim.
  const suggestions = ((): string[] => {
    if (!suggestionsOpen) return []
    const q = text.trim().toLowerCase()
    if (!q) return history.slice(0, 4)
    const prefix: string[] = []
    const substring: string[] = []
    for (const h of history) {
      const lower = h.toLowerCase()
      if (lower === q) continue
      if (lower.startsWith(q)) prefix.push(h)
      else if (lower.includes(q)) substring.push(h)
    }
    return [...prefix, ...substring].slice(0, 4)
  })()

  const handleSend = (): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    unlockAudio()
    sendInput(trimmed, sendTarget || undefined)
    pushHistory(trimmed)
    setText("")
    setSuggestionsOpen(false)
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
        const finalText = transcript.trim()
        sendInput(finalText, sendTarget || undefined)
        pushHistory(finalText)
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
    <>
      {suggestions.length > 0 && (
        <div className="flex gap-2 overflow-x-auto -mx-1 px-1 scrollbar-none">
          {suggestions.map((s, i) => (
            <button
              key={`${s}-${i}`}
              // preventDefault on mousedown stops the input from blurring
              // when the chip is tapped — keeps the keyboard up and lets
              // the user edit the filled suggestion before sending.
              // onTouchEnd is the iOS 16 WebKit fallback: in some Safari
              // versions, preventDefault on the synthesized mousedown
              // suppresses the subsequent click, so we set the text on
              // touchEnd directly. The onClick still fires on desktop.
              onMouseDown={(e) => e.preventDefault()}
              onTouchEnd={(e) => { e.preventDefault(); setText(s) }}
              onClick={() => setText(s)}
              className="shrink-0 inline-flex items-center min-h-[44px] px-3.5 rounded-full bg-fg/10 text-fg/85 text-[12px] active:scale-95 active:bg-fg/20 max-w-[240px] truncate whitespace-nowrap"
            >
              {s}
            </button>
          ))}
        </div>
      )}

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
          onFocus={() => { onFocusInput(); setSuggestionsOpen(true) }}
          // Delay so a tap on a suggestion chip (which triggers blur first)
          // can register before the row unmounts.
          onBlur={() => setTimeout(() => setSuggestionsOpen(false), 150)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSend() }}
          enterKeyHint="send"
          placeholder={waitingForInput ? "Reply…" : "Type into terminal…"}
          disabled={!connected}
          className="flex-1 bg-transparent py-2.5 text-base text-fg placeholder:text-muted/40 focus:outline-none disabled:opacity-40"
        />
        <button
          onClick={handleSend}
          disabled={!connected || !text.trim()}
          className="p-2.5 rounded-full bg-accent text-bg disabled:opacity-20 shrink-0 transition-opacity active:scale-95"
        >
          <Send className="w-[18px] h-[18px]" />
        </button>
      </div>
    </>
  )
}

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}
