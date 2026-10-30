# Change Plan: one work stream (Turso task d24874433d5d8ba516bfcbc1a93ffeb6)

Decision (Jeremie, 2026-10-21): code work has ONE pipeline.

```
Turso tasks row ─▶ pending ─(dashboard /tasks release stamp, task_stamps kind=release, C-020, MFA)─▶ queued
  ─▶ dispatch-run claims (queued→running, owner = host) ─▶ builder (git isolation, branch + PR)
  ─▶ PR shepherd cascade ─▶ merged ─▶ dispatch-reconcile marks done
```

The release stamp is the only human checkpoint. Nothing else claims a row, and nothing else runs a builder.

Line numbers are for `main` at 07b190c (claude-companion) and claude-config `main` as of 2026-10-21.

## Finding that changes the approve path

`tasks.origin` defaults to `'unknown'` (NOT NULL). The Turso trigger `tasks_queue_guard_ins` aborts any INSERT with `dispatch_status='queued'` when origin ∉ {jeremie, system, client} and the row has no `release` stamp. That has two consequences:

1. Companion's `fileTask` (`server/lib/dispatch-tasks.ts:400-405`) inserts `queued` and sets no origin. Every headless approve and every `POST /dispatch` is refused by the trigger, which the route reports as a 503 `turso_unreachable`. In the last 30 days no Companion-filed row (`Filed from Companion` in the description) is in `queued` or `pending`: 9 are cancelled and 10 completed, all `origin='unknown'`.
2. `claimLive` (`server/lib/dispatch-live.ts:19-28`) inserts `running` directly. The trigger only checks `queued`, so a live run is the one Companion path that still starts work, and it skips the release stamp entirely.

So "approve files a tasks row and nothing else" means: Companion files the row as **`pending`**, and the dashboard `/tasks` stamp releases it to `queued`. Companion never writes `queued` or `running`. The phone shows the row as `pending-approval`, with a deep link to the dashboard.

## Entry points that start code work

K = kept as a pipeline stage. F = changed so it only files a tasks row (`pending`) and the pipeline runs it. D = deleted.

### claude-companion

| # | Entry point | Where | Today | Disposition |
|---|---|---|---|---|
| 1 | `POST /api/orchestrator/proposal/<id>/approve` (default) | `server/routes/orchestrator.ts:255-263` → `server/wiring/proposals.ts:24-33` → `fileProposal` `server/wiring/orchestrator.ts:336-367` → `fileTask` `server/lib/dispatch-tasks.ts:400` | INSERT `queued` (the trigger refuses it, see above) | **F**: `fileTask` inserts `pending`. Response `status:"pending_approval"` + `approveUrl` (dashboard `/tasks?task=<id>`). `markFiled` stays. |
| 2 | approve `{mode:"live"}` | `server/wiring/proposals.ts:27-29` → `approveLive` `server/wiring/live.ts:121-155` → `claimLive` `server/lib/dispatch-live.ts:19` | INSERT `running`, owner `companion:<host>`, a tmux worker on this host | **D**: `mode` is ignored, so it is the same as #1. |
| 3 | `POST /api/orchestrator/dispatch` (default) | `server/routes/orchestrator.ts:285-309` (`fileTask` at :302), route :428 | INSERT `queued` (refused) | **F**: same `pending` insert as #1. |
| 4 | `POST /api/orchestrator/dispatch {mode:"live"}` | `server/routes/orchestrator.ts:289-293` → `dispatchLive` `server/wiring/live.ts:157-198` | INSERT `running` + tmux worker | **D** |
| 5 | Auto-dispatch channels (trust ramp) | `server/wiring/orchestrator.ts:409-416` (`applyDecision` → `fileProposal`) | files without a tap | **F** for free: it goes through #1 and so lands in `pending`. The stamp is still required, so "auto" now only skips the tap in Companion. |
| 6 | Triage `approve` option (`mode` live/headless) | `server/lib/triage.ts:257`, `server/wiring/triage.ts:268-276` | → `approveProposal` with `mode` | **F**: no `mode` (always #1). The `live`/`headless` option variants are deleted. |
| 7 | Repo card "Yes" on a proposal member | `server/wiring/triage-repos.ts` (header :1-12) → `actOn(approve)` | → #6 | **F** (inherits #1). |
| 8 | #Body Mac fix card approve (Zettlab → Mac forward) | `server/wiring/body-fix.ts:55-64` (intercept), `server/lib/body-fix.ts:142` (POST to the peer), `server/routes/body.ts:133` (`/api/body/fix`), `runBodyFix` `server/wiring/body-fix.ts:94-111` → `approveLive` | live run on the Mac, owner `companion:<mac>` | **D** for the forward and the live run. The card files a `pending` row like #1, keeping its `[repo:<name>]` title marker. The row is tagged `requires_host='mac'`, so only the Mac's dispatch-run claims it (Q1, slice G). |
| 9 | #Body "agent" tap | `server/wiring/body-agent.ts:23-25,119,182` → `approveLive` | live run in the component's cwd | **F**: files `pending` (the tap is no longer the approval; the stamp is). |
| 10 | Blocked-task takeover (triage option `takeover`) | `server/lib/triage.ts:160,196,460-470` (`withTakeover`), `server/wiring/triage.ts:216-217,329-331,455`, `server/wiring/takeover-choose.ts:41,61`, `server/wiring/takeover.ts` (claim :219, stop :480, end :491, tick :552), `server/wiring/takeover-liveness.ts`, `server/lib/takeover.ts`, `server/lib/takeover-store.ts`, `server/lib/dispatch-live.ts:96-149` (`claimTakeover`/`finishTakeover`), peer route `server/routes/triage.ts:18,109-124`, hooks `server/routes/hooks.ts:442-443,539-542`, `server/wiring/dispatch.ts:49-51` (`takeoverIdentity`) | guarded blocked→running, owner `companion:takeover:<name>`, a herdr interactive session that builds outside dispatch-run | **D**. The option becomes the existing guarded **`unblock`** (`answer` = Jeremie's text, plus the how-to ref) or **`requeue`** (`server/lib/dispatch-tasks.ts` `unblockTask`/`requeueTask`, dispatch.sh vocabulary). `TAKEOVER_ENDED` hints (`server/lib/triage-sources.ts:3,42`, `server/lib/resolver.ts:2,83`, `server/lib/triage-repos.ts:94`) are removed. The `takeovers` table is left in companion.db (no migration; nothing writes it). |
| 11 | Live run lifecycle | stop hook `server/routes/hooks.ts:434` (`finishLiveFromStop`), boot `cli.ts:200,224` (`reconcileLiveOnBoot`), cancel `server/routes/orchestrator.ts:164,214-217,264-279` (`cancelLiveRoute`), reject cleanup `server/wiring/proposals.ts:46-48`, dead worker `server/wiring/orchestrator.ts:84-89,146-151`, identity `server/wiring/dispatch.ts:49-51`, `isLiveLinked` `server/lib/dispatch-tasks.ts:193,204` | closes live rows | **D** with #2/#4. Rows still `running` with owner `companion:<host>` at deploy time: a one-off `dispatch.sh <id> failed` sweep (listed in the PR), not a boot shim. |
| 12 | Local tmux worker runner | `executeDispatch` `server/wiring/orchestrator.ts:277-307`, `workerQueue` :114-130, worker tail :139-160, `sendToTmux`, `server/lib/orchestrator-queue.ts` | spawns `claude` workers (live mode only since one-queue P2) | **D** (no caller once #2/#4/#8/#9 are gone). |
| 13 | Opus resolver PR fix run | `server/lib/resolver-fix.ts:135` (`runPrFix`: worktree + `claude -p --agent builder` + push to the PR branch), `server/wiring/resolver.ts:221-235`, peer `server/wiring/resolver-peer.ts`, `server/lib/resolver-peer.ts:107` | a builder run on a PR branch, no tasks row | **D**: the resolver's "fix" outcome becomes `pr:unpark` (the shepherd's fix run, which is a pipeline stage) or a filed `pending` task when the PR has no task row. See Q2. |
| 14 | Interactive session spawn | `server/routes/api.ts:193` (`spawnCompanionSession`) | a session Jeremie drives himself; no tasks row is touched | **K** (not a builder; it writes no task state). |
| 15 | Guarded cancel / requeue / unblock | `server/routes/orchestrator.ts:189-248` → `server/lib/dispatch-tasks.ts` | dispatch.sh vocabulary, CAS | **K** (this is what takeover becomes). |

### claude-config

| # | Entry point | Where | Disposition |
|---|---|---|---|
| 16 | dispatch-run claim | `tools/dispatch-run.ts:225`, client claim `tools/client-origin.ts:140` | **K**: the runner. |
| 17 | dispatch.sh transitions | `tools/dispatch.sh` | **K**: the vocabulary. |
| 18 | Filers | `tools/file-dev-task.sh` (origin `web`, `pending`), `tools/dispatch-file-task.ts` | **K** |
| 19 | PR shepherd fix / merge | `tools/pr-shepherd.ts` | **K**: the shepherd stage. |
| 20 | Relay ACK claims any row | `mods/relay/hooks/register.ts:50` (`DISPATCH_FROM: 'null,queued,blocked,failed,completed'` → `running`, owner `companion:relay:<peer>`) | **F**: the relay no longer claims. A `TASK <tasks.id>` is delivered only when the row is already `running` with owner `companion:relay:<to>`; the planner claims it first with `DISPATCH_FROM=queued DISPATCH_OWNER=companion:relay:<builder> dispatch.sh <id> running`. Since the row has to be `queued`, the release stamp has already happened. Otherwise the send is refused with a toast. ACK writes nothing. DONE and ABORTED stay guarded on `running`. |
| 21 | Ad-hoc relay ids | `skills/handoff/SKILL.md:21` (`t-<topic>-1`) | **F (doc)**: `t-*` ids are for read-only lookups only (questions, research, reviews). Any code change needs a tasks row. |
| 22 | `tools/handoff-builder.sh` | starts a herdr Remote Control builder session | **K** (it only starts a session; work reaches it only through #20). |
| 23 | Ad-hoc Agent subagent builders in sessions (no row) | policy, not code (`/change`, `/build`, direct Agent calls) | **F (doc)**: rule in `skills/handoff/SKILL.md` and the global CLAUDE.md "Capability gaps → dev tasks": code work files a task (`file-dev-task.sh`). Nothing in code enforces it. |

### iOS (`jaubut/claude-companion-ios`, Mac only, not reachable from Zettlab)

| # | View | Disposition |
|---|---|---|
| 24 | Proposal card "Run live" / mode picker, takeover option, separate live/takeover task rows | **D**: ONE list driven by the unified endpoint below. A `pending_approval` row opens `approveUrl` in Safari. Needs a mobile-ux-auditor pass. |

## New: one pipeline list

`GET /api/orchestrator/pipeline` returns `{items:[{id, title, agent, noteId, state, prUrl, shepherd, updatedAt, approveUrl?}], generatedAt}`. It is read from Turso: tasks with `assignee LIKE 'agent:%'`, open or closed in the last 7 days, with the shepherd verdict taken from the latest `agent_activity` `pr:*` row for `dispatch_pr_url`.

`state` comes from one pure mapper:

| tasks row | state |
|---|---|
| `pending` | `pending_approval` |
| `queued` | `queued` |
| `running` | `running` |
| `completed` + PR open | `pr_open` (+ `shepherd`) |
| PR merged / `done=1` with a PR | `merged` |
| `blocked` / `failed` / `cancelled` | the same name |

Tests run fixtures for each state through the mapper. The existing `orchestrator_task` frames stay as the live feed (same DTO plus `state`).

## Slices (each one PR, each one stays under the ~25-file gate)

| Slice | Repo | Rows | Files (est.) |
|---|---|---|---|
| A: approve = file `pending` only; delete live mode (claimLive/finishLive, `wiring/live.ts`, the Mac live forward `/api/body/fix`); Mac fix rows tagged `requires_host='mac'` | claude-companion | 1-4, 6-9, 11 | ~24 |
| A2: delete the tmux worker runner (dead once A lands: `executeDispatch`, `workerQueue`, worker tail, `lib/orchestrator-queue.ts`, worker identity) + the auto-dispatch toggle (Q3) | claude-companion | 5, 12 | ~15 |
| B: takeover → unblock/requeue; delete takeover | claude-companion | 10 | ~18 (7 deleted modules + their tests, triage/resolver/hooks edits, docs) |
| C: resolver fix → shepherd `pr:unpark` (Q2) | claude-companion | 13 | ~8 |
| D: unified pipeline list | claude-companion | new endpoint | ~5 |
| E: relay claim guard + handoff doc | claude-config | 20-23 | ~4 |
| F: iOS single list | claude-companion-ios (Mac) | 24 | Mac session |
| G: host tag. Turso `ALTER TABLE tasks ADD COLUMN requires_host TEXT NOT NULL DEFAULT 'any' CHECK (requires_host IN ('any','mac','zettlab'))`, mirrored in three files (live DB, `tls-dashboard-v2/server/lib/data/schema.sql`, `tls-dashboard-v2/tests/_helpers/test-db.ts`; memory `feedback_schema_sync_three_files`). dispatch-run's claims (`tools/dispatch-run.ts:225`, `tools/client-origin.ts:140`) add `AND requires_host IN ('any', ?)`, where `?` is the runner's host label (mac on darwin, else zettlab). The selector skips rows meant for the other host. Tests in `tools/dispatch-select.test.ts` / `dispatch-runner.test.ts`. | tls-dashboard-v2 + claude-config | Q1 | ~6 |

## Scope gate

The whole change touches about 60 files in two reachable repos: 47 existing claude-companion files reference live/takeover, plus the new endpoint, claude-config and docs. The iOS half can only be done on the Mac. That is more than 2× this plan's single-PR budget and more than the 25-file cap, so this PR ships the plan only. Each slice is dispatched as its own task.

## Decisions (Jeremie, 2026-10-22)

- **Q1, Mac-host fixes: tag the machine.** A task can carry a host requirement in a new `tasks.requires_host` column, `'any' | 'mac' | 'zettlab'` (NOT NULL DEFAULT `'any'`). dispatch-run only claims a row whose requirement is `'any'` or its own host. That work is slice G. Slice A sets `requires_host='mac'` when Companion files a Mac-only task (a #Body fix card whose host is `mac`), and only when the column exists (`detectColumns`, the same way `dispatch_pr_url` is handled). Until G ships, such a row files untagged and the Zettlab race remains.
- **Q2: accepted.** The shepherd's fix run (`pr:unpark`) replaces the resolver's PR fix run. That is slice C.
- **Q3: accepted.** The auto-dispatch toggle is removed. That is slice A2.
- **Trust (2026-10-23, revised 2026-10-25):** every approve tapped in Companion is Jeremie's approval — typed dispatch, a proposal card's approve (any channel, #Body and Opus rescopes included), the Body "Get an agent on it" tap — origin `jeremie`, straight to `queued`. Jeremie (2026-10-25): "the approval on the app need to be valid. no back and forth." Only filings with no tap (auto-dispatch) stay `pending` for the dashboard stamp.

## Verify (per slice)

- A: `bun test`. New tests: approve produces exactly 1 tasks row (`pending`) and 0 rows `running`; `mode:"live"` produces the same result as the default. Grep proof: `grep -rnE "'running'" server | grep -E "INSERT|SET dispatch_status"` has no hits outside the guarded transitions in `lib/dispatch-tasks.ts`.
- B: the takeover option is gone; choosing `unblock` on a blocked card goes through `unblockTask`'s CAS (409 when the row moved).
- D: pipeline endpoint fixtures cover queued, running, pr_open, merged and pending_approval.
- E: the relay tests show a TASK to an unclaimed row is refused, ACK runs no dispatch.sh, and `bash tools/*.test.sh` plus `bun test` in tools pass.
