import { useState } from "react"
import { useCompanion } from "@/hooks/use-companion"
import { unlockAudio } from "@/lib/alert-sound"
import { ActivityPill } from "@/components/activity-pill"
import { TerminalFeed } from "@/components/terminal-feed"
import { ApprovalCard } from "@/components/approval-card"
import { TargetBar } from "@/components/target-bar"
import { Composer } from "@/components/composer"
import { StatusBar } from "@/components/status-bar"

export function App() {
  const {
    connected, pending, waitingForInput, waitingByKey, targetWaiting,
    activity, activities, targetActivity, feed, sessions, approve, deny, sendInput,
    soundEnabled, setSoundEnabled,
    targetKey, setTargetKey, effectiveTarget,
    pinnedOffline, injectError, clearInjectError,
  } = useCompanion()
  const [picking, setPicking] = useState(false)
  const sendTarget = effectiveTarget?.key ?? targetKey ?? ""
  // The pill follows the session we'd send to; the host rollup is the fallback
  // when that session isn't working (PRJ-OR1T Phase 10).
  const pillActivity = targetActivity ?? activity

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
      {pillActivity && !pendingRequest && (
        <ActivityPill activity={pillActivity} sessions={sessions} />
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
          waitingByKey={waitingByKey}
          activities={activities}
          targetWaiting={targetWaiting}
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
          targetWaiting={targetWaiting}
          sendTarget={sendTarget}
          sendInput={sendInput}
          onFocusInput={() => setPicking(false)}
        />
      </div>
    </div>
  )
}
