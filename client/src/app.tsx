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
  hashHue, shortKey, formatTime, formatElapsed, formatDuration, formatTokens, truncate,
} from "@/lib/format"
import { TOOL_ICONS, getToolSummary } from "@/lib/tool-summary"
import { SessionDot, SessionBadge } from "@/components/session-badge"
import { ActivityPill } from "@/components/activity-pill"
import { FeedLine } from "@/components/feed-line"
import { TerminalFeed } from "@/components/terminal-feed"
import { ApprovalCard } from "@/components/approval-card"
import {
  Wifi, Check, X, FileEdit, Terminal, Eye, FileText, Search, FolderSearch,
  Mic, MicOff, Send, Volume2, VolumeX, Loader2, ChevronsDown, Globe, User,
  CornerDownLeft, ChevronDown, MessageSquare,
} from "lucide-react"

export function App() {
  const {
    connected, pending, waitingForInput, waitingMessage, waitingCwd, waitingKey,
    activity, feed, sessions, approve, deny, sendInput,
    soundEnabled, setSoundEnabled,
    targetKey, setTargetKey, effectiveTarget,
    pinnedOffline, injectError, clearInjectError,
  } = useCompanion()
  const [text, setText] = useState("")
  const [listening, setListening] = useState(false)
  const [picking, setPicking] = useState(false)
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

  const sendTarget = effectiveTarget?.key ?? targetKey ?? ""

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
          className="min-h-[44px] min-w-[44px] -mr-3 flex items-center justify-center rounded-full text-muted active:text-fg active:scale-95 transition-transform"
        >
          {soundEnabled
            ? <Volume2 className="w-[18px] h-[18px]" />
            : <VolumeX className="w-[18px] h-[18px]" />
          }
        </button>
      </header>

      {/* Live activity pill — only when feed is the focus */}
      {activity && !pendingRequest && (
        <ActivityPill activity={activity} sessions={sessions} />
      )}

      {/* Feed — always rendered, never overlapped */}
      <div className="flex-1 min-h-0">
        <TerminalFeed feed={feed} sessions={sessions} onPickKey={setTargetKey} />
      </div>

      {/* Docked asking panel — visible when an approval is pending */}
      {pendingRequest && (
        <ApprovalCard
          key={pendingRequest.id}
          request={pendingRequest}
          sessions={sessions}
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
              : injectError.error === "target_idle"
              ? `⚠ that terminal is idle — open it and run any command so it re-registers`
              : `⚠ inject failed (${injectError.error}) — check Accessibility permission for Terminal/iTerm`}
            <span className="float-right opacity-60">tap to dismiss</span>
          </div>
        )}
        <TargetBar
          sessions={sessions}
          effectiveTarget={effectiveTarget}
          targetKey={targetKey}
          waitingKey={waitingKey}
          waitingCwd={waitingCwd}
          waitingForInput={waitingForInput}
          waitingMessage={waitingMessage}
          pinnedOffline={pinnedOffline}
          picking={picking}
          onTogglePick={() => setPicking(v => !v)}
          onPick={(key) => {
            setTargetKey(key)
            setPicking(false)
          }}
        />

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
            onFocus={() => { setPicking(false); setSuggestionsOpen(true) }}
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
      </div>
    </div>
  )
}

const DEFAULT_SPAWN_CWDS = [
  "~/Cherrypik",
  "~/tls-dashboard-v2",
  "~/claude-companion",
  "~/tls-vault",
  "~",
]

async function spawnClaudeSession(cwd: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/spawn-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    })
    const data = await res.json()
    return res.ok ? { ok: true } : { ok: false, error: data.error || `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function TargetBar({
  sessions, effectiveTarget, targetKey, waitingKey, waitingCwd, waitingForInput, waitingMessage,
  pinnedOffline, picking, onTogglePick, onPick,
}: {
  sessions: Session[]
  effectiveTarget: Session | null
  targetKey: string
  waitingKey: string
  waitingCwd: string
  waitingForInput: boolean
  waitingMessage: string
  pinnedOffline: boolean
  picking: boolean
  onTogglePick: () => void
  onPick: (key: string) => void
}) {
  const [spawning, setSpawning] = useState(false)
  const [spawnCwd, setSpawnCwd] = useState("")
  const [spawnBusy, setSpawnBusy] = useState(false)
  const [spawnError, setSpawnError] = useState("")

  if (sessions.length === 0 && !effectiveTarget && !picking) return null

  const waitingMatches = effectiveTarget
    ? waitingKey === effectiveTarget.key || waitingCwd === effectiveTarget.cwd
    : false
  const showHint = waitingForInput && waitingMessage && waitingMatches
  const hue = hashHue(effectiveTarget?.key ?? "")
  // `??` falls through only on null/undefined — an empty string label
  // (provisional session from discovery) would still render as "" and force
  // the "frontmost" fallback below. Use `||` and derive from the key/tty so
  // the chip reads e.g. "s009" instead of the misleading "frontmost".
  const label = effectiveTarget?.label
    || (effectiveTarget?.tty ? shortKey(`tty:${effectiveTarget.tty}`) : "")
    || (effectiveTarget?.key ? shortKey(effectiveTarget.key) : "")
    || (targetKey ? shortKey(targetKey) : "")

  // Recent cwds derived from the session list, deduped + sorted by lastSeen.
  const recentCwds = Array.from(new Map(
    [...sessions].sort((a, b) => b.lastSeenAt - a.lastSeenAt).map(s => [s.cwd, s.cwd]),
  ).keys()).filter(Boolean)
  const spawnSuggestions = Array.from(new Set([...recentCwds, ...DEFAULT_SPAWN_CWDS]))

  async function doSpawn(cwd: string): Promise<void> {
    setSpawnError("")
    setSpawnBusy(true)
    const r = await spawnClaudeSession(cwd)
    setSpawnBusy(false)
    if (!r.ok) { setSpawnError(r.error ?? "failed"); return }
    setSpawning(false)
    setSpawnCwd("")
  }

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
                {idle && <span className="text-[10px] text-muted/60 italic shrink-0">idle</span>}
                <span className="flex-1 text-muted/60 text-[10px] font-mono truncate text-right">
                  {term ? `${term} · ` : ""}{s.tty.replace(/^\/dev\//, "") || "no tty"}
                </span>
              </button>
            )
          })}
          <div className="border-t border-fg/5 my-1" />
          <button
            onClick={() => { setSpawning(v => !v); setSpawnError("") }}
            className="w-full text-left px-3 py-3 min-h-[44px] rounded-lg text-[12px] flex items-center gap-2 text-fg hover:bg-fg/5 active:scale-[0.98]"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/70 shrink-0" />
            <span className="font-semibold">+ New Claude session</span>
            <span className="text-muted/60 text-[11px]">opens a new Terminal window on the Mac</span>
          </button>
          {spawning && (
            <div className="px-2 py-2 space-y-1">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={spawnCwd}
                  onChange={(e) => setSpawnCwd(e.target.value)}
                  placeholder="~/path/to/project or /absolute/path"
                  className="flex-1 bg-transparent border border-fg/10 rounded-md px-3 py-2 text-[12px] font-mono text-fg placeholder:text-muted/40 focus:outline-none focus:border-fg/30"
                />
                <button
                  onClick={() => doSpawn(spawnCwd)}
                  disabled={spawnBusy || !spawnCwd.trim()}
                  className="px-3 py-2 text-[11px] font-semibold rounded-md bg-accent text-bg disabled:opacity-30 active:scale-95"
                >
                  {spawnBusy ? "…" : "Spawn"}
                </button>
              </div>
              {spawnError && (
                <p className="text-[11px] text-red px-1">{spawnError}</p>
              )}
              <div className="space-y-0.5 pt-1">
                {spawnSuggestions.slice(0, 8).map((cwd) => (
                  <button
                    key={cwd}
                    onClick={() => doSpawn(cwd)}
                    disabled={spawnBusy}
                    className="w-full text-left px-3 py-2 min-h-[40px] rounded-md text-[11px] font-mono text-muted/80 hover:bg-fg/5 hover:text-fg active:scale-[0.98] disabled:opacity-40"
                  >
                    {cwd}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

declare global {
  interface Window {
    SpeechRecognition: typeof SpeechRecognition
    webkitSpeechRecognition: typeof SpeechRecognition
  }
}
