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
turn.card? = {kind:"dispatch"|"voice"|"worker_blocked", source:"app", taskId?, audioId?, durationMs?, locale?, …worker_blocked fields}
```

- `voice`: a user turn sent from the 🧠 composer with `voice` (below); `audioId` arrives later when the take is archived (the turn is re-sent with the same id).
- `dispatch`: a receipt the poller writes into the brain thread (role `orchestrator`) when a task moves to blocked / PR / completed / done. `card.taskId` is the Turso id. **`turn.taskId` stays null** on card turns (shipped builds group taskId turns as worker output). The old channel still gets its turn until P3.
- `worker_blocked`: a dispatch worker stuck on a dialog, with its options and `state` open | answered | expired. Contract: `docs/worker-blocked-api.md`.
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
| POST | `/hooks/brain/propose` | `{title, prompt, noteId, agent?, reasoning, sourceTurnId, handoff?}` | see below |
| GET | `/api/brain/workers` | | `{ok, mode, sessions, foreign}`: the reaper's dry run (below). `foreign` counts every other workspace and never names one. |
| POST | `/hooks/brain/sessions` | `{op:"list"}` · `{op:"close", workspaceId}` | see below. Same auth as propose (brain/bin/sessions). |
| POST | `/hooks/brain/thread` | `{q, limit?}` (q ≤ 200 chars, limit 1–50, default 20) | `{ok, turns: [{id, role, at, text}]}`: brain-thread turns containing q, newest first, text ≤ 1,000 chars. Same auth as propose (brain/bin/thread). |
| POST | `/hooks/brain/pr-close` | `{repo, pr, reason}` (repo `owner/name`, reason ≤ 300) | see below. Same auth as propose (brain/bin/pr-close). |
| POST | `/hooks/brain/pr-merge` | `{repo, pr, reason}` (repo `owner/name`, reason ≤ 300) | see below. Same auth as propose (brain/bin/pr-merge). |
| POST | `/hooks/brain/pr-update-branch` | `{repo, pr, reason}` (repo `owner/name`, reason ≤ 300) | see below. Same auth as propose (brain/bin/pr-update-branch). |
| POST | `/hooks/brain/task-cancel` | `{task, reason}` (task = id or 8-char prefix, `^[\w-]{8,64}$`; reason ≤ 300) | see below. Same auth as propose (brain/bin/task-cancel). |
| POST | `/hooks/brain/lead` | `{repo}` | `{ok, name, state}`: `running`, `starting`, `started`; 404 `no_lead_for_repo`; 502 down. Same auth as propose (brain/bin/lead). |
| POST | `/hooks/brain/deploy` | `{repo, reason}` (repo `claude-companion` \| `claude-config`, reason ≤ 300) | deploy now, see below. Same auth as propose (brain/bin/deploy). |
| POST | `/hooks/brain/todo` | `{text, noteId, due?, sourceTurnId}` (text ≤ 300; noteId = note id or ref code; due YYYY-MM-DD) | `{ok, taskId, replay}`: a to-do for Jeremie (assignee human:jeremie, never queued) + a `todo` trace row under the turn. Same auth as propose (brain/bin/todo). |

All `/api/brain*` are Bearer-gated; every one answers 404 `brain_disabled` off the brain host.

### `POST /hooks/brain/propose` (brain/bin/propose)

Auth — all of: TCP peer loopback with no forwarded hop (`clientOrigin(...).transport === "loopback"`; a `tailscale serve` request is 403), `X-Companion-Task-Id: brain`, and `X-Companion-Pid` = the pid of the registered brain session whose session id the supervisor adopted. Else 403.

- `noteId` missing → 422 `no_project`; unknown → 404; Turso down → 503; unknown agent → 400 `unknown_agent`.
- Dedupe on (`sourceTurnId`, sha256(prompt)): a repeat answers `{ok, proposalId, replay:true}` and creates nothing.
- `handoff: true` files a row and queues nothing, without a proposal: `{ok, taskId, origin, replay}`. `origin` is what the row stored (`jeremie` or `unknown`, always `unknown` without an origin column); `replay:true` = this turn, note and prompt were already filed.
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

### Stuck PRs

`wiring/brain-stuck-events.ts` polls `pr:brain-event` rows with a `stuck_key` every minute and posts each new one to the brain thread. The rows come from the PR shepherd in claude-config, one per PR per stuck state. Accepted kinds: `stuck-parked`, `stuck-no-review`, `stuck-main-red`, `stuck-main-cancelled`, `loop-round-3`, `loop-repeat`, `loop-budget`, and `loop-stop`. Rows do not require `head_sha`. The cursor is `brain_kv`'s `stuck-events-cursor`. Its first run posts one summary and replays nothing. Only checked fields are posted, and the reason is one quoted line of data capped at 200 characters.

### Repo leads (`/hooks/brain/lead`)

`LEAD_REPOS` in `lib/brain.ts` lists the repos with a lead. A lead is one persistent `lead-<repo>` herdr workspace with one pane (auto mode, cwd its own clone `~/leads/<repo>`, so the sandbox keeps its Bash out of the live checkout and `brain/`, no plan-mode tools: nobody can approve ExitPlanMode; no file-editing tools, by `--disallowedTools` and by `.claude/settings.local.json` in that clone, which survives a herdr restore and which the sandbox keeps a lead's Bash from writing; the same file turns off unsandboxed Bash and makes the clone's whole `.claude` and `.git` read-only, and denies every user-level `excludedCommands` entry, read at spawn), following `brain/LEAD.md`. The server makes a fresh shallow clone at each spawn, never running git in a tree a lead could write, and a clone it can't make or trust refuses the spawn. The clone is only replaced once the old lead is gone: a lead that can't be cleared answers `down` and keeps its tree. `bin/lead` also replaces a running lead whose clone settings aren't exactly what the server wrote (one from before clones, or one that lost or changed them), if the workspace is the lead's alone; that answers `started`, so the brain resends what is open. The server holds no queue: `wiring/brain-lead.ts` only finds or starts it. Work, merge requests and escalations are plain relay messages. A lead has no merge or close rights: the brain runs `bin/pr-merge` and `bin/pr-close`, on dispatch branches only. It starts no builders either: it asks the brain with `builder <repo>: <task-id>`, and the brain runs `handoff-builder.sh`. The script runs unsandboxed on values a lead supplies, so `brain/CLAUDE.md` § Repo leads has the brain refuse anything but the sender's own repo, a plain id and its own builders, and defines the limit of 3 unparked PRs per repo (new tasks only; a builder with no PR yet counts). All of that is the brain's judgement: no code enforces it. A lead's turn end sets no waiting badge and sends no push.

`bin/lead <repo>` starts a fresh lead when the old one is not running (`alive()`, since herdr can keep a dead agent's record, also after a restore). On `name_taken` the leftover is cleared only when its workspace is the lead's alone (labelled `lead-<repo>`, one pane, the agent's) and the pane's shell is back in front. Anything else, or an unreadable answer, is left alone and answers 502.

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
1. The PR is open.
2. **The merge gate** (`lib/merge-gate.ts`, the same call the tap makes) reads the PR live and asks claude-config's `tools/pr-gate.ts`, with `approved: false`. It takes no branch, so no head is exempt: a `sync/*` PR gets a named stop before `not_agent_branch`. A stop outranks `draft`. If the gate can't load or read, or fails its self-check, the merge is refused with 409 `gate_unavailable`; there is no fallback.
3. The PR is not a draft, and its head is `dispatch/*`.
4. **parked** refuses when the newest shepherd `pr:hold`, or a `pr:needs-human` whose reason means the work is broken (conflict unresolved, fix budget spent, no CI…), is not lifted by a `pr:unpark`. Park rows are matched on the PR url and on the tasks linked by `dispatch_pr_url`.

   The MFA / human-review gate was retired on 2026-10-31. Money, billing, MFA or config paths, title, body or labels no longer refuse here; the hard stops are the merge gate's (step 2). A web, client, internal or unset task origin no longer refuses on its own. The shepherd's ordinary human-review parks no longer refuse either (`client-origin PR`, `touches … — needs your review`). A tainted park (`tainted (…)`) or one whose reason says `human merge` is never retired, whatever prefix it carries, and a live one refuses with 403 `parked`.
5. **not_green** refuses unless `mergeable` is MERGEABLE, `mergeStateStatus` is CLEAN, and every check passed, with at least one SUCCESS.
6. **not_approved** refuses unless both a Claude (`🤖 **Auto-review**`) and a Codex (`🧠 **Codex review**`) comment say `VERDICT: APPROVE`, stamped `<!-- reviewed-sha: <head> -->` and posted by the PR's author. It also refuses on any CHANGES on that head, or a GitHub CHANGES_REQUESTED. The newest `<!-- review-tier: x -->` comment by the PR's author lowers the bar: `normal` needs only the Claude APPROVE; `low` needs no review when every file is `docs/*.md`, `README.md`, `*.test.ts` or `architecture.{json,md}`, checked here because anyone can post the marker. `high`, no marker, or `low` on other files needs both.

   Temporary, `rm` the file to restore: while `~/.claude/state/claude-review-paused` exists (checked on every call), a `normal`-tier PR with no `client` task origin or `client-origin` label needs the Codex APPROVE instead of the Claude one (still no CHANGES from either reviewer). High, unmarked, low-on-code and client-origin PRs need both.
7. **merge_cap** refuses after 10 brain merges in 24 h.

The merge itself is `gh pr merge --squash --delete-branch --match-head-commit <checked head>`. The state is read back as MERGED, then an `agent_activity` row `brain:pr-merge` is written (meta: repo, pr, url, branch, head, title, reason, tasks; the machine digest lists these) and an event turn goes to the brain thread.

| answer | when |
|---|---|
| 200 `{ok, merged, url, head}` | merged |
| 400 | bad repo / pr / reason |
| 403 `human-merge-path` / `tainted-sensitive` / `prod-schema` / `hold-label` (+`action`, `reason`, `head`) | the merge gate's hard stops; a human merges on GitHub, or removes the label |
| 403 `not_agent_branch` (+`branch`) · 403 `parked` (+`reasons`) | broken or held |
| 404 `pr_not_found` | gh cannot read it |
| 409 `gate_unavailable` (+`detail`) | the gate can't answer here (missing, broken, gh or Turso failing): a host fault, not the PR's |
| 409 `head_moved` | the head changed during the check; ask again |
| 409 `base_moved` | the base branch changed during the check, or by the last read before the merge (a retarget changes the diff, not the head); `gate_unavailable` if that read fails; ask again |
| 409 `client_gone` | the caller hung up before the merge, nothing merged. It reaches nobody, it shows in the log |
| 409 `not_open` / `draft` · 409 `not_green` / `not_approved` (+`reasons`) | not now |
| 429 `merge_cap` | 10 brain merges in 24 h |
| 502 `merge_unverified` · 503 `gh_unreachable` / `turso_unreachable` | nothing recorded |

### Stale agent PRs (`/hooks/brain/pr-update-branch`)

Dispatch workers cannot create merge commits, so a dispatch PR with stale CI waits on the brain. `wiring/brain-pr-update-branch.ts` reads the PR from GitHub (`gh pr view`), never from the brain's word. Repo, pr and reason get the same input checks as pr-merge. It refuses unless the PR is open, its head is `dispatch/*` and `mergeable` is not CONFLICTING. The shared `wiring/brain-pr-park.ts` helper checks linked tasks and shepherd activity in Turso: client origin (task origin or the advisory `client-origin` label), a live park (including tainted or human-merge parks), or a hold refuses before updating. A Turso read failure also refuses. The same retired review parks and newer unparks as pr-merge apply; client-origin PRs always refuse an update, even when pr-merge could merge them. Then `gh pr update-branch` without `--rebase`: a merge commit on the PR branch, never a rebase, never a force. The new head is read back (up to 5 reads, 1 s apart), then an `agent_activity` row `brain:pr-update-branch` is written (meta: repo, pr, url, branch, from, head, reason) and an event turn goes to the brain thread.

The new head voids the `reviewed-sha` stamps: `/hooks/brain/pr-merge` answers `not_approved` until the review cascade has reviewed it.

| answer | when |
|---|---|
| 200 `{ok, updated, url, head}` | updated; `head` is the new head sha |
| 400 | bad repo / pr / reason |
| 403 `not_agent_branch` (+`branch`) | head is not `dispatch/*` |
| 403 `client_origin` | a linked task has origin `client`, or the PR carries the `client-origin` label |
| 403 `parked` (+`reasons`) | live shepherd park (including tainted or human-merge parks) or hold |
| 404 `pr_not_found` | gh cannot read it |
| 409 `not_open` (+`state`) | already closed or merged |
| 409 `conflict` | CONFLICTING, or GitHub refused the update on a conflict |
| 409 `up_to_date` (+`head`) | the base has nothing new |
| 502 `update_failed` (+`head`, the old one) | `gh pr update-branch` failed; a head that moved anyway is someone else's push, nothing recorded |
| 502 `update_unverified` (+`head`, the old one) · 503 `gh_unreachable` | nothing recorded |
| 502 `gh_bad_json` | the initial GitHub response is not valid JSON; no update attempted |
| 503 `turso_unreachable` | origin or park/hold lookup failed; no update attempted |

### Obsolete tasks (`/hooks/brain/task-cancel`)

`wiring/brain-task-cancel.ts` cancels a task the brain proposed. It decides from Turso and the server's own proposal row, never from the brain's word.

- **The brain's own:** `getTaskByDispatchId(<id read from Turso>)` must give `threadId` `brain` and status `filed`. That row is written only behind `bin/propose`, or by an Opus rescope of such a proposal. `tasks` has no proposer column and brain filings carry origin `jeremie`, so the Turso row can't tell; the description marker can be forged by a prompt. The store is host-local: a task from another host or a rebuilt store refuses.
- **Only `queued`, `blocked` and `failed`.** A running task is refused outright: no lease exists, so nothing can prove its worker is gone.
- **One transaction:** a compare-and-set on status, assignee, owner and PR URL, plus its `agent_activity` row (`brain:task-cancel`, meta: from, reason, priorBlocker, prUrl, prState). Both or neither; a row that moved answers `changed` with nothing written. The row ends `cancelled`, done=1, with `Cancelled by the brain: <reason>` in `dispatch_blocker`.
- **After the commit:** an event turn in the brain thread, its title and reason sanitised and quoted as data. A failed turn is logged and still answers 200. The phone shows no reason: the task DTO carries a blocker only for blocked and failed rows.
- **Never retried by a runner.** dispatch-run, its sweeps, pm-nightly and the shepherd don't match a cancelled row, and a card or the resolver can only requeue a row still at the status it read (`requeueTask`'s `from`). Jeremie's direct Retry stays the undo: it revives a cancelled row and logs `dispatch:queued`. `dispatch.sh <id> queued` without `DISPATCH_FROM` is unguarded (claude-config).
- A cancel's `POST` may time out after the commit: the answer is 503 and a retry answers `already_final`.

bin/task-cancel prints the JSON: exit 0 cancelled, 22 refused, 2 usage, any other curl code = no answer.

| answer | when |
|---|---|
| 200 `{ok, cancelled, from, pr?, prState?, note?}` | cancelled; an OPEN PR is named, close it with `bin/pr-close` |
| 400 | bad task / reason |
| 403 `not_agent_task` · 403 `not_brain_task` | not an agent task · no filed brain proposal for it |
| 404 `not_found` | no such task, or an ambiguous prefix |
| 409 `already_final` (+`prState`) | done, cancelled, or its PR merged |
| 409 `running` (+`owner`) · 409 `not_cancellable` (+`status`) | running · pending, pr, completed or no status |
| 409 `changed` | the row moved mid-cancel, nothing written |
| 503 `pr_state_unknown` / `turso_unreachable` | not cancelled, or see the time-out above |

### Deploys (`wiring/auto-deploy.ts`, `/hooks/brain/deploy`)

The brain host (`COMPANION_BRAIN=1`, Linux) polls every 60 s. It fetches origin/main for two fixed checkouts: `~/claude-companion` and `~/.claude` (claude-config). A new origin/main deploys once it has stayed put for 2 min, so a burst of merges is one deploy. A refused head is retried only when origin/main moves. `bin/deploy` deploys now, with the same checks.

- **Both repos:** the checkout is on `main`, and HEAD is an ancestor of origin/main. Otherwise 409 `not_on_main` / `not_fast_forward`; the deployer never resets, forces or checks out a ref.
- **claude-companion:**
  - `git merge --ff-only`. If a local edit would be overwritten, git refuses before touching anything: 409 `dirty_overlap`. Other local edits stay.
  - `bun install --frozen-lockfile` when `package.json` or `bun.lock` changed. On failure: 502 `install_failed`, no restart.
  - `systemctl --user restart --no-block claude-companion.service`. The row and event are written first; the next boot posts "restarted at <sha>".
- **claude-config:** `systemctl --user start --no-block claude-config-sync.service`. That unit is the existing ff-only pull, which sets the `memory/` and `skills/` runtime edits aside and restores them. A later poll posts "deployed" once `~/.claude` reaches the head, or "not deployed" with the sync flags after 10 min.

Every step writes an `agent_activity` row (`agent_slug` auto-deploy, action `deploy`, meta: repo, from, to, commits, result, source) and an event to the brain thread. The answers are `{ok, result: up_to_date | restarting | sync_started, from, to, commits}`, or `{ok: false, error}`. The errors are 400 `repo_not_allowed`, 409 `deploy_in_progress` and 502 `fetch_failed` / `sync_start_failed` / `restart_failed`. The route answers 404 `deploy_disabled` where the deployer doesn't run.

## Hooks (no hook-script change)

The brain is a **normal Claude Code session**: its tool limits are `brain/CLAUDE.md`, `brain/.claude/settings.json` (deny Edit/Write/MultiEdit/NotebookEdit; allow Turso read + note_create/note_update, Gmail drafts + send + reply, `bin/propose|lead|thread|sessions|todo|pr-close|pr-merge|pr-update-branch|task-cancel|deploy`) and the normal permission flow (SUPER, auto-judge → phone). It is detected by `X-Companion-Task-Id: brain` first, then the registered session's taskId.

- PreToolUse: the brain takes the normal path like any session (SUPER, then auto-judge → phone; Jeremie, 2026-10-29). Its hooks also refresh the supervisor's busy deadline (UserPromptSubmit too).
- Stop: the reply becomes an `orchestrator` turn in the brain thread (adopted session only); no waiting badge, no push, no global auto-compact (`compactTargetFor` excludes brain and `lead-*`).
- SessionStart: the supervisor adopts the session only when it sits in the pane it spawned (herdr's `brain` agent pane after a Companion restart), never replacing a live adopted session, and never while paused.

## Supervisor rules

- Paused flag re-read before every spawn, in SessionStart adoption and before every delivery.
- `busy` (a typed turn waiting for its Stop) clears after 10 min with no hook from the brain.
- `down` (3 respawns in 5 min) lasts until a manual resume or restart.

## Delivery rules

The supervisor types queued turns only into a session that has a non-empty key, `taskId === "brain"` and the adopted session id — never a cwd, never the most-recent-session fallback. `not_submitted` marks the turns `maybe` and they are never retyped into that session; a fresh session's boot seed cites every open turn. Idle compaction (no turn for 15 min, context > 60 %) and the 04:00 rollover run between turns only.
