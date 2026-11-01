import { BRAIN_THREAD } from "../lib/brain"
import { getKv, setKv } from "../lib/brain-store"
import { companionLog } from "../lib/log"
import { appendTurn } from "../lib/orchestrator-chat"
import { tursoQuery } from "../lib/turso"
import { WATCH_TICK_MS, createTursoWatch } from "../lib/turso-watch"
import { orchEmit } from "./orchestrator"

// The brain's Turso watcher (lib/turso-watch.ts), started with the brain
// (companion-server.ts, COMPANION_BRAIN=1). Marks, dedupe and the pending batch
// live in companion.db (brain_kv), so a restart neither replays nor misses.
// Kill switch: COMPANION_BRAIN_WATCH=0.

const KV_KEY = "turso_watch"

const watch = createTursoWatch({
  query: tursoQuery,
  enabled: () => process.env.COMPANION_BRAIN_WATCH?.trim() !== "0",
  load: () => getKv(KV_KEY),
  save: (raw) => setKv(KV_KEY, raw),
  event: (text) => orchEmit(appendTurn("orchestrator", text, null, BRAIN_THREAD)),
  now: Date.now,
  log: companionLog,
})

let started = false

export function startTursoWatch(): void {
  if (started) return
  started = true
  const run = (): void => { void watch.tick().catch((err) => companionLog(`[turso-watch] tick failed: ${(err as Error)?.message ?? err}`)) }
  setInterval(run, WATCH_TICK_MS).unref?.()
  run()
}
