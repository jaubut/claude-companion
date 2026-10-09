import { CopyJobStore } from "../lib/copy-jobs"
import { resolveSessionKey } from "../lib/session-resolve"
import { broadcast } from "../state"

// Real deps for lib/copy-jobs.ts: the registry resolves a session id to the
// key the phone uses (no reporter hint on this path), frames go out on the
// shared broadcast.
export const copyJobs = new CopyJobStore({
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as unknown as { unref?: () => void }).unref?.()
    return t
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  resolveKey: (sessionId) => resolveSessionKey(sessionId, ""),
  // The literal type (already on the frame) is what archmap's frame scan reads.
  emit: (frame) => broadcast({ ...frame, type: "copy_jobs" }),
})
