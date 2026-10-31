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
                        // | "worker:<proposalId>" (the reaper closed that task's herdr workspace, under its agent row)
  parentId: string|null // turn → repo → agent → pr; approvals/questions under the asking worker's agent row, else "needs-you"
  turnId: string|null
  kind: "turn"|"repo"|"agent"|"pr"|"approval"|"question"|"voice"|"lead"|"step"|"worker"
  status: "pending"|"running"|"done"|"error"
  title: string, detail: string|null
  ref: {taskId?, prUrl?, approvalId?, questionId?, host?, sessionKey?, audioId?, step?, workspaceId?}   // step: the activity kind of a step row (its icon); workspaceId: a worker row's closed herdr workspace
  startedAt: number, endedAt: number|null, seq: number
}
```

- `snapshot` (on connect) = the newest 300 rows in `seq` order. `row` = rows that just changed.
- `seq` is global and monotonic; keep the max `seq` per id. Transitions: pending → running → done | error. A terminal row never reopens (a retry is a new id).
- `agent:<proposalId>` uses the Companion proposal id (8 chars); `ref.taskId` is the Turso task id once filed.
- `"needs-you"` is a virtual parent (no row): render its children under a "Needs you" group.
- Unknown `kind` / `status` values must be tolerated (`trace.unknown-kind.json`).
- `worker` (`trace.worker.json`): one plain "Closed worker" row, status `done`, written when the brain-workers reaper closes a brain task's herdr workspace. Shipped builds map it to `.other`.

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
| GET | `/api/brain/workers` | | `{ok, mode, sessions, foreign}`: the reaper's dry run (below). `foreign` counts every other workspace and never names one. |
| POST | `/hooks/brain/sessions` | `{op:"list"}` · `{op:"close", workspaceId}` | see below. Same auth as propose (brain/bin/sessions). |
| POST | `/hooks/brain/thread` | `{q, limit?}` (q ≤ 200 chars, limit 1–50, default 20) | `{ok, turns: [{id, role, at, text}]}`: brain-thread turns containing q, newest first, text ≤ 1,000 chars. Same auth as propose (brain/bin/thread). |
| POST | `/hooks/brain/pr-close` | `{repo, pr, reason}` (repo `owner/name`, reason ≤ 300) | see below. Same auth as propose (brain/bin/pr-close). |
| POST | `/hooks/brain/pr-merge` | `{repo, pr, reason}` (repo `owner/name`, reason ≤ 300) | see below. Same auth as propose (brain/bin/pr-merge). |
| POST | `/hooks/brain/todo` | `{text, noteId, due?, sourceTurnId}` (text ≤ 300; noteId = note id or ref code; due YYYY-MM-DD) | `{ok, taskId, replay}`: a to-do for Jeremie (assignee human:jeremie, never queued) + a `todo` trace row under the turn. Same auth as propose (brain/bin/todo). |

All `/api/brain*` are Bearer-gated; every one answers 404 `brain_disabled` off the brain host.

### `POST /hooks/brain/propose` (brain/bin/propose)

Auth — all of: TCP peer loopback with no forwarded hop (`clientOrigin(...).transport === "loopback"`; a `tailscale serve` request is 403), `X-Companion-Task-Id: brain`, and `X-Companion-Pid` = the pid of the registered brain session whose session id the supervisor adopted. Else 403.

- `noteId` missing → 422 `no_project`; unknown → 404; Turso down → 503; unknown agent → 400 `unknown_agent`.
- Dedupe on (`sourceTurnId`, sha256(prompt)): a repeat answers `{ok, proposalId, replay:true}` and creates nothing.
- **The brain hands off** (Jeremie, 2026-10-29; replaced voice = consent): every proposal is approved at once (files `queued`, origin jeremie): `{ok, proposalId, dispatchTaskId, status:"queued"}`. No proposal turn, no Approve card, no `filed […]` turn in the brain thread: the agent row ("dispatched") is the receipt. If filing fails the proposal stays `proposed` (a card he can tap): `{ok, proposalId, status:"proposed", error}`.

### Brain sessions (`/hooks/brain/sessions`, `GET /api/brain/workers`)

The brain-workers reaper (`wiring/brain-workers.ts`, policy `lib/brain-workers.ts`) closes only herdr workspaces the brain owns. Ownership is the env on the pane's shell, read from `pane process-info` → `shell_pid`:

- **brain**: label `brain` + `COMPANION_TASK_ID=brain`. Closed when it is not the live `brain` agent's workspace or a brain session's pane, has one pane and the shell is in front. Swept in `stopAgent` and right before every brain spawn; never by the periodic sweep.
- **worker**: label `dispatch-<id8>` + `DISPATCH_TASK_ID=<id>` (matching) + a Companion proposal for that id in the brain thread. Closed when the live Turso phase is `pr`/`completed`/`done`/`failed`/`cancelled`, Turso `updated_at` is ≥ 2 min old, it has one pane, and herdr read it settled (agent `done`/`idle`, or no agent and the shell in front) on 2 consecutive sweeps (every 30 s). Anything unknown (env unreadable, Turso not polled yet, task not found) keeps.

`workspace get` is re-read (one pane, same label) right before every `workspace close`.

`COMPANION_BRAIN_REAP`: `observe` (default) runs everything except `workspace close` and logs `would close <ws> (<label>): <reason>` once per workspace; `on` closes; `off` sweeps nothing.

`{op:"list"}` → `{ok, mode, sessions:[{workspaceId, kind:"brain"|"worker", taskId?, proposalId?, phase?, agentStatus, verdict:"close"|"keep", reason}]}`: brain-owned workspaces only.

`{op:"close", workspaceId}` uses the sweep's verdict, minus the time grace (one settled read is enough):

| answer | when |
|---|---|
| 200 `{ok, closed}` | closed (`gone:true` when it was already gone) |
| 404 `not_owned` | not a brain-owned workspace |
| 409 `running` (+`phase`) | the task is not terminal |
| 409 `self` | the live brain's own workspace |
| 409 `observe_only` (+`verdict`, `reason`) | the reaper is not `on` |
| 409 `kept` (+`reason`) | any other keep (split, settling, unreadable) |
| 409 `changed` / `in_flight` | the workspace changed before the close / another close is running |

### Dead agent PRs (`/hooks/brain/pr-close`)

`wiring/brain-pr-close.ts` reads the PR from GitHub (`gh pr view`) and Turso, never from the brain's word. Closed only when it is open, its head is `dispatch/*` (never `deps/*`, `agent/chores*` or a human branch) and at least one holds: `mergeable` CONFLICTING · superseded (its task's `dispatch_pr_url` is another PR) · its task done or cancelled · its newest shepherd park (`pr:needs-human`, not lifted by a later `pr:unpark`) says the fix budget is spent (`CI still failing after N fixes`, `merge conflict unresolved after N attempts`, `review verdict CHANGES after N fix runs`). Then `gh pr close --comment "Closed by the brain: <reason>"` (secrets redacted, branch kept), state read back CLOSED, an `agent_activity` row `brain:pr-close` (meta: repo, pr, url, branch, reason, evidence) and an event turn in the brain thread.

| answer | when |
|---|---|
| 200 `{ok, closed, url, evidence}` | closed |
| 400 | bad repo / pr / reason |
| 403 `not_agent_branch` (+`branch`) | head is not `dispatch/*` |
| 404 `pr_not_found` | gh cannot read it |
| 409 `not_open` (+`state`) | already closed or merged |
| 409 `not_dead` | none of the four signals |
| 502 `close_unverified` · 503 `gh_unreachable` / `turso_unreachable` | nothing recorded |

### Routine agent PRs (`/hooks/brain/pr-merge`)

`wiring/brain-pr-merge.ts` reads the PR from GitHub (`gh pr view`) and Turso, never from the brain's word, and refuses on any doubt. It checks, in order:
1. The PR is open, not a draft, and its head is `dispatch/*`.
2. **parked** refuses when any of these holds:
   - A label says do-not-merge, dnm or wip.
   - The newest shepherd `pr:hold`, or a `pr:needs-human` whose reason means the work is broken (conflict unresolved, fix budget spent, no CI…), is not lifted by a `pr:unpark`. Park rows are matched on the PR url and on the tasks linked by `dispatch_pr_url`.

   The MFA / human-review gate was retired on 2026-10-31. Money, billing, MFA, auth, schema or config paths, title, body or labels no longer refuse. A web, client, internal or unset task origin no longer refuses. The shepherd's human-review park no longer refuses either (`client-origin PR`, `tainted (…)`, `touches … — needs your review`).
3. **not_green** refuses unless `mergeable` is MERGEABLE, `mergeStateStatus` is CLEAN, and every check passed, with at least one SUCCESS.
4. **not_approved** refuses unless both a Claude (`🤖 **Auto-review**`) and a Codex (`🧠 **Codex review**`) comment say `VERDICT: APPROVE`, stamped `<!-- reviewed-sha: <head> -->` and posted by the PR's author. It also refuses on any CHANGES on that head, or a GitHub CHANGES_REQUESTED.
5. **merge_cap** refuses after 10 brain merges in 24 h.

The merge itself is `gh pr merge --squash --delete-branch --match-head-commit <checked head>`. The state is read back as MERGED, then an `agent_activity` row `brain:pr-merge` is written (meta: repo, pr, url, branch, head, title, reason, tasks; the machine digest lists these) and an event turn goes to the brain thread.

| answer | when |
|---|---|
| 200 `{ok, merged, url, head}` | merged |
| 400 | bad repo / pr / reason |
| 403 `not_agent_branch` (+`branch`) · 403 `parked` (+`reasons`) | broken or held |
| 404 `pr_not_found` | gh cannot read it |
| 409 `not_open` / `draft` · 409 `not_green` / `not_approved` (+`reasons`) | not now |
| 429 `merge_cap` | 10 brain merges in 24 h |
| 502 `merge_unverified` · 503 `gh_unreachable` / `turso_unreachable` | nothing recorded |

## Hooks (no hook-script change)

The brain is a **normal Claude Code session**: its tool limits are `brain/CLAUDE.md`, `brain/.claude/settings.json` (deny Edit/Write/MultiEdit/NotebookEdit; allow Turso read + note_create/note_update, Gmail drafts + send + reply, `bin/propose|lead|thread|sessions|todo|pr-close`) and the normal permission flow (SUPER, auto-judge → phone). It is detected by `X-Companion-Task-Id: brain` first, then the registered session's taskId.

- PreToolUse: the brain takes the normal path like any session (SUPER, then auto-judge → phone; Jeremie, 2026-10-29). Its hooks also refresh the supervisor's busy deadline (UserPromptSubmit too).
- Stop: the reply becomes an `orchestrator` turn in the brain thread (adopted session only); no waiting badge, no push, no global auto-compact (`compactTargetFor` excludes brain and `lead-*`).
- SessionStart: the supervisor adopts the session only when it sits in the pane it spawned (herdr's `brain` agent pane after a Companion restart), never replacing a live adopted session, and never while paused.

## Supervisor rules

- Paused flag re-read before every spawn, in SessionStart adoption and before every delivery.
- `busy` (a typed turn waiting for its Stop) clears after 10 min with no hook from the brain.
- `down` (3 respawns in 5 min) lasts until a manual resume or restart.

## Delivery rules

The supervisor types queued turns only into a session that has a non-empty key, `taskId === "brain"` and the adopted session id — never a cwd, never the most-recent-session fallback. `not_submitted` marks the turns `maybe` and they are never retyped into that session; a fresh session's boot seed cites every open turn. Idle compaction (no turn for 15 min, context > 60 %) and the 04:00 rollover run between turns only.
