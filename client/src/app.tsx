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

function ActivityPill({ activity, sessions }: { activity: Activity; sessions: Session[] }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsedSec = Math.max(0, Math.floor((now - activity.turnStartedAt) / 1000))
  const stale = now - activity.lastBeatAt > 30_000
  const toolSummary = [activity.tool, activity.summary && truncate(activity.summary, 40)].filter(Boolean).join(" ")
  const session = activity.tty
    ? sessions.find(s => s.tty === activity.tty)
    : activity.sessionId
      ? sessions.find(s => s.sessionId === activity.sessionId)
      : activity.cwd
        ? sessions.find(s => s.cwd === activity.cwd)
        : undefined

  return (
    <div className="px-5 pb-2 shrink-0">
      <div className={`flex items-center gap-2 px-3 py-2 rounded-full glass-card text-[12px] ${stale ? "text-red" : "text-muted"}`}>
        <Loader2 className={`w-3.5 h-3.5 shrink-0 ${stale ? "" : "animate-spin"}`} />
        {session && <SessionBadge session={session} />}
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

function TerminalFeed({ feed, sessions, onPickKey }: { feed: FeedEvent[]; sessions: Session[]; onPickKey: (key: string) => void }) {
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

function FeedLine({ ev, sessions, onPickKey }: { ev: FeedEvent; sessions: Session[]; onPickKey: (key: string) => void }) {
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

  return null
}

function hashHue(s: string): number {
  if (!s) return 210
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h) % 360
}

function shortKey(key: string): string {
  if (!key) return "—"
  const colon = key.indexOf(":")
  const value = colon >= 0 ? key.slice(colon + 1) : key
  const last = value.split("/").filter(Boolean).pop() ?? value
  return last.length > 18 ? last.slice(0, 17) + "…" : last
}

function SessionDot({ session, onClick }: { session: Session | undefined; onClick?: () => void }) {
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

function SessionBadge({ session, onClick }: { session: Session; onClick?: () => void }) {
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
  sessions,
  onApprove,
  onDeny,
}: {
  request: ApprovalRequest
  sessions: Session[]
  onApprove: (id: string) => void
  onDeny: (id: string) => void
}) {
  const Icon = TOOL_ICONS[request.tool] ?? Terminal
  const summary = getToolSummary(request.tool, request.input)
  const session = request.cwd ? sessions.find(s => s.cwd === request.cwd) : undefined

  return (
    <div className="shrink-0 px-5 pt-2">
      <div className="w-full flex flex-col glass-card border border-accent/20">
        <div className="flex flex-col px-5 pt-4 pb-3">
          <div className="flex items-center gap-2 mb-3">
            {session && <SessionBadge session={session} />}
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
