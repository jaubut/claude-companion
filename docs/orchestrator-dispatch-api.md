# Orchestrator ↔ Turso dispatch API

Change Plan: orchestrator-one-queue (STATE.md, 2026-10-03). Turso `tasks` is the one
work queue; the Companion reads it (P1), files and steers it (P2), triages it
from #Body (P3), and runs opt-in live tasks in a tmux worker (P4).
All routes sit behind the `/api/*` bearer gate. The phone never sees the Turso token.
Every field below is additive: decode permissively, absent = null.

## Task DTO

Inside `task` of the `orchestrator_task` frame, in `tasks[]` of `GET /api/orchestrator/thread`,
and in `GET /api/orchestrator/task/<id>`.

```json
{
  "taskId": "Turso id (32-hex, or a dashed UUID for dashboard-made tasks) | 8-char local id",
  "threadId": "channel id (linked channel, else general)",
  "prompt": "task title",
  "cwd": "project title for source=dispatch (display only); local cwd otherwise",
  "reasoning": null,
  "status": "queued|dispatched|running|done|error|proposed|rejected|cancelled",
  "logTail": "PR <url> · <verdict>",
  "sessionKey": null,
  "tmuxSession": null,
  "createdAt": 1759485600000,
  "updatedAt": 1759492800000,
  "source": "dispatch|local|proposal",
  "dispatchStatus": "queued|running|blocked|pr|completed|failed|cancelled|null",
  "agent": "builder",
  "noteId": "projects/2026-01-01-dash",
  "projectTitle": "TLS Dashboard",
  "prUrl": "https://github.com/o/r/pull/7",
  "resultRef": "RES-AB12",
  "blocker": "reason (blocked/failed only)",
  "done": false,
  "owner": "zettlab | companion:<host>",
  "mode": "headless|live",
  "localTaskId": "live only: the 8-char local worker id",
  "tmuxSocket": "live only"
}
```

- `pr` = Turso `completed` with a PR URL.
- Legacy `status` for `source:"dispatch"`: queued→queued, running→running,
  completed/pr→done, blocked/failed→error, cancelled→cancelled.
- `prUrl` / `resultRef` need the P0 Turso columns; until then they are null
  (the detail route falls back to the result note whose banner names the task).
- Live tasks (`owner` = `companion:<host>`, P4) are listed once, as their Turso row, with
  `mode:"live"` plus the worker's `tmuxSession`, `tmuxSocket`, `sessionKey` and `localTaskId`
  (null until the spawn is recorded). `orchestrator_worker_output` frames and the worker's reply
  turn are tagged with `localTaskId`. `logTail` falls back to the worker's final pane snapshot.
  The local worker row is never listed on its own, and on the wire it reads `status:"filed"`
  (the proposal card leaves).
- Local tasks keep every field they had (`tmuxSocket` included); `source` is
  `proposal` for proposed/rejected/filed, else `local`; `mode` is `live` (tmux worker).
- Proposals (P2) also carry `noteId` / `agent` (the brain's validated pick, else null),
  `title`, and `dispatchTaskId` (the Turso id once approve started; set on `filed`).
  Status `filed` = handed to Turso. The server sends one `orchestrator_task` frame with
  `status:"filed"` (the card leaves: `isPending` is false) and then the Turso task's own
  frame. `/thread` never lists `filed` rows; their Turso task is listed instead.

## Frames

| frame | shape | when |
|---|---|---|
| `orchestrator_task` | `{task: TaskDto}` | local transition, or a Turso task whose `(dispatch_status, updated_at, done, pr_url)` changed since last seen; re-sent for a note's tasks when its channel link changes |
| `orchestrator_channel` | `{channel: Channel}`; Channel gains `noteId, noteTitle, noteRef, counts{queued,running,blocked,pr}` | channel create/auto/link, or its dispatch counts changed |
| `orchestrator_queue` (new) | `{queue: {cap, live, queued, dispatch:{queued,running,blocked,pr}}}` | after a poll that changed any of it |
| `orchestrator` | `{turn}` | a Turso task moved into blocked / pr / completed / done: one turn in the owning channel, `turn.taskId` = the Turso id |

Status flows from the record: the server polls Turso every 20 s; `POST /hooks/dispatch-event`
only triggers a poll. The announce cursor persists in sqlite (`dispatch_seen`), so a restart
never re-announces. Blocked / PR transitions push (category `dispatch_task`,
`userInfo {kind:"dispatch_task", taskId, channel}`) only on a host with
`COMPANION_DISPATCH_PUSH=1`, never on the first poll after boot, at most 3 per poll.

## Channel ↔ project

- At most one non-archived channel per `noteId`. A linked channel lists its note's agent tasks.
- `general` lists agent tasks of unlinked notes. `body` lists blocked tasks across all notes
  (their `threadId` stays the owning channel). `general` and `body` cannot be linked.

## Routes

| route | response |
|---|---|
| `GET /api/orchestrator/thread?channel=` | `{channel, channels[], turns[], tasks[], queue:{cap,live,queued,dispatch}}`; `tasks` = local rows + the channel's Turso tasks from the last poll (never blocks on Turso) |
| `GET /api/orchestrator/channels` | `{channels[]}` with `counts` |
| `GET /api/orchestrator/task/<id>` | `{ok, task, description, result?:{ref,title,excerpt(≤4000)}, activity:[{action,summary,ts}](≤20)}`; 404 `no such task` |
| `POST /api/orchestrator/channels/<id>/link` `{noteId: string\|null}` | `{ok, channel}`; 409 `note_linked_elsewhere`; 404 unknown channel/note; 400 bad body or system channel |
| `GET /api/orchestrator/projects[?fresh=1]` | `{projects:[{noteId, ref, title, openAgentTasks}]}`, active `projects/` notes, 5-min cache |
| `POST /hooks/dispatch-event` `{taskId?}` | 202 `{ok:true, polled:bool}`; a nudge inside 2 s arms one trailing poll. Loopback peer (dispatch.sh → 127.0.0.1) needs no header; any other peer needs the bearer, else 403 |

Errors: any Turso failure → 503 `{ok:false, error:"turso_unreachable"}`; never the SQL.

## Write path (P2)

Every write is one named, guarded compare-and-set in `server/lib/dispatch-tasks.ts`
(`UPDATE … WHERE id=? AND (<expected states>)`; 0 rows → 409, nothing written) plus one
`agent_activity` row: `action "dispatch:<state>"`, `meta {source:"companion", host, channel, from, op?}`.
There is no generic SQL route. Approve, cancel, requeue and unblock honour `Idempotency-Key`
(a replay within 24 h returns the first success with `Idempotent-Replayed: true`).

| route | body | 200 | errors |
|---|---|---|---|
| `POST /api/orchestrator/proposal/<id>/approve` | optional `{agent?, noteId?, mode?:"live", cwd?}` | `{ok, taskId, status:"queued", dispatchTaskId, replay}` (replay=true when it was already filed: same id, no new row). `mode:"live"` → `{ok, taskId, dispatchTaskId, status:"running", mode:"live", replay}` (see Live mode) | 404 `no such proposal` · 409 `not proposable (status X)` · 422 `no_project` (no brain pick, no `noteId`, unlinked channel) · 400 `unknown_agent` · 404 `no such note` · 503 `turso_unreachable` (the proposal stays `proposed` and can be retried) |
| `POST /api/orchestrator/proposal/<id>/reject` | — | `{ok, taskId, status:"rejected"}` | 404 · 409. Never reaches Turso |
| `POST /api/orchestrator/task/<id>/cancel` | — | local id: `{ok, taskId, status:"cancelled"}` (tmux kill, as before). Turso id: `{ok, taskId, status:"cancelled", task}`. Allowed from queued / blocked / failed; sets `done=1`. A live task owned by this host (by Turso id or its `localTaskId`) is cancelled while running: `{ok, taskId:<localTaskId>, dispatchTaskId, status:"cancelled", task}`, worker killed | 409 `{ok:false, error:"running_on_<owner>", owner, dispatchStatus:"running", task}` for a running task · 409 `{ok:false, error:"conflict", dispatchStatus, owner, task}` when not cancellable or another writer moved it first (`task` = the current, unchanged row) · 404 `no such task` · 503 |
| `POST /api/orchestrator/task/<id>/requeue` | — | `{ok, task}` (`dispatchStatus:"queued"`, `done:false`) | from blocked / failed / cancelled / completed-not-done only; same 409 / 404 / 503 shapes. Local ids → 409 |
| `POST /api/orchestrator/task/<id>/unblock` | `{answer: string, 1..4000 chars after trim}` | `{ok, task}` | 400 `answer must be 1..4000 chars` · 409 `conflict` unless blocked · 404 · 503 |
| `POST /api/orchestrator/channels` | `{name, cwd?, noteId?}` | `{ok, channel}` (with `noteId, noteTitle, noteRef, counts`) | 400 `name required` / bad `noteId` · 404 `no such note` · 409 `note_linked_elsewhere` (nothing created) · 503 |
| `POST /api/orchestrator/dispatch` | `{prompt, channel?, noteId?, agent?, title?, mode?, cwd?}` | `{ok, taskId, dispatchTaskId, status:"queued"}` — files a Turso task directly. `mode:"live"` → `{ok, taskId, dispatchTaskId, status:"running", mode:"live", replay:false}` | 422 `no_project` · 400 `unknown_agent` · 404 · 503; live also 429 `live_cap` · 422 `no_cwd` · 500 |

- **Requeue** resets what `dispatch.sh <id> queued` resets: `done=0`, run id, started / completed
  times, blocker, owner, result ref, PR URL.
- **Unblock** is one UPDATE: it appends `"\n\n[unblock YYYY-MM-DD] <answer>"` (UTC date) to
  `description` and requeues. dispatch-run puts `description` into the worker's brief, so
  the next run reads the answer.
- **Agents:** `agent` is checked against `~/.claude/agents/*.md` plus `claude`. The
  `agent:` prefix is stripped, and dispatch-run's aliases apply (`build` and `frontend-design` → `builder`;
  `seo-audit` and `business-profiler` → `claude`). Default `builder`.
- **Target note on approve:** body `noteId`, else the brain's pick (only if it is one of the active
  projects), else the channel's linked note.
- After every Companion write the task's `orchestrator_task` frame and the counts
  (`orchestrator_channel` / `orchestrator_queue`) go out at once, plus one turn in the owning
  channel: `cancelled …`, `requeued …`, `unblocked … Answer: …`, `filed [id] → agent …`.
  A cancel in an auto channel turns auto-dispatch off, as before.
- **Auto-dispatch** files the proposal itself, with no tap. The `Auto-dispatch [id] — agent · project / Why / Task`
  turn always comes first. If filing fails, a turn says so and the card stays `proposed`.
  #Body never auto-dispatches.

## #Body triage (P3)

- `GET /api/orchestrator/thread?channel=body` adds `vitals`. It is `null` when the Body read
  fails or takes longer than 1.5 s:
  ```json
  {"line":"43 components: 38 ok · 1 failing · 1 dead · 2 dormant · 1 unknown — 2 tasks blocked",
   "summary":{"ok":38,"failing":1,"dead":1,"crash_loop":0,"dormant":2,"stopped":0,"unknown":1,"total":43},
   "worst":"dead","problems":2,"blockedTasks":2,"generatedAt":"2026-10-03T12:00:00.000Z"}
  ```
  `worst` ranks dead > crash_loop > failing > unknown > stopped > dormant > ok; `problems` is
  dead + crash_loop + failing. Other channels have no `vitals` key. The live counts come from
  the `body` channel's `counts` (blocked tasks across every note) and `orchestrator_queue`.
- **`body_alert` banner** (frame unchanged, see `body-api.md`):
  `{type:"body_alert", alert:{component_id, severity, title, message, state, from_state, at}}`.
  Show a banner on any screen: critical in red, warning in amber, info in neutral. Tapping it opens
  #Body. The same alert also arrives as an `orchestrator` turn in `body`, so the banner is
  only a pointer. Refresh `vitals` by re-reading `/thread?channel=body` when a banner
  arrives or the channel opens.
- **Brain context.** Every message gets the channel's dispatch digest (≤ 800 chars): counts, then
  the 5 longest-blocked tasks with their reasons. #Body's digest covers every project.
  #Body (and health questions anywhere) also get the Body digest.

## Live mode (P4)

Opt-in: `approve {mode:"live"}` or `POST /dispatch {mode:"live"}`. Default mode stays headless.

- **Filing.** The Turso row is filed already claimed: `dispatch_status='running'`,
  `dispatch_owner='companion:<host>'`, `dispatch_started_at` now. Same pattern as headless filing: a
  pre-generated id stamped on the local row, then `INSERT OR IGNORE`, so a replayed approve (iOS
  outbox, double tap) reuses the row and never spawns a second worker (`replay:true`, same ids).
  Ledger: one `dispatch:running` row, meta `{source:"companion", host, channel, mode:"live", op:"claim"}`.
  Then the tmux worker runner starts. The local sqlite row keeps the tmux identity and links
  `dispatch_task_id`. dispatch-run only picks `queued` rows and its stall reaper skips `companion:%`.
- **cwd.** Body `cwd` (must be a directory on this host), else the note's repo from dispatch-run's
  `REPO_MAP` (read as text from `~/.claude/tools/dispatch-run.ts`, first existing path), else the
  proposal's cwd, else the channel's. None → 422 `no_cwd`, nothing filed. An Xcode repo (REPO_MAP
  `requires: ["xcode"]`: the note's repo, the explicit cwd or a fallback cwd) on a host without Xcode →
  422 `no_cwd` with `reason: "Xcode repo — run live from the Mac"`.
- **Errors.** 429 `{ok:false, error:"live_cap", cap, live}` when this host already runs `cap` live
  workers (`COMPANION_WIP_CAP`, default 3; headless filing is not capped) — nothing filed.
  422 `no_cwd` · 422 `no_project` · 400 `unknown_agent` · 404 `no such note` · 409 `conflict` (the
  claimed row was moved by another writer) · 503 `turso_unreachable` (the proposal stays `proposed`) ·
  500 `{ok:false, error, taskId, dispatchTaskId}` when the spawn failed (the row goes `failed`,
  blocker `spawn failed: …`).
- **Finish.** The worker's stop hook → guarded `running → completed` (`WHERE dispatch_status='running'
  AND dispatch_owner=<this host>`). A GitHub PR URL in the worker's final message → `dispatch_pr_url`
  (DTO `pr`); a `RES-XXXX` ref → `dispatch_result_ref`. Ledger `dispatch:completed` (meta `pr` when
  set) only when the row moved, so a second stop, or a stop after a cancel, is a no-op. A worker whose
  pane vanished without a stop hook → `failed` ("worker exited without a stop hook").
- **Cancel** from the phone: owned by this host → guarded `running → cancelled` (`done=1`), then the
  tmux worker is killed. Owned by another host → 409 `running_on_<owner>` (unchanged).
- **Restart.** On boot, this host's running live rows whose tmux worker is gone are closed: `failed`
  with blocker "companion restarted; worker lost" (or `completed` / `cancelled` when the local row
  already says so and only the Turso write was lost). Other hosts' rows are never touched.
