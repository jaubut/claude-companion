# Body API (living-system nervous system)

Server: `server/routes/body.ts` (HTTP), `server/lib/body.ts` (Turso read model,
30 s cache, brain digest, health-intent predicate), `server/lib/body-alert.ts`
(validation, push ownership, payload, push gate), `server/wiring/body.ts` (live
snapshot + alert sink). Auth: the standard `/api/*` bearer gate.

The collectors (separate repo/builder) write three Turso tables; this server
only **reads** them:

```
body_components(id, host, kind, name, schedule_s, criticality, depends_on JSON, notes, first_seen, last_seen, retired)
body_vitals(component_id, observed_at, state, last_exit, last_run_at, last_ok_at, runs_total, runs_delta, consecutive_failures, detail)
body_events(id, component_id, at, kind, from_state, to_state, detail)
```

`state` ∈ `ok | failing | dead | crash_loop | dormant | stopped | unknown`. A
component with no vitals row, or a state outside that list, reads `unknown`.
Timestamps and other cells are passed through as Turso returns them (string,
number or `null`) — the server does not reformat them.

## `GET /api/body`

Query: `?all=1` includes retired components; `?fresh=1` bypasses the 30 s cache.

```json
{
  "ok": true,
  "generated_at": "2026-10-03T12:00:00.000Z",
  "summary": { "ok": 38, "failing": 1, "dead": 1, "crash_loop": 0, "dormant": 2, "stopped": 0, "unknown": 1, "total": 43 },
  "components": [
    {
      "id": "mac:launchd:backup", "host": "mac", "kind": "launchd", "name": "backup",
      "criticality": "critical", "state": "failing",
      "last_run_at": "…", "last_ok_at": "…", "last_exit": 1,
      "consecutive_failures": 3, "detail": "exit 1",
      "depends_on": ["zettlab:zfs:tank"], "dependents_count": 0
    }
  ],
  "recent_events": [
    { "id": 812, "component_id": "mac:launchd:backup", "at": "…", "kind": "transition", "from_state": "ok", "to_state": "failing", "detail": null }
  ]
}
```

- `components` ordered by `id`; `summary` counts exactly the returned components.
- `depends_on`: parsed JSON array of ids (`[]` when absent/invalid).
- `dependents_count`: number of **non-retired** components whose `depends_on` lists this id.
- `recent_events`: last 50 across all components, newest first (not filtered by `retired`).
- `consecutive_failures` is always a number (`0` when absent).

## `GET /api/body/component/:id`

The id may contain `:` — send it raw or percent-encoded (`mac%3Alaunchd%3Abackup`).
404 `{ok:false, error:"no such component"}`; malformed encoding → 400.

```json
{
  "ok": true,
  "generated_at": "…",
  "component": {
    "id": "zettlab:zfs:tank", "host": "zettlab", "kind": "zfs", "name": "tank", "schedule_s": 300,
    "criticality": "critical", "depends_on": [], "notes": null, "first_seen": "…", "last_seen": "…",
    "retired": false, "dependents": ["mac:launchd:backup", "zettlab:systemd:kb-api"], "dependents_count": 2
  },
  "vitals": {
    "component_id": "zettlab:zfs:tank", "observed_at": "…", "state": "ok", "last_exit": 0,
    "last_run_at": "…", "last_ok_at": "…", "runs_total": 1200, "runs_delta": 1,
    "consecutive_failures": 0, "detail": null
  },
  "events": [ { "id": 1, "component_id": "zettlab:zfs:tank", "at": "…", "kind": "…", "from_state": "…", "to_state": "…", "detail": null } ]
}
```

`vitals` is the latest row (or `null`); `events` is that component's last 50, newest first.
Not cached.

## `POST /api/body/alert`

```json
{ "component_id": "mac:launchd:backup", "severity": "critical", "title": "backup dead", "message": "exit 1 three runs in a row", "state": "dead", "from_state": "failing" }
```

`component_id`, `severity` (`critical|warning|info`), `title`, `message` required
(400 `{ok:false, error}` otherwise); `state`/`from_state` optional strings.
Reply `{ "ok": true }`. Effects:

1. **Turn** in the orchestrator channel `body` (name "Body", created on first
   alert — an `orchestrator_channel` frame goes out then), role `orchestrator`,
   text `title + "\n" + message`, followed by the usual `orchestrator` frame.
   `#Body` never auto-dispatches (the toggle is refused with 400 and the brain
   only ever proposes there).
2. **WS frame** on every alert:
   `{"type":"body_alert","alert":{"component_id","severity","title","message","state","from_state","at"}}`
   (`state`/`from_state` are `null` when not sent; `at` is ISO 8601 UTC).
3. **APNs push** (category `body_alert`, `threadId` `body`,
   userInfo `{"kind":"body_alert","component_id":…}`, body ≤ 180 chars):
   - `critical` → `time-sensitive` (sound); `warning` → `active` (sound).
     `collapseId` = `body-<component_id>` (sha256 form when > 64 bytes).
   - At most **1 push per component per 15 min**. Alerts inside the window are
     coalesced: when it closes, one trailing push carries the worst (then the
     latest) of them with `(+N more in 15 min)`. An `info` alert with
     `state:"ok"` for that component drops the pending trailing push.
   - `info` → no push, except a title starting `Body report`: once per local day,
     `passive` (no sound, priority 5), `collapseId` `body-report`.
   - `interruptionLevel` is applied on direct APNs sends; the broker path
     receives the payload as-is and may ignore it.

### Who pushes (no double-fire)

Every host's collector posts to **its own** server; in forward mode
(`COMPANION_VAULT_UPSTREAM` set, i.e. the Mac) this endpoint is still handled
locally. A server pushes only if it has an APNs sender (`apnsConfigured()`) **and**
owns the component:

| component id prefix | pushing server |
|---|---|
| `mac:*` | Mac |
| `zettlab:*`, `cloud:*`, any other prefix | Zettlab |
| no `host:` prefix | whichever server received it |

Server identity: `COMPANION_BODY_HOST=mac|zettlab`, else `darwin` → mac,
anything else → zettlab. A non-owning server still records the turn and sends
the frame. Consequence: a `mac:*` alert only pushes if the Mac has APNs
configured (direct or broker).

## Orchestrator brain ("brain's face")

`wiring/orchestrator.ts runBrain` calls `bodyDigestFor(channel, text)`: for every
message in `#Body`, and for a health question anywhere (`isHealthIntent`: "how's
the body", "what's broken", "status", "health", "is everything ok", FR variants),
a ≤ 800-char digest from the cached `GET /api/body` snapshot is added to the
gate and compose prompts as "Live system context". Turso down → a one-line
"unreachable" note instead.

## iOS "Body" view — what to decode

- List: `GET /api/body` → header from `summary`, rows from `components`
  (badge `state`, sort problems first client-side), a feed from `recent_events`.
- Detail: `GET /api/body/component/<percent-encoded id>`.
- Live: `body_alert` frame → refresh the list (or patch the row by `component_id` + `state`).
- Push tap: userInfo `kind == "body_alert"` → open the detail for `component_id`.
- The `#Body` channel is a normal orchestrator channel (`id:"body"`).
