import { sweepMedia } from "../lib/media"

// Media lifetime wiring. Files are NOT freed on feed eviction (neither the
// 200-cap trim nor a session prune): the phone keeps its own cached
// conversation, often older than the feed window, and still fetches those
// images by id; and the store is content-addressed, so one file can back
// events from several sessions. lib/media.ts removes files only by age
// (COMPANION_MEDIA_MAX_AGE, default 7 days) or the byte cap — swept on every
// write and here on a 1 h timer so an idle server still ages files out.
// Registered at import time, like wiring/events.ts.

const SWEEP_MS = 60 * 60 * 1000

sweepMedia()
setInterval(sweepMedia, SWEEP_MS).unref()
