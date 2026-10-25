# Notify gate API

One front door for producer notifications (RES-6TV5): producers POST an event,
the gate decides **when** it reaches the phone. The idea: send a message only when
something needs Jeremie. Code: `server/lib/notify-gate.ts` (rules + store),
`server/routes/notify.ts` (HTTP + wiring). Auth: the `/api/*` bearer gate, the
same token as every other Companion route.

## POST /api/notify

```json
{
  "source": "body",
  "severity": "urgent",
  "title": "Zettlab disk 95 %",
  "body": "/ is at 95 %, the backup job will fail tonight.",
  "dedupKey": "zettlab-disk-root",
  "actionable": true,
  "url": "https://…"
}
```

| field | type | rule |
|---|---|---|
| `source` | string ≤ 80 | producer name, the report's row key |
| `severity` | `"urgent" \| "normal" \| "low"` | |
| `title` | string ≤ 200 | push title |
| `body` | string ≤ 4000 | push body |
| `dedupKey` | string ≤ 200 | dedup is on (source, dedupKey) over 24 h |
| `actionable` | boolean | does Jeremie have to do something? |
| `url` | http(s) string, optional | goes to push `userInfo.url` |

→ `200 {ok:true, id, decision, reason, mode, delivered}`. `decision` is one of
`now | checkin | brief | drop`. `delivered` is true when a push went out.
A bad field returns `400 {ok:false, error:"bad_<field>"}`.

### Decision order (first match wins)

1. Same (source, dedupKey) seen in the last 24 h → `drop` ("duplicate within 24 h").
2. `severity:"urgent"` + `actionable:true` → `now`, at any hour.
3. Outside waking hours (08:00–21:00 America/Toronto) → `brief`.
4. Preferences: the newest Turso note in folder `resources` tagged `notify-prefs`
   (a plain-words body, read and cached for 10 min) is judged by
   `claude-haiku-5-5` (override: `COMPANION_NOTIFY_MODEL`). The model returns JSON
   `{decision, reason}`. A verdict without a reason is rejected.
   - If there's no prefs note, the hard-rule baseline applies.
   - If the model errors, times out (20 s), returns bad JSON or gives no reason,
     or if the prefs note can't be read, the gate **fails open** to the baseline
     and logs reason `"fallback"`. It never drops silently.

Baseline: urgent + actionable → `now`, urgent (not actionable) or normal →
`checkin`, low → `brief`.

## Modes

`COMPANION_NOTIFY_GATE=shadow|live|off`, default `shadow`. If the kill file
`~/.claude/.notify-gate-disabled` exists, the mode is `off` whatever the env says.

| mode | behaviour |
|---|---|
| `off` | Passthrough: every event is pushed, with no dedup and no gating. The event is still logged (`origin:"off"`). |
| `shadow` | The gate decides and logs. A `now` event is pushed through the same path as `/api/push/broadcast` (category `briefing`). Other events are only logged. |
| `live` | Delivery is the same as `shadow` today. Hourly check-in and daily-brief delivery for held events is the next phase. |

## GET /api/notify/report?days=N

`N` must be an integer from 1 to 30 (default 7). This report is for the shadow review.

```json
{
  "ok": true, "days": 7, "since": "2026-10-18T…Z",
  "rows":   [{ "source": "body", "decision": "now", "count": 2 }],
  "counts": { "body": { "now": 2, "checkin": 0, "brief": 5, "drop": 1, "total": 8 } }
}
```

## Storage

Table `notify_events` in companion.db holds every event with its decision,
`reason`, `origin` (`rule|model|fallback|off`), `mode`, `delivered` and
`created_at` (ms). Rows older than 30 days are pruned on insert.

## Manual check

```bash
H="Authorization: Bearer $COMPANION_TOKEN"
curl -s -X POST localhost:$PORT/api/notify -H "$H" -d '{"source":"manual","severity":"urgent","title":"urgent test","body":"should push","dedupKey":"t1","actionable":true}'
curl -s -X POST localhost:$PORT/api/notify -H "$H" -d '{"source":"manual","severity":"low","title":"low test","body":"should be held","dedupKey":"t2","actionable":false}'
curl -s "localhost:$PORT/api/notify/report?days=1" -H "$H"
```
