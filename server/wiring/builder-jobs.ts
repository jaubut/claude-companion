import { BuilderJobStore } from "../lib/builder-jobs"
import { broadcast } from "../state"

// Real deps for lib/builder-jobs.ts: frames go out on the shared broadcast.
export const builderJobs = new BuilderJobStore({
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as unknown as { unref?: () => void }).unref?.()
    return t
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  // The literal type (already on the frame) is what archmap's frame scan reads.
  emit: (frame) => broadcast({ ...frame, type: "builder_jobs" }),
})
