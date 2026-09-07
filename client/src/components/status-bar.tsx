import type { Activity, ApprovalRequest } from "@/hooks/use-companion"
import { unlockAudio } from "@/lib/alert-sound"
import { Volume2, VolumeX } from "lucide-react"

export function StatusBar({
  connected, pending, pendingRequest, waitingForInput, activity, soundEnabled, setSoundEnabled,
}: {
  connected: boolean
  pending: ApprovalRequest[]
  pendingRequest: ApprovalRequest | undefined
  waitingForInput: boolean
  activity: Activity | null
  soundEnabled: boolean
  setSoundEnabled: (next: boolean) => void
}) {
  const toggleSound = (): void => {
    unlockAudio()
    setSoundEnabled(!soundEnabled)
  }

  return (
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
  )
}
