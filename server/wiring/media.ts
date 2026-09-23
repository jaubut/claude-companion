import { sweepMedia } from "../lib/media"

// Media lifetime wiring. Files are NOT freed on feed eviction (neither the
// 200-cap trim nor a session prune): the phone keeps its own cached
// conversation, often older than the feed window, and still fetches those
// images by id; and the store is content-addressed, so one file can back
// events from several sessions. lib/media.ts removes files only by age
// (COMPANION_MEDIA_MAX_AGE, default 7 days) or the byte cap — swept on every
// write and here on a 1 h timer so an idle server still ages files out.
//
// Started explicitly by cli.ts, NOT at import time: static imports are hoisted
// above cli.ts's loadDefaultDotEnv(), so an import-time sweep would run with
// the default 7-day age cap and delete files a longer configured
// COMPANION_MEDIA_MAX_AGE meant to keep (Codex on PR #45). Importing this
// module never touches the disk, so a test that pulls in companion-server.ts
// cannot sweep the developer's real ~/.claude-companion/media.

const SWEEP_MS = 60 * 60 * 1000

let timer: ReturnType<typeof setInterval> | null = null

// Idempotent. Returns the ids removed by the startup sweep.
export function startMediaSweeper(): string[] {
  if (timer) return []
  timer = setInterval(sweepMedia, SWEEP_MS)
  timer.unref()
  return sweepMedia()
}

export function stopMediaSweeper(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
