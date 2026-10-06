# Tasks API (Jeremie's own tasks)

PRJ-CT4M WP1. Turso `tasks` is the store; the phone never holds the token. Bearer auth like every `/api/*` route. Code: `server/lib/my-tasks.ts`, `server/routes/my-tasks.ts`.

**Mine** = `assignee IN ('human:jeremie', 'human')`, open (`done = 0`). Override with `COMPANION_TASK_ASSIGNEES` (comma list). Agent tasks (`agent:*`) never appear here and can't be written through this API; they belong to dispatch.

**Days** are local to `COMPANION_TASKS_TZ` (default `America/Toronto`).

## GET /api/tasks/mine

Cached 30 s per host (never across local midnight); `?fresh=1` bypasses.

```json
{
  "generatedAt": "2026-10-06T15:00:00.000Z",
  "today": "2026-10-06",
  "tz": "America/Toronto",
  "total": 64,
  "sections": [
    { "key": "overdue", "label": "Overdue", "count": 3, "projects": [
      { "noteId": "projects/2026-…", "title": "Granby 321", "ref": "PRJ-…", "folder": "projects",
        "tasks": [ { "id": "…", "text": "…", "description": null, "due": "2026-10-03",
                     "children": [ { "id": "…", "text": "…", "description": null, "due": null, "children": [] } ] } ] } ] },
    { "key": "today", … }, { "key": "week", … }, { "key": "later", … }, { "key": "none", … }
  ]
}
```

The response always carries all five sections, in this order:

- `overdue`: due < today
- `today`: due = today
- `week`: the next 6 days
- `later`: after that
- `none`: no date

Grouping rules:

- Projects inside a section: soonest due first, then title.
- Tasks: due, then position.
- A subtask (`parent_id` = an open task of mine) nests under its parent at any depth and follows the parent's section.
- An orphan subtask, or a member of a parent cycle, is shown as a root.
- `count` includes subtasks.
- The dashboard's `''` for "no date" / "no parent" maps to `null`.

Errors: `503 {"error":"turso_unreachable"}`.

## POST /api/tasks/:id/done

Body `{"done": true|false}`. Response: `{"ok":true,"done":true,"due":"2026-10-09"|null}`.

## POST /api/tasks/:id/due

Body `{"due": "YYYY-MM-DD" | null}`. `null` drops the date (stored as `''`, like the dashboard). Same response shape as `/done`.

Errors for both writes:

- `400`: `bad_id`, `bad_json`, `done_must_be_boolean`, `due_must_be_yyyy_mm_dd_or_null`
- `404`: `no_such_task`, which also covers a task that isn't mine
- `503`: `turso_unreachable`

Each real change writes one `agent_activity` row: `agent_slug='companion'`, action `status_changed` or `due_changed`, `target_kind='task'`. A no-op (same value) writes none.

## WS frame `tasks_changed`

`{"type":"tasks_changed","taskId?":"…","why":"done"|"reopened"|"due"|"external"}`. On it, the client refetches `GET /api/tasks/mine?fresh=1`.

When it is sent:

- After every write through this API.
- When the 60 s watcher sees the open set change because of an edit made elsewhere (the dashboard, an agent, the other host). The watcher's first tick only seeds its state and sends nothing.
