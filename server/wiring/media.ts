import { getFeed, onFeedEvict } from "../lib/feed"
import { releaseMedia } from "../lib/media"

// Media lifecycle wiring (RES-L5NG step 3): the feed is the only thing that
// frees image files. When events leave the feed (200-cap trim or session
// prune), unlink every mediaId they referenced that no surviving event still
// points at — the store is content-addressed, so two events can share a file.
// Read-only observer per the onFeedEvict contract: it never touches the feed.
// Registered at import time, like wiring/events.ts.

onFeedEvict((evicted) => {
  const ids = new Set<string>()
  for (const ev of evicted) if (ev.mediaId) ids.add(ev.mediaId)
  if (ids.size === 0) return
  for (const ev of getFeed()) if (ev.mediaId) ids.delete(ev.mediaId)
  releaseMedia(ids)
})
