# Auto-compact API (smart /compact between tasks)

Server: `server/lib/auto-compact.ts` (gates, transcript tail parsing,
controller), `server/wiring/auto-compact.ts` (tmux / APNs / fs deps),
`server/routes/auto-compact.ts` (HTTP). Auth: the standard `/api/*` bearer gate.

**Off by default.** Enabled only when `AUTO_COMPACT_TOKENS` is set to a
positive number (e.g. `600000`). Unset, blank, `0`, negative or non-numeric =
off. GET `/api/auto-compact` reports the effective `threshold` (0 = off).

## Endpoints

```
GET  /api/auto-compact
  → 200 { threshold: number, pending: [{ key, phase, name, tokens }] }
     phase: "scheduled" | "countdown" | "injecting" | "awaiting_boundary"

POST /api/auto-compact/cancel
  body  { key: string }          // session key from the push userInfo.key
  → 200 { ok: true, cancelled: boolean }  // false = nothing cancellable (already typed / gone)
  → 400 { ok: false, error: "key_required" }
```

Cancel works only in `scheduled` / `countdown`. A cancel (like a prompt or
typing in the pane) also starts the 30 min per-session cooldown.

## Push contract (for the iOS Cancel action)

Countdown push (`apns-collapse-id` = `compact-<sha1(key)[:16]>`, the result push
replaces it):

```
category:   "auto_compact"
title:      "compacting <name> in 60s"
body:       "Context <X> tokens. To cancel, type anything in the session's pane."
userInfo:   { key, sessionId, action: "auto_compact_cancel", cancelPath: "/api/auto-compact/cancel" }
```

Result push: category `auto_compact_done`, title
`compacted <name>: <X> -> <Y> tokens`, passive.

### iOS work still open (claude-companion-ios)

The `auto_compact` category has **no registered action yet**, so a tap only
opens the app; the push body tells the user to cancel by typing in the pane.
To wire it:

1. Register `UNNotificationCategory("auto_compact")` with one action
   `"auto_compact_cancel"` titled "Cancel" (`.destructive`, no foreground
   needed).
2. On that action: `POST <host><userInfo.cancelPath>` with the bearer token and
   JSON `{ "key": userInfo.key }`, to the host that sent the push.
3. Treat `cancelled: false` as "too late" (the `/compact` was already typed).

Once shipped, the countdown body can go back to "Tap Cancel to keep it as is."
