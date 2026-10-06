# Tasks agent API (Brain → Tasks agent tab)

PRJ-CT4M WP5. This is the server side of the Tasks agent tab described in the brief "Agent tab design" (approved 2026-10-06). It builds on [tasks-api.md](tasks-api.md).

All routes need the `/api/*` bearer auth. If Turso can't be reached, every route returns `503 {"error":"turso_unreachable"}`.

Code:

- `server/lib/tasks-agent.ts`: digest, undo, guarded writes, accept and dismiss
- `server/lib/tasks-agent-rules.ts`: the proposal rules
- `server/lib/tasks-agent-load.ts`: the load meter and the calendar reader
- `server/lib/tasks-agent-chat.ts`: the chat tool
- `server/lib/tasks-agent-store.ts`: companion.db bookkeeping
- `server/routes/tasks-agent.ts`: the routes
- `server/wiring/tasks-agent.ts`: the live instance

**Scope.** "Mine" means the same assignees as in tasks-api.md (`human:jeremie`, `human`). The proposal rules also look at unassigned open tasks (`assignee` NULL or `''`). Tasks assigned to agents (`agent:*`) are never edited here, with one exception: an Undo can restore the assignee that an assignment overwrote.

**Rule: no log, no mutation.** Every write by this agent works in four steps:

1. Insert one `agent_activity` row (`agent_slug='tasks-agent'`, `target_kind='task'`). Its meta carries the old value and the new value: `{"source":"companion","by":"jeremie","from":…,"to":…,…}`.
2. If that insert fails, nothing else happens.
3. Run one compare-and-set `UPDATE` against the task row as it was just read.
4. If the task changed in between, delete the log row and answer `409 changed_since`.

## GET /api/tasks/agent

Send the `X-Companion-Device` header. The digest baseline is stored per device (default `default`). `?fresh=1` re-reads the proposals instead of using the 30 s snapshot.

```json
{
  "generatedAt": "2026-10-06T15:00:00.000Z",
  "today": "2026-10-06",
  "tz": "America/Toronto",
  "digest": {
    "since": { "activityId": 12345, "at": null },
    "items": [
      { "activityId": 12399, "at": "2026-10-06T07:30:00.000Z", "agent": "pm", "action": "due_changed",
        "taskId": "…", "taskText": "…", "project": "Granby 321", "summary": "…",
        "from": "2026-10-08", "to": "2026-10-20", "undoable": true, "undone": false }
    ]
  },
  "proposals": {
    "counts": { "reschedule": 1, "merge": 0, "assign": 12, "split": 2 },
    "items": [
      { "id": "slip:…", "kind": "reschedule", "title": "Reschedule or drop: …", "detail": "…",
        "taskIds": ["…"], "project": "…", "suggestion": { "slips": 2, "due": "2026-10-01", "suggestedDue": "2026-10-13" }, "version": "2" }
    ]
  },
  "load": {
    "from": "2026-10-06", "to": "2026-10-19", "calendar": "ok",
    "thresholds": { "tasks": 4, "busyHours": 6 },
    "days": [ { "day": "2026-10-06", "tasks": 2, "busyHours": 3.5, "overbooked": false, "reasons": [] } ]
  }
}
```

### Digest

The digest lists what agents changed on Jeremie's tasks since his last open. That covers pm-nightly closes and assignments, `due_changed`, `status_changed`, `assignee_changed` and `subtask_created`, plus any row from the `pm` agents. It returns at most 100 rows, newest first.

What counts as the last open:

- A GET more than 30 min after the device's previous GET is a new open. The baseline moves to the newest activity id seen at the previous open.
- GETs closer together than that count as the same open, so a refresh doesn't empty the digest.
- On a device's first open, the digest shows the last 24 h (`since.at`).

The digest leaves out:

- Jeremie's own actions: `companion`, `human`, `human:jeremie`, and rows whose meta has `by:"jeremie"` (proposals he accepted).
- Activity on agent tasks, except a reassignment to or from him.

`undoable` is true only if the row's meta carries the old value (`from`):

| action | undo restores |
|---|---|
| `due_changed` `{from,to}` | `due_date = from` (null means `''`) |
| `status_changed` `{from:"open"\|"done", to}` | `done = from` |
| `assignee_changed` `{from,to}` | `assignee = from` |
| `subtask_created` `{from:null,to,created:true,parent}` | deletes the subtask, only if it is still open, has its original text and has no children |

Any other row, or a row whose meta has no `from`, cannot be undone. `undone: true` means an Undo already ran on that row.

### Proposals

The proposals are deterministic, and no model is called. Each kind is capped at 25 items; `counts` gives the full totals.

| kind | id | rule | accept |
|---|---|---|---|
| `reschedule` | `slip:<taskId>` | One of my open tasks whose date slipped at least 2 times in its `due_changed` history. A slip means the date was pushed later or dropped. A date set by accepting this proposal is not counted. | `{due}`: a `YYYY-MM-DD` date, `null` to drop the date, or omit it to use `suggestedDue` (+7 days). |
| `assign` | `assign:<taskId>` | An unassigned open task whose text matches a `~/.claude/tools/pm-assign.py` ROUTES entry that leads to an agent. That file is read-only, the first match wins, and `human` routes produce no proposal. | Sets `assignee = agent:<x>`. It does **not** queue the task: `dispatch_status` is left alone. |
| `merge` | `merge:<keepId>:<dupId>` | Two open tasks (mine or unassigned) in the same note with the same or nearly the same normalized text. Near means a token Jaccard of at least 0.8 on 4+ tokens, or an edit ratio of at least 0.9. Texts whose numbers differ ("Invoice 1041" / "Invoice 1042") never match. A task that has subtasks is never merged away. | Closes the duplicate (`status_changed`, `merged_into`) and keeps the one with the lower position. Refused (`409 changed_since`) if the kept task is no longer open in the same note. |
| `split` | `split:<taskId>` | One of my root tasks with more than 12 words whose first word is not an action verb (EN/FR list), and which has no subtasks yet. | See the two steps below. |

How a split is accepted:

1. `{action:"accept"}` asks Haiku for 2-5 subtasks and returns `{"ok":true,"stage":"confirm","subtasks":[…]}`. Nothing is written in this step. If Haiku is unavailable, the response is `502 split_unavailable`.
2. `{action:"accept","subtasks":[…]}` with the list Jeremie edited or confirmed (2-5 lines) inserts each subtask. Each one gets `parent_id = task`, its parent's assignee, no date, a position after the note's last task, and one `subtask_created` row. All or nothing: if an insert fails midway, the subtasks already written (and their rows) are removed, so a retry starts clean.

After an accept or a dismiss, the proposal is hidden as long as its `version` still matches. A `reschedule` proposal is hidden until the date has slipped 2 more times.

### Load

The load meter covers 14 local days starting today. For each day it gives Jeremie's open tasks due that day and his busy hours on the primary Google Calendar.

- Only timed, opaque, non-cancelled events count. All-day events don't count, and neither do events that tools/task-calendar wrote (`tlsTaskId`).
- Overlapping events are merged, then split at local midnight.
- A day is `overbooked` when it has more than 4 tasks or more than 6 busy hours. `reasons` says which threshold it crossed.
- The calendar is read-only. The server uses mail-watcher's token file (`COMPANION_GCAL_TOKEN_FILE` overrides it) and refreshes the access token in memory only; it never writes the file. Results are cached for 10 min.
- If the token or the API is unavailable, the response has `calendar:"unavailable"` and `busyHours: null`. Task counts are still returned.

## POST /api/tasks/agent/undo

Body: `{"activityId": 12399}`. Response: `{"ok":true,"taskId":"…","field":"due"|"done"|"assignee"|"created","restored":…}`. The undo writes its own `undo` row, with meta `{undoes, field, from, to}`, and then sends `tasks_changed {why:"undo"}`.

Errors:

- `400`: `bad_json`, `activity_id_must_be_positive_integer`
- `404`: `no_such_activity`, `no_such_task` (also when the task is outside the digest's scope: due / done / subtask on a task that is not his or unassigned, or a reassignment that never involved him)
- `409`: `not_undoable`, `already_undone`, `changed_since` (the task no longer holds the value the row set)

## POST /api/tasks/agent/proposals/:id

Body: `{"action":"accept"|"dismiss", "due"?: …, "subtasks"?: […]}`. The server works the proposal out again from Turso, so an id that no longer applies returns 404.

Responses:

- Accept: `{"ok":true,"decision":"accept","proposalId":"…","taskIds":[…],"detail":{…}}`, and the server sends `tasks_changed {why:"agent"}`.
- Dismiss: `{"ok":true,"decision":"dismiss",…}`.
- Split, first step: the `stage:"confirm"` response shown above.

Errors:

- `400`: `bad_id`, `bad_json`, `action_must_be_accept_or_dismiss`, `due_must_be_yyyy_mm_dd_or_null`, `subtasks_must_be_2_to_5_strings`
- `404`: `no_such_proposal`
- `409`: `changed_since`
- `502`: `split_unavailable`

## Chat

The Tasks agent also answers in the orchestrator chat (`/api/orchestrator/send`, `lib/front-door.ts`). A message is routed to it in either of these cases:

Both apply in live mode only. In `off` (kill switch) and `shadow` (never changes the answer) the tasks tool is never called.

- Jev classifies it as `my_tasks` (a new router intent).
- It matches the tasks keyword hint, for example "what is on my plate this week", "move everything Granby to Friday" or "mark the Granby tasks done".

Opus (`COMPANION_TASKS_CHAT_MODEL`, default `claude-opus-5-5`) runs once with no tools and turns the message into one call:

| call | what happens |
|---|---|
| `list {from,to,project?}` | A deterministic answer (by day, with an overdue footnote). |
| `move {taskIds,due}` | Moves the tasks through the my-tasks paths (`setDue`). |
| `done {taskIds}` | Closes the tasks through the my-tasks paths (`setDone`). |
| `reply {text}` | Posts the text as the answer. |
| `not_tasks` | Hands the message back to the normal brain. |

Every task id is checked against his open tasks. Each write logs the `due_changed` / `status_changed` row of the my-tasks path, with `from` and `to`.

A move or done that touches **more than 3 tasks** is held instead of applied:

- The server posts a turn listing the tasks and broadcasts a confirm card:

  ```json
  {"type":"tasks_agent_confirm","planId":"…","threadId":"general","op":"move","due":"2026-10-09",
   "title":"Move 5 tasks to Fri, Oct 9?","tasks":[{"id":"…","text":"…","due":"…","project":"…"}],"expiresAt":…}
  ```

- It is applied by `POST /api/tasks/agent/chat/:planId {"confirm":true}`, or by the chat reply "confirm" in that channel. A bare "yes" / "ok" is never taken as a confirm: it may answer something else.
- `{"confirm":false}` or a reply such as "cancel" drops it.
- A plan expires after 30 min and lives in memory only. An unknown or expired plan returns `404 no_such_plan`.

## Frames

- `tasks_changed`: as in tasks-api.md. The `why` field gains two values: `"agent"` (a proposal was accepted) and `"undo"`.
- `tasks_agent_confirm`: described above.
