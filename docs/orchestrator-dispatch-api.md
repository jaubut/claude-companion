# Orchestrator ↔ Turso dispatch API

Change Plan: orchestrator-one-queue (STATE.md, 2026-10-03). Turso `tasks` is the one
work queue; the Companion reads it (P1, this doc) and, from P2, files and steers it.
All routes sit behind the `/api/*` bearer gate. The phone never sees the Turso token.
Every field below is additive: decode permissively, absent = null.

## Task DTO

Inside `task` of the `orchestrator_task` frame, in `tasks[]` of `GET /api/orchestrator/thread`,
and in `GET /api/orchestrator/task/<id>`.

```json
{
  "taskId": "32-hex Turso id | 8-char local id",
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
  "mode": "headless|live"
}
```

- `pr` = Turso `completed` with a PR URL.
- Legacy `status` for `source:"dispatch"`: queued→queued, running→running,
  completed/pr→done, blocked/failed→error, cancelled→cancelled.
- `prUrl` / `resultRef` need the P0 Turso columns; until then they are null
  (the detail route falls back to the result note whose banner names the task).
- Local tasks keep every field they had (`tmuxSocket` included); `source` is
  `proposal` for proposed/rejected, else `local`; `mode` is `live` (tmux worker).

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

## Coming in P2+

`POST …/task/<id>/requeue`, `…/unblock {answer}`, Turso-aware `…/cancel`, proposal approve
filing to Turso, `channels` create with `noteId`. See the Change Plan.
