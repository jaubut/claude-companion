# Brain API (brain-v2, Phase 1)

One supervised `brain` agent on the brain host (`COMPANION_BRAIN=1`, Zettlab). It plans, dispatches and follows up, and never builds. The server supervises, relays and records; the thread lives in sqlite. Spec: Turso RES-QDHU. Plan: STATE.md § Change Plan — brain-v2.

Every frame and field below is **additive**. Shipped iOS builds decode `brain` / `brain_trace` as `.unknown`, and a host without `COMPANION_BRAIN=1` sends none of them.

Fixtures: `contracts/brain/*.json` (synced to the iOS repo's `Fixtures/brain/` by `bun run contracts:sync`).

## Frames

Order on a new socket (brain host only): `init` (with `brain`) → `brain` → `brain_trace` snapshot → copy jobs, canvas, approval/question replays as before.

### `brain`

```
{type:"brain", state:"up"|"starting"|"down"|"paused", sessionKey:string|null, since:number, restarts:number, host:string,
 activity: {kind:"thinking"|"reading"|"searching"|"writing"|"dispatching"|"working"|"compacting", label:string, since:number}|null}
```

`activity` is what the brain is doing right now (null = idle): "Thinking" while a turn is in flight, the step its last PreToolUse names ("Reading notes", "Dispatching"…), "Compacting memory" during an idle compact. Re-sent on every change; older clients ignore it.

Sent after `init` and on every state change. `restarts` = respawns in the last 5 min (3 → `down` + one push; it retries once the window clears). `paused` = the kill switch `~/.claude-companion/.brain-paused` exists; nothing respawns it.

### `init.brain`

Same object as the `brain` frame, minus `type`. Absent off the brain host.

### `brain_trace`

```
{type:"brain_trace", op:"row"|"snapshot", rows:[TraceRow]}
TraceRow {
  id: string            // "turn:<turnId>" | "repo:<turnId>:<project>" | "agent:<proposalId>" | "pr:<proposalId>"
                        // | "appr:<approvalId>" | "q:<questionId>" | "voice:<turnId>" | "lead:<name>:<turnId>" (P2)
                        // | "step:<toolUseId>" (one brain tool call, under its turn)
  parentId: string|null // turn → repo → agent → pr; approvals/questions under the asking worker's agent row, else "needs-you"
  turnId: string|null
  kind: "turn"|"repo"|"agent"|"pr"|"approval"|"question"|"voice"|"lead"|"step"
  status: "pending"|"running"|"done"|"error"
  title: string, detail: string|null
  ref: {taskId?, prUrl?, approvalId?, questionId?, host?, sessionKey?, audioId?, step?}   // step: the activity kind of a step row (its icon)
  startedAt: number, endedAt: number|null, seq: number
}
```

- `snapshot` (on connect) = the newest 300 rows in `seq` order. `row` = rows that just changed.
- `seq` is global and monotonic; keep the max `seq` per id. Transitions: pending → running → done | error. A terminal row never reopens (a retry is a new id).
- `agent:<proposalId>` uses the Companion proposal id (8 chars); `ref.taskId` is the Turso task id once filed.
- `"needs-you"` is a virtual parent (no row): render its children under a "Needs you" group.
- Unknown `kind` / `status` values must be tolerated (`trace.unknown-kind.json`).

### `orchestrator` turn `card`

```
turn.card? = {kind:"dispatch"|"voice", source:"app", taskId?, audioId?, durationMs?, locale?}
```

- `voice`: a user turn sent from the 🧠 composer with `voice` (below); `audioId` arrives later when the take is archived (the turn is re-sent with the same id).
- `dispatch`: a receipt the poller writes into the brain thread (role `orchestrator`) when a task moves to blocked / PR / completed / done. `card.taskId` is the Turso id. **`turn.taskId` stays null** on card turns (shipped builds group taskId turns as worker output). The old channel still gets its turn until P3.
- Turns without a card serialize exactly as before (no `card` key).

## Endpoints

| method | path | body / query | answer |
|---|---|---|---|
| POST | `/api/orchestrator/send` | `{text, channel:"brain", voice?:{durationMs, locale}}` | `{ok, turn}` once persisted — also while the brain is down. Idempotency-Key replay never enqueues twice. |
| GET | `/api/orchestrator/thread?channel=brain` | | unchanged shape |
| POST | `/api/orchestrator/channels` | `{name}` slugging to `brain`/`general`/`body` | 409 `reserved_channel` |
| POST | `/api/orchestrator/channels/brain/link` | | 400 (system channel) |
| GET | `/api/brain` | | `{ok, brain}` |
| GET | `/api/brain/trace?since=<seq>` | | `{ok, rows}` (no `since` → the snapshot rows) |
| POST | `/api/brain/pause` | | `{ok, brain}`; writes the flag, stops the agent |
| POST | `/api/brain/resume` | | `{ok, brain}`; removes the flag, the next tick spawns |
| POST | `/api/brain/restart` | | `{ok, brain}`; 409 `paused` while paused |
| POST | `/api/capture/voice/start` | `{mime, brainTurnId?}` (`^[\w:-]{1,64}$`) | unchanged. A valid id archives the take: inbox row `result_id = brain:<turnId>`, turn card `audioId`. Best effort — never fails the start. Omit the key when there is no turn. |
| POST | `/api/capture/voice/:id/validate`, `/discard` | | 409 `brain_take` on a `brain:*` row |
| POST | `/hooks/brain/propose` | `{title, prompt, noteId, agent?, reasoning, sourceTurnId}` | see below |
| POST | `/hooks/brain/thread` | `{q, limit?}` (q ≤ 200 chars, limit 1–50, default 20) | `{ok, turns: [{id, role, at, text}]}`: brain-thread turns containing q, newest first, text ≤ 1,000 chars. Same auth as propose (brain/bin/thread). |

All `/api/brain*` are Bearer-gated; every one answers 404 `brain_disabled` off the brain host.

### `POST /hooks/brain/propose` (brain/bin/propose)

Auth — all of: TCP peer loopback with no forwarded hop (`clientOrigin(...).transport === "loopback"`; a `tailscale serve` request is 403), `X-Companion-Task-Id: brain`, and `X-Companion-Pid` = the pid of the registered brain session whose session id the supervisor adopted. Else 403.

- `noteId` missing → 422 `no_project`; unknown → 404; Turso down → 503; unknown agent → 400 `unknown_agent`.
- Dedupe on (`sourceTurnId`, sha256(prompt)): a repeat answers `{ok, proposalId, replay:true}` and creates nothing.
- **Voice = consent:** when `sourceTurnId` names a user turn in the brain thread with a `voice` card from the app, ≤ 10 min old, that has not auto-filed anything yet, the proposal is approved at once (files `queued`, origin jeremie): `{ok, proposalId, dispatchTaskId, status:"queued", consent:"voice"}`. Otherwise a proposal card turn waits for the Approve tap: `{ok, proposalId, status:"proposed"}`.

## Hooks (no hook-script change)

The brain is a **normal Claude Code session**: its tool limits are `brain/CLAUDE.md`, `brain/.claude/settings.json` (deny Edit/Write/MultiEdit/NotebookEdit; allow Turso read + note_create/note_update, Gmail drafts + send + reply, `bin/*`) and the normal permission flow (SUPER, auto-judge → phone). It is detected by `X-Companion-Task-Id: brain` first, then the registered session's taskId.

- PreToolUse: the brain takes the normal path like any session (SUPER, then auto-judge → phone; Jeremie, 2026-10-29). Its hooks also refresh the supervisor's busy deadline (UserPromptSubmit too).
- Stop: the reply becomes an `orchestrator` turn in the brain thread (adopted session only); no waiting badge, no push, no global auto-compact (`compactTargetFor` excludes brain and `lead-*`).
- SessionStart: the supervisor adopts the session only when it sits in the pane it spawned (herdr's `brain` agent pane after a Companion restart), never replacing a live adopted session, and never while paused.

## Supervisor rules

- Paused flag re-read before every spawn, in SessionStart adoption and before every delivery.
- `busy` (a typed turn waiting for its Stop) clears after 10 min with no hook from the brain.
- `down` (3 respawns in 5 min) lasts until a manual resume or restart.

## Delivery rules

The supervisor types queued turns only into a session that has a non-empty key, `taskId === "brain"` and the adopted session id — never a cwd, never the most-recent-session fallback. `not_submitted` marks the turns `maybe` and they are never retyped into that session; a fresh session's boot seed cites every open turn. Idle compaction (no turn for 15 min, context > 60 %) and the 04:00 rollover run between turns only.
