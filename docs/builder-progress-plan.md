# Change Plan — builder job progress in the brain thread

Task d094e0b4 (Companion #Brain proposal). Date 2026-11-02.

Goal: long builder jobs (87 GB rsync + share, preview renders) show live progress in the
Companion brain thread: an iOS progress ring next to the 3-dot menu (top right), an optional
thin bar under the brain header. Today the relay mod only sends TASK / ACK / DONE / ABORTED,
so the server has no data.

| Slice | Repo | Owner file(s) | Status |
|---|---|---|---|
| (a) relay PROGRESS frame + helper | claude-config | `mods/relay/hooks/register.ts`, `mods/relay/tests/progress.test.ts`, `tools/relay-progress`, `skills/handoff/SKILL.md` | **to do: separate dispatch** (outside this repo's worktree) |
| (b) server state + `builder_jobs` frame | claude-companion | `server/lib/builder-jobs.ts`, `server/wiring/builder-jobs.ts`, `server/routes/builder-jobs.ts`, `server/ws.ts`, `server/companion-server.ts`, `contracts/builder-jobs/` | **this PR** |
| (c) iOS ring + sheet + bar | claude-companion-ios | spec below | Mac builder, after (a) + (b) merge |

Order: (b) can merge first (idle = no frame, nothing changes). (a) then lights it up. (c) last.

## Contract

### 1. Relay wire line (builder → planner, over SendMessage)

```
PROGRESS <id> [<pct>%] <step>
```

- `<id>`: the TASK id (`[\w.-]+`, same as TASK/ACK/DONE).
- `<pct>`: optional integer 0-100 followed by `%`. Absent = indeterminate.
- `<step>`: optional free text, one line, ≤ 120 chars (`rsync 34/87 GB`, `previews 80/161`).
- Parse: `/^PROGRESS\s+([\w.-]+)(?:\s+(\d{1,3})%)?(?:\s+(.+))?$/`; pct > 100 → absent.
- Rate limit: **max 1 per 5 s per task id.** The sender enforces it (latest value wins, trailing);
  the receiver drops anything closer than 5 s to the last accepted one for that id.
- Receiver: swallowed like ACK (`{ consumed: "relay PROGRESS <id>" }`), no model turn, no toast.
  Unknown id (not in `outbound`) is still swallowed.

### 2. Builder helper (claude-config `tools/relay-progress`)

```
relay-progress <id> [<pct>] <step…>      # e.g. relay-progress d094e0b4… 39 rsync 34/87 GB
```

Writes `{"pct":39,"step":"rsync 34/87 GB","at":<ms>}` to `~/.claude/relay/progress/<id>.json`
(write tmp + rename). Exit 0 always (progress must never fail a build). The builder's relay
mod, while an inbound task is `seen`, checks that file every 5 s (`$.clock.after` loop) and
sends `PROGRESS` to the task's `from` when it changed. Works during one long Bash call (an
rsync wrapped in a loop that calls the helper), unlike a `turn.step` hook. The file is deleted
when the mod sends DONE / ABORTED. The handoff skill documents: "long job (> 2 min)? call
`relay-progress <id> [pct] <step>` as it advances; at most every few seconds is plenty".

### 3. Relay → Companion server (brain host only)

The planner-side relay mod POSTs when its session env has `COMPANION_TASK_ID=brain` (set by
Companion's brain spawn, `server/wiring/brain.ts`); any other session posts nothing.

```
POST http://127.0.0.1:${COMPANION_PORT:-4245}/hooks/builder-progress
{ "event": "task" | "progress" | "done" | "aborted", "id": "<id>",
  "title"?: string ≤ 200, "builder"?: string ≤ 100, "pct"?: 0-100, "step"?: string ≤ 120 }
```

- `task`: on outgoing TASK (`session.send`): `title` = first line of the spec (≤ 80 chars),
  `builder` = the `to` name.
- `progress`: on each accepted PROGRESS line. `done` / `aborted`: on DONE / ABORTED.
- Fire and forget, 2 s timeout, errors ignored. Loopback needs no bearer (like
  `/hooks/copy-progress`); a browser `Origin` is refused by the hook gate.
- Responses: 200 `{ok:true}`; 400 `invalid_json` | `invalid_report`; 403 `forbidden`.

### 4. Server state (this PR)

`BuilderJobItem`: `id`, `title` (falls back to id), `builder` (null when unknown), `pct`
(0-100 or **null = indeterminate**), `step` (null when none), `startedAt`, `updatedAt` (server
ms epoch), `stale` (bool). Every key always present.

- `task` creates; `progress` creates too (TASK missed after a restart) and sets pct + step
  (a PROGRESS without pct makes the job indeterminate); a re-sent `task` keeps pct / step.
- `done` / `aborted` remove the job (unknown id: no frame).
- No update for **10 min → `stale: true`** (a frame is re-sent at the flip). No update for
  **2 h → dropped**. Max 16 jobs (least recently updated evicted).
- In memory only; a Companion restart forgets jobs until the next PROGRESS.

WS frame (full list, replace never merge; `jobs: []` clears):

```json
{ "type": "builder_jobs", "jobs": [BuilderJobItem…], "at": 1791230000500 }
```

Sent on every change, at a stale flip / drop, and right after `init` on `/ws` open **only when
non-empty**. Fixture: `contracts/builder-jobs/frame.json`.
`GET /api/builder-jobs` (bearer) → `{ ok: true, jobs: [...] }` for a cold read.

Backward compatibility: one new frame type; `init` and every existing frame unchanged. An idle
host sends nothing new. Old iOS builds ignore an unknown `type` (same path `copy_jobs` and
`canvas` took when they shipped).

## (c) iOS spec — for the Mac builder (claude-companion-ios)

Data: decode the `builder_jobs` WS frame (`type`, `jobs[]`, `at`) into `[BuilderJob]` per
host, **replacing** the host's list each frame; `init` from a host resets it to `[]` (the
server re-sends `builder_jobs` right after `init` when it has jobs). Unknown extra keys are
ignored; `pct`, `builder` and `step` may be null. Optional cold read: `GET /api/builder-jobs`.

1. **Ring next to the 3-dot menu** (brain thread nav bar, top right, left of the `…` button).
   Shown only while the brain host's list is non-empty; hidden otherwise (no empty state).
   - Main job = the most recently updated non-stale job (else the most recent one).
   - Main job `pct` non-null → a determinate circular ring (~22 pt, 2.5 pt stroke, accent
     colour) filled to pct, animated between values. `pct` null → an indeterminate spinner
     of the same size.
   - More than one job → a small count badge on the ring (`2`, `3`…).
   - Main job `stale` → ring in secondary grey, no animation.
   - VoiceOver: "Builder job, <title>, <pct> percent" / "in progress" when indeterminate.
2. **Tap the ring** → a sheet (medium detent) listing every active job, newest first:
   title (one line, truncated), builder name (secondary, when non-null), step text
   (monospaced digits), a linear progress bar (determinate with `pct`%, indeterminate when
   null), and "updated 3 min ago" from `updatedAt`. Stale rows greyed with "no update for
   10+ min". Read-only: no actions in v1.
3. **Optional thin bar under the brain header** (Settings toggle, default on): a 2 pt linear
   bar across the full width under the header for the main job only (determinate or
   indeterminate shimmer). Hidden when no job.
4. When a job disappears from the list (DONE / ABORTED / dropped) the ring animates out; no
   toast (the DONE answer already lands in the thread as a message).
5. Test: decode `contracts/builder-jobs/frame.json` (copied by hand into the iOS fixtures, like
   `copy-jobs/`), plus `{"type":"builder_jobs","jobs":[],"at":0}` → empty list.

## Verification

- (b) `bun test server/lib/builder-jobs.test.ts server/routes/builder-jobs.test.ts`:
  transitions, stale / drop, clear on DONE / ABORTED, validation, hook gate, bearer on GET,
  `/ws` open without jobs sends no new frame (old clients), fixture keys, and the end-to-end
  run (TASK + 3 PROGRESS + DONE through the real server → frames show, then clear).
- (a) claude-config `mods/relay/tests/progress.test.ts`: PROGRESS line parse (pct present /
  absent / > 100), swallow (`consumed`, no `next`), receiver 5 s rate limit, sender throttle
  (latest wins), brain-only POST. Then a live run: a builder calls `relay-progress` three
  times and finishes; `GET /api/builder-jobs` on the brain host shows the job, then `[]`.
- Where it can fail in production: the relay mod's clock loop not ticking during a long tool
  call (then progress only lands between tool calls; check during the live run), a brain
  session started outside Companion (no `COMPANION_TASK_ID=brain` → no POSTs), and Remote
  Control dropping messages across hosts silently (the job goes stale, then drops).
