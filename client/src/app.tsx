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
import { SpawnSession } from "@/components/spawn-session"
import { TargetBar } from "@/components/target-bar"
import { Composer } from "@/components/composer"
import { StatusBar } from "@/components/status-bar"
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
  const [picking, setPicking] = useState(false)
  const sendTarget = effectiveTarget?.key ?? targetKey ?? ""

  const pendingRequest = pending[0]

  return (
    <div className="h-dvh flex flex-col bg-bg overflow-hidden">
      {/* Status bar */}
      <StatusBar
        connected={connected}
        pending={pending}
        pendingRequest={pendingRequest}
        waitingForInput={waitingForInput}
        activity={activity}
        soundEnabled={soundEnabled}
        setSoundEnabled={setSoundEnabled}
      />

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

        <Composer
          connected={connected}
          waitingForInput={waitingForInput}
          sendTarget={sendTarget}
          sendInput={sendInput}
          onFocusInput={() => setPicking(false)}
        />
      </div>
    </div>
  )
}
