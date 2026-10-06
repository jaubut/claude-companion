# Body API (living-system nervous system)

Server: `server/routes/body.ts` (HTTP), `server/lib/body.ts` (Turso read model,
30 s cache, brain digest, health-intent predicate), `server/lib/body-alert.ts`
(validation, push ownership, payload, push gate), `server/wiring/body.ts` (live
snapshot + alert sink). Auto-investigation: `server/lib/body-investigate.ts`
(policy + sqlite store), `server/lib/body-investigator.ts` (read-only `claude -p`
runner, prompt, parser), `server/lib/body-investigate-engine.ts` (engine, peer,
report effects), `server/wiring/body-investigate.ts` (live instance + sweeps).
Auth: the standard `/api/*` bearer gate.

The collectors (separate repo/builder) write three Turso tables; this server
only **reads** them:

```
body_components(id, host, kind, name, schedule_s, criticality, depends_on JSON, notes, first_seen, last_seen, retired)
body_vitals(component_id, observed_at, state, last_exit, last_run_at, last_ok_at, runs_total, runs_delta, consecutive_failures, detail)
body_events(id, component_id, at, kind, from_state, to_state, detail)
```

`state` ∈ `ok | warning | failing | dead | crash_loop | dormant | stopped | unknown`.
`warning` (e.g. a token-burn spike on `zettlab:tokens:burn`) is shown amber and
never counts as a failure: not in `problems`, not auto-investigated; its alerts
arrive at `warning` severity. A component with no vitals row, or a state outside that list, reads `unknown`.
Timestamps and other cells are passed through as Turso returns them (string,
number or `null`) — the server does not reformat them.

## `GET /api/body`

Query: `?all=1` includes retired components; `?fresh=1` bypasses the 30 s cache.

```json
{
  "ok": true,
  "generated_at": "2026-10-03T12:00:00.000Z",
  "summary": { "ok": 38, "warning": 0, "failing": 1, "dead": 1, "crash_loop": 0, "dormant": 2, "stopped": 0, "unknown": 1, "total": 43 },
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

`investigation` (additive) is this host's latest auto-investigation of the
component, or `null` when there is none:

```json
"investigation": {
  "id": "3f9a1c2e", "status": "done",
  "startedAt": "2026-10-04T12:00:00.000Z", "finishedAt": "2026-10-04T12:03:10.000Z",
  "rootCause": "The plist runs a script that was deleted", "confidence": 0.85, "severity": "high",
  "proposalId": "a1b2c3d4", "error": null
}
```

`status` ∈ `running | pending_host | forwarded | done | failed | dropped`
(`pending_host` = the owning host was unreachable, retried on the next sweep;
`forwarded` = running on the Mac; `dropped` = it recovered before its host was
reachable). `proposalId` is the #Body proposal card (`orchestrator_task.taskId`)
holding the fix, or `null` (no fix, a failure, or — on the Mac — a report that
went to Zettlab, which holds the card). `rootCause`/`confidence`/`severity` are
`null` until `done`.

## `GET /api/body/tokens`

Fleet token usage for the Body "Token burn" card. Server: `server/lib/body-tokens.ts`
(read model + cache). Reads the token-burn collector's Turso table (claude-config
`tools/body/`, every 5 min per host); this server never writes it:

```
token_usage(host, day, session_id, source, model, input, output, cache_read, cache_creation, turns,
            PRIMARY KEY(host, day, session_id, source, model))
```

`day` is the collector host's local `YYYY-MM-DD`; `source` is `main`,
`agent:<type>` or `skill:<name>`.

Query: `?range=today|7d|30d` (default `today`; anything else → 400
`{ok:false, error}`); `?fresh=1` bypasses the 30 s cache (one slot per range).

```json
{
  "ok": true,
  "generated_at": "2026-10-05T12:00:00.000Z",
  "range": "7d",
  "since": "2026-09-29",
  "pricing_as_of": "2026-10-06",
  "totals": { "input": 1215, "output": 90, "cache_read": 3300, "cache_creation": 10, "total": 4615, "usd": 0.0071, "unpriced_tokens": 0 },
  "by_host": [ { "host": "zettlab", "input": 910, "output": 0, "cache_read": 2000, "cache_creation": 0, "total": 2910, "usd": 0.0040, "unpriced_tokens": 0 } ],
  "by_day": [ { "day": "2026-10-05", "input": 1215, "output": 90, "cache_read": 3300, "cache_creation": 10, "total": 4615, "usd": 0.0071, "unpriced_tokens": 0 } ],
  "top_sessions": [ { "session_id": "0275ce20-…", "name": "tls-dashboard", "host": "mac", "total": 1705, "usd": 0.0031, "unpriced_tokens": 0 } ],
  "top_agents": [ { "name": "builder", "total": 500, "usd": 0.0008, "unpriced_tokens": 0 } ],
  "top_skills": [ { "name": "today", "total": 40, "usd": null, "unpriced_tokens": 40 } ]
}
```

- `since`: first day included, inclusive — `today` = today, `7d` = today and the
  6 days before, `30d` = today and the 29 before (this server's local calendar).
  Rows are filtered on `day >= since`.
- `total` = `input + output + cache_read + cache_creation`, everywhere. All
  counts are numbers (`0` when absent).
- `by_host`: total descending, then host. `by_day`: ascending by day; days with
  no rows are absent (the client fills gaps).
- `top_sessions` (≤ 10): total descending, then `session_id`, summed over all
  sources and models. `name` is the live session's name from this host's
  `~/.claude/sessions/*.json`, else `null` (ended sessions and other hosts'
  sessions).
- `top_agents` / `top_skills` (≤ 10): `source` rows with prefix `agent:` /
  `skill:`, prefix stripped into `name`; total descending, then name. `main`
  appears in neither.
- `usd`: what the tokens would cost at Claude API list prices (API-equivalent
  value; the account is on a subscription, so it is not what is billed), on
  every totals object and every top row. Priced per row by `model` from one
  table, `server/lib/model-prices.ts` (USD per MTok: input, output, cache read,
  and cache creation at the 5-minute write rate — `token_usage` does not split
  5 m / 1 h writes); standard rates, no batch / fast-mode / `inference_geo`
  multipliers. A model matches a table id exactly or with a date snapshot
  (`-20251001`), `[1m]` or `@…` suffix. Rounded to 1/10000 $. `null` when none
  of the row's tokens are priced.
- `unpriced_tokens`: tokens of models with no price (aliases like `sonnet`,
  ids newer than the table). They are in `total` but never in `usd` — never
  counted as $0; with `unpriced_tokens > 0` a non-null `usd` is a lower bound.
- `pricing_as_of`: the day the price table was read from the pricing page
  (`https://platform.claude.com/docs/en/about-claude/pricing`).
- No `token_usage` table yet (collector not deployed) → the same shape with zero
  totals and empty lists, not an error. Turso down → 503 `turso_unreachable`.

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

**All body alerts go to the Zettlab server.** Every collector — the Mac's
included — posts to Zettlab's Companion URL, so in practice Zettlab pushes
everything and owns the `#Body` channel. A server pushes body alerts iff:

- it has a push sender (`apnsConfigured()`: APNs direct or broker), **and**
- `COMPANION_BODY_PUSH` is not `"0"`.

Component id prefixes (`mac:*`, `zettlab:*`, `cloud:*`) play no part in the
decision. If an alert ever reaches another server (e.g. a collector pointed at
the Mac by mistake), that server still records the turn and sends the frame; set
`COMPANION_BODY_PUSH=0` there to guarantee it never pushes.

## Auto-investigation (`POST /api/body/investigate`)

A component that goes **dead / crash_loop / failing** is investigated with no
tap (`warning` and every other state is skipped): one headless, **read-only** `claude -p` on the host that owns it. Any fix
comes back as a #Body proposal card; the investigator never changes anything.

**Triggers.** Every `POST /api/body/alert` whose `state` is a problem state, plus
a sweep of all current problem components 60 s after boot and every 10 min.

**Dedupe + budget.** At most one open investigation per component. After one
finishes, the same component in the same state waits 12 h — a different state,
or an alert carrying a real transition (`from_state ≠ state`), starts a new
one. A failed run retries once after 10 min; two failures in a row wait 12 h.
Per host: ≤ 3 running and ≤ 10 started per rolling 24 h (the rest wait for a
later sweep). Records live in companion.db `body_investigations`, so a restart
never re-runs a finished one (a run cut short by the restart is closed `failed`
and retried once).

**Kill switch.** `touch ~/.claude-companion/.body-investigate-disabled`, or
`COMPANION_BODY_INVESTIGATE=0`. Checked on every decision; no restart needed for
the file.

**Where it runs.** `mac:*` → the Mac; `zettlab:*` and `cloud:*` → Zettlab. Each
host only runs its own. Zettlab forwards Mac components to the Mac Companion;
the Mac never forwards (its own sweep covers `mac:*`, and its dedupe makes a
forward + its sweep idempotent).

```json
POST /api/body/investigate
{ "component_id": "mac:launchd:com.x", "state": "dead", "from_state": "ok", "trigger": "forward" }
→ { "ok": true, "status": "started", "id": "3f9a1c2e" }
```

`status` ∈ `started | forwarded | pending_host | duplicate | skipped | not_owner | disabled`
(+ `id`, `reason`). `state` is optional (read from Turso when absent). A request
with header `x-companion-body-hop: 1` is never forwarded again (`not_owner`).

```json
POST /api/body/investigate
{ "report": { "id", "componentId", "host", "state", "status": "done|failed", "attempt", "startedAt", "finishedAt",
              "runOn", "result": {…} | null, "error": null | "…", "cwd": "/abs/path" | null, "repo": bool } }
→ { "ok": true, "status": "applied" | "duplicate" }
```

The Mac sends its finished investigations to Zettlab this way (Zettlab owns
#Body). A replayed report id is `duplicate` (no second turn or card). 400
`{ok:false, error}` on a bad body; 503 `turso_unreachable` as elsewhere.

**Peer config** (both hosts):

| env | Zettlab | Mac |
|---|---|---|
| `COMPANION_BODY_PEER` | the Mac Companion's base URL (`https://<mac>.ts.net` or `http://100.x.y.z:4245`) | Zettlab's base URL (`https://zettlab.tailfc45f2.ts.net`) |
| `COMPANION_BODY_PEER_TOKEN` | the Mac's bearer token, when it differs from Zettlab's own | Zettlab's bearer token, when it differs |
| `COMPANION_BODY_HOST` | optional override (`zettlab`) | optional override (`mac`) |

`COMPANION_BODY_PEER` must be `https://…` or `http://` to loopback / a tailnet
address (100.64/10, `*.ts.net`); anything else is ignored. Unset on Zettlab →
Mac components stay `pending_host` (the Mac's own sweep still investigates them
and reports locally). Unset on the Mac → reports go to the Mac's own #Body.

**The investigator.** `claude -p` (model `COMPANION_INVESTIGATE_MODEL`, default
`sonnet`; 10 min timeout) in the empty dir `~/.claude-companion/investigate`, prompt on stdin, allowlisted env
(no Turso / Companion / broker tokens), with `--setting-sources project,local`
(user settings — auto mode, broad allows, hooks — never load),
`--settings {"disableAllHooks":true}`, `--strict-mcp-config`,
`--permission-mode dontAsk`, `--tools Read,Grep,Glob,Bash`, `--add-dir /`,
`--allowedTools` Read/Grep/Glob + `journalctl`, `systemctl --user
status|cat|list-timers|show`, `launchctl print|list`, `ls`, `cat`, `head`,
`tail`, `stat`, `docker ps|logs|inspect`, `git log|status|diff`, `which`,
`crontab -l`, `ps`, `df`, `du`, `curl -s http://localhost|127.0.0.1…`, and
`--disallowedTools` Edit, Write, NotebookEdit + secret paths + write flags
(`curl -X/-d/-o…`, `git --output`, `journalctl --vacuum…`). Its prompt carries
the component record, latest vitals, last 20 events and the unit / plist / log
paths derived from the id. It must answer:

```json
{ "rootCause": "…", "evidence": ["…"], "confidence": 0.85, "severity": "low|med|high|critical",
  "recommendedFix": { "summary": "…", "steps": ["…"], "risk": "low|med|high", "reversible": true } | null,
  "retire": false, "notes": "…" }
```

Fenced or prose-wrapped JSON is accepted; anything else records `failed`. All
text is passed through the secret redactor before it is stored or posted.

**Report** (on the #Body owner):
1. Turn in #Body: `🔍 <component> — <rootCause> (confidence N%)`, up to 6
   `• evidence` lines, then `Fix: <summary> (<risk> risk, reversible)` or
   `No fix proposed.` A failure posts `🔍 <component> — investigation failed: <error>`.
2. A non-null fix → the existing proposal card in #Body (`orchestrator_task`
   frame). For `zettlab:*` / `cloud:*` components, approve files it like any
   proposal (headless, or `mode:"live"`). For `mac:*` components the fix runs
   **live on the Mac** — see "Mac fixes" below. The card's turn names the host
   (`… · host mac` / `Approve to run it live on the mac (in <cwd>).`).
   Agent `builder` when a git repo is known for the component, else `claude`;
   cwd = that repo / unit working dir, else `~/.claude`; project note =
   `COMPANION_BODY_NOTE_ID` (default `projects/2026-06-22-companion-orchestrator`).
   The task text names the host the fix must run on.
3. Turso `body_events` row: `kind='investigation'`, `from_state` null,
   `to_state` = the state, `detail` = `investigation <id>: <rootCause> (N%, severity) · fix proposed [<card>]`.
4. Push (same sender gate as alerts) only for severity `high`/`critical`, or a
   second consecutive failed investigation.

## Mac fixes run live on the Mac (`POST /api/body/fix`)

A `mac:*` fix card is recorded (companion.db `body_fix_cards`: card id → host,
component, cwd, note, agent). Approving it on Zettlab —
`POST /api/orchestrator/proposal/<id>/approve`, with or without
`mode:"live"` — never files a headless Turso task (Zettlab's dispatch-run
could claim it). Zettlab forwards the approval to the Mac over the peer
channel (`COMPANION_BODY_PEER`, bearer, `x-companion-body-hop: 1`, 30 s):

```json
POST /api/body/fix
{ "fixId": "<Zettlab card id>", "host": "mac", "componentId": "mac:launchd:x", "prompt": "…", "title": "…",
  "cwd": "/Users/…/repo or ~/.claude", "noteId": "projects/…", "agent": "builder|claude", "investigationId": "…" }
→ { "ok": true, "taskId": "<Mac local id>", "dispatchTaskId": "<32 hex>", "status": "running", "mode": "live", "replay": false, "host": "mac" }
```

The Mac creates one local #Body proposal row per `fixId` (`body_fix_runs`), then
runs its normal live path with the fix's cwd as the explicit cwd (never the
note's mapped repo): `claimLive` (Turso row `running`, owner
`companion:<mac hostname>`), the tmux worker, stop hook → completed. A component
the receiving host does not own → 409 `not_owner` (never re-forwarded). Its
errors are the live path's (`429 live_cap`, `422 no_cwd`, `503 turso_unreachable`, …).

The Zettlab approve answers `{ok, taskId, dispatchTaskId, status:"running", mode:"live", host:"mac", replay}`;
the card is stamped with the Mac's Turso id and leaves as `filed`; the
dispatch poller shows the Mac's live row like any other. A repeat approve on
a filed card replays (same id, no call to the Mac); a concurrent double
approve reaches the Mac twice and the Mac's per-fix row + live replay keep it
to one worker and one Turso row. Errors on the Zettlab approve:

| status | error | card |
|---|---|---|
| 503 | `host_unreachable` (+`reason`: network, timeout, or no `COMPANION_BODY_PEER`) | stays `proposed`, retryable |
| 502 | `host_refused` (the Mac answered 401/403: peer token wrong) | stays `proposed` |
| the Mac's status | the Mac's `error` (`live_cap`, `no_cwd`, `turso_unreachable`, …) | stays `proposed` |

A Mac card that was reported on the Mac itself (no peer) runs live there with
the same explicit cwd.

## Orchestrator brain ("brain's face")

`wiring/orchestrator.ts runBrain` calls `bodyDigestFor(channel, text)`: for every
message in `#Body`, and for a health question anywhere (`isHealthIntent`:
system/body-scoped phrasing only — "how's the body", "what's broken", "system
status", "status of the servers", "is everything ok/up/running", "health check",
"est-ce que tout roule", "qu'est-ce qui est brisé", "état du système"; a bare
"status" / "status of project X" does not match),
a ≤ 800-char digest from the cached `GET /api/body` snapshot is added to the
gate and compose prompts as "Live system context". Turso down → a one-line
"unreachable" note instead. The same messages also get a ≤ 700-char
investigations digest (open ones + the last 48 h, latest per component: root
cause, confidence, proposed card), so "what's dead and why?" answers from them.

## iOS "Body" view — what to decode

- List: `GET /api/body` → header from `summary`, rows from `components`
  (badge `state`, sort problems first client-side), a feed from `recent_events`.
- Detail: `GET /api/body/component/<percent-encoded id>`.
- Token burn card: `GET /api/body/tokens?range=today|7d|30d`; card state from the
  `<host>:tokens:burn` component in `components`.
- Live: `body_alert` frame → refresh the list (or patch the row by `component_id` + `state`).
- Push tap: userInfo `kind == "body_alert"` → open the detail for `component_id`.
- The `#Body` channel is a normal orchestrator channel (`id:"body"`).
