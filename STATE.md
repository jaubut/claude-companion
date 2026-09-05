# STATE — Claude Companion: Single-Thread Orchestrator (PRJ-OR1T)

Last updated: 2026-09-05

## Active Decisions

### One always-open thread, workers report back tagged
**Date:** 2026-06-22
**Choice:** A persistent single chat thread (the "orchestrator") that never blocks. Heavy work is dispatched to spawned tmux Claude workers; each worker's turn-end reports back into the one thread, tagged by task-id.
**Why:** Inverts today's N-session-babysitting model. The orchestrator stays warm because it never does heavy compute itself. Validated via /office-hours + /brainstorm.
**Rejected:** raw-scrollback context (breaks "never computing" at scale); per-worker manual tab-tracking (the current pain).
**Revisit if:** thread volume needs multi-thread (schema already carries thread_id).

### Memory-proof gate cleared Phase 0
**Date:** 2026-06-22
**Choice:** Build the orchestrator on kb-v1 recall. Phase 0 suite (`~/.claude/evals/kb-memory-proof.ts`) proved accumulate + cross-session supersede + freshness, 5/5 baseline.
**Why:** The whole idea was gated on "is memory trustworthy." It is.

### Phase 1 scope: server-only, no client UI yet
**Date:** 2026-06-22
**Choice:** Ship the thread + dispatch plumbing + tagged worker-reply server-side, curl-verified. iOS/PWA UI is a separate, mobile-ux-gated phase.
**Why:** Keeps the build tight and defers the mobile-ux-auditor gate to the UI phase.
**Rejected:** building UI now (drags the mobile gate into plumbing work).

### Phase 7 autonomy shape: cap + FIFO + user-flipped auto
**Date:** 2026-09-05
**Choice:** WIP cap 3 live workers per host (`COMPANION_WIP_CAP` override), FIFO queue past it, per-channel `autoDispatch` toggle that only the user flips. Server reports trust (approved/rejected/streak, eligible at a 5-approval streak) and posts every auto-dispatch's reasoning in the thread. Cancel is the veto: it kills the worker and flips the channel back to propose-confirm.
**Why:** autonomy must grow with proof and stay one-tap reversible from the phone. The server suggesting is fine; the server deciding to go autonomous is not (CLAUDE.md agent-dispatch policy, Jevan "read its thoughts" rule).
**Rejected:** global auto toggle (trust is per project); server auto-enabling at the streak (removes the human from the ramp); per-cwd cap (host capacity is the real limit, not the project).
**Revisit if:** Mac + Zettlab need one shared queue (today each host caps independently).

## Progress

### v0.2 — consolidation (2026-09-05)
- [x] Merged PR #4 (server channels) + iOS PR #2 (channel picker) — both sat open since 2026-07-19
- [x] Ported from Zettlab's `feat/orchestrator-phase6-channels` + `feat/kimi-agent` onto the sidebar base: brain-retry (3 attempts, backoff), kimi agent spawn (`km-` tmux prefix, env at ~/.config/kimi/kimi.env), worker-tail (live tmux tail → `orchestrator_worker_output` frame, `log_tail` persisted on finish, pane-vanished → task `error`), brain `channelCwd` anchor line. 12 bun tests, server tsc clean, route smoke on isolated port + DB
- [x] Deployed to both hosts, real dispatch e2e on Zettlab green (PONG in 15s, logTail persisted), PR #5 merged, Mac + Zettlab on `main` — 2026-09-05

### AskUserQuestion from the phone (fix/askuserquestion-driver, PR #7)
- [x] Root-caused live on Zettlab: both PreToolUse (matcher `*`) and PermissionRequest fired per question → two phone cards, two keystroke drivers into one picker; and the driver targeted the pre-2.1 picker. Fixed with hook dedupe + a pane-driven driver for the numbered-row/Submit-tab picker. Verified: 31 tests; e2e Zettlab (single→multi, multi→single with free text) and Mac (PermissionRequest-only path) — one card, "question already answered — allow" on the duplicate, "picker driven", transcript shows "User answered" — 2026-09-05

### Phase 7 — autonomy
- [x] Server (PR #6): `orchestrator-queue.ts` admission + FIFO drain (on worker exit, boot, 30s tick); `auto_dispatch` on channels + `channelTrust`; `POST /task/<id>/cancel` (kills tmux, flips auto off); `POST /channels/<id>/auto`; `/thread` returns `queue {cap, live, queued}`; statuses `queued` + `cancelled`. 22 bun tests, route smoke, two real e2e on Zettlab: 4 dispatches at cap 3 → 1 queued → cancel freed the slot and the queued task started in <5s; natural finish → drain → all 4 DONE with log tails; dead-pane backstop had flipped the killed workers to `error` — 2026-09-05
- [x] iOS (iOS repo PR #3, merged): control-room Tasks panel (queue summary, Auto-dispatch toggle + trust line, rows live → queued #N → finished, stop/remove behind a confirmation, watch), live worker tail cards + collapsed `logTail`, ramp hint, `auto` header badge. xcodebuild green; mobile-ux-auditor 5.5 → 9.5 after fixes, residual closed. Not yet on a device — needs a TestFlight build — 2026-09-05


- [x] Phase 0: memory-proof gate (kb-memory-proof suite, 5/5) — 2026-06-22
- [x] Phase 1: orchestrator-chat.ts (SQLite thread + tasks) — 2026-06-22
- [x] Phase 1: endpoints /api/orchestrator/{send,dispatch,thread} (Bearer) — 2026-06-22
- [x] Phase 1: worker bind on session-start + reply capture on stop, tagged by task — 2026-06-22
- [x] Phase 1: verified — send/thread/auth + dispatch state machine via simulated hooks; persistence across restart
- [x] Phase 1: real-worker e2e GREEN — dispatch spawns a real Claude worker, prompt delivered, reply lands tagged in 15s, fully automated (2026-06-22, after dispatch-delivery fix)
- [x] Phase 2: propose-confirm dispatch — brain (claude -p, tools disabled) classifies chat vs task; task → proposal with reasoning; approve → spawn+deliver; reject → drop. Real e2e green, fully automated (2026-06-22)
- [x] Phase 3: model tiers — Haiku gates+chats in one cheap call; Opus composes only on a task. Brain runs in a bare cwd (no project MCP). chat ~10s, task ~22s on prod (2026-06-23)
- [x] Phase 4: native iOS UI — OrchestratorView (thread + proposal cards + input) in the SwiftUI app, reachable from the top-bar sparkles button. Compiles (BUILD SUCCEEDED via xcodebuild), mobile-ux-auditor pass + fixes applied (2026-06-23)
- [x] Phase 5: Tasks panel — live dispatched-work status (running/done/error), tap-to-watch a worker. Server emitTask broadcasts + iOS TasksView. Deployed to Zettlab (2026-06-23)
- [x] Phase 6a (server): per-project channels — activate thread_id as user-created channels (canvas IDE-GMH1 rail). General seed + `main→general` backfill; channel CRUD; scoped thread/tasks/brain; `/api/orchestrator/channels` + `?channel=` on thread/send/dispatch; `orchestrator_channel` WS frame; first bun tests + `COMPANION_DB_PATH` seam. Branch `feat/orchestrator-sidebar`. Verified: 4 tests + route smoke + tsc clean on touched files (2026-07-19)
- [x] Phase 6b (iOS): channel model + header picker Menu + NewChannelSheet + per-channel turn/task filter + activity badges; handle `orchestrator_channel` frame. xcodebuild BUILD SUCCEEDED; mobile-ux-auditor 8/10 → HIGH+MEDIUM fixed (iOS repo `feat/orchestrator-sidebar`: d3c39ec + 94d8c3f) — 2026-07-19

## Learnings

- **Dialog mirror (PR #9, 2026-09-05):** a session parked on /model, /mcp, trust or MCP-enable looks dead from the phone — hooks don't fire while a dialog is up. `~/.claude/sessions/<pid>.json` says `status: waiting, waitingFor: "dialog open"`; that gates a 2s tmux capture, `dialogs.ts` parses the Ink dialog (cursor row + hint footer; numbered pickers and plain lists), and the phone gets `dialog` / `dialog_closed` frames plus `/api/dialog/key` and `/api/dialog/pick`. Row picks use Up/Down deltas: digits only work in the question picker, /model ignores them. Fixtures came from real captures — recapture if Claude Code restyles its pickers.
- **`~/.claude/sessions/<pid>.json` is the exact pid → session map** (Claude Code ≥ 2.1, found 2026-09-05): sessionId, cwd, startedAt, tmux pane, Claude's own derived name, status. Discovery now reads it instead of guessing the newest transcript in the cwd — the guess gave every $HOME peer the same id (and, once titles existed, the same name). Guessed ids are marked unconfirmed and never name a chat.
- **Chat titles = first real prompt**, persisted by session id, recovered from the transcript (any project dir) on restart; injected XML is stripped first. Picker sorts on creation time (process start), not last activity — activity-sorted menus reshuffle on every hook fire.
- **AskUserQuestion picker grammar (Claude Code 2.1.x, mapped live 2026-09-05):** tab bar `← ☐ Q1 ☐ Q2 ✔ Submit →`; digit N picks row N (single-select auto-advances, multi-select toggles); row `options+1` is "Type something" (free text, Enter confirms); Tab reaches "Review your answers", Enter submits; transcript then prints "User answered Claude's questions". Down/Space/Enter no longer apply. Drive it from the pane (`server/lib/question-driver.ts`), never from a timer.
- **Claude Code fires PreToolUse AND PermissionRequest for one AskUserQuestion** when both hooks match `*` (Zettlab). Anything a hook does per question must be idempotent across the pair — `questions.ts` keeps a 180s answered-key record. Mac's PreToolUse matches only `Bash`, so only PermissionRequest fires there; both shapes verified. Companion's stderr goes to `~/.claude-companion/companion.log` on Zettlab too, not the journal.
- **Bun test shares the module cache across files** (2026-09-05): a second test file that sets `COMPANION_DB_PATH` and imports `orchestrator-chat` either gets ignored or steals the sqlite binding from the legacy-seed fixture, depending on run order. Rule: one test file per sqlite-bound module; DI'd modules (worker-tail, queue policy) can test anywhere.
- **Same-cwd fan-out cross-matches tasks** (2026-09-05): worker binding and stop-hook matching are by cwd (Phase 1 design), so N workers in one cwd can close each other's tasks. The e2e used 4 distinct cwds. Fix = per-worker identity in hook headers (tmux session name) — Phase 8 candidate.
- Zettlab companion's previous 2.6-day run peaked at 6.7G RSS + 1.4G swap (journal, pre-v0.2 code). Cause unmeasured; watch it now that worker-tail adds a 1.5s poll per live task.

- **Pinned bottom chrome needs one shared height budget** (2026-09-05, mobile-ux CRITICAL): ramp hint + live tails + proposals + input all rode one `.safeAreaInset(edge: .bottom)` and only proposals self-capped, so two workers + a hint + a proposal could push the thread off an SE screen. Pattern now: one `budget` (42% of height) split between the scrolling panels, fixed rows line-limited, compose field capped at 3 lines when crowded. Also: a `Menu`'s `.accessibilityLabel` overrides its children — badge state must be spoken on the container.
- **Phase 6 got built twice** (2026-09-05 post-mortem): Zettlab session shipped channels + worker-tail on 2026-07-02 to a branch with no PR; the Mac session redid channels on 2026-07-19 without checking `git branch -r`. Zettlab prod then ran a local-only branch (`feat/kimi-agent`) for 7 weeks. Rules: `git fetch --prune && git branch -r && gh pr list` before starting any phase; Zettlab runs `main`, never a feature branch; a phase isn't done until its PR is merged.
- Kept the Mac sidebar channel model (user-created rows in `orchestrator_channels`) over Zettlab's cwd-basename channels — Jeremie's call from Phase 6a. Only the brain's explicit "this channel is the project at X" prompt line was worth taking from the Zettlab version; cwd ordering alone is a weaker hint.
- worker-tail's pane-vanished → `error` path is the herdr "hook-independent liveness" backstop (docs/herdr-teardown.md) at the task level. Session-level liveness is still hooks + ps-discovery.
- `worker-tail` takes `pollMs` in deps so tests run on a 10ms poll against fake pane/task seams — the same DI shape as `COMPANION_DB_PATH` for sqlite. Real timers, no mocks.

- `broadcast()` is `Record<string, unknown>` — no WsMessage union to extend; new `{type:"orchestrator"}` events just work (2026-06-22).
- Worker→thread linkage: cwd is the only signal shared between /dispatch (we pick cwd) and the session-start hook before the session key exists. Bind oldest unbound task for that cwd, then match turn-ends by the bound session key (2026-06-22).
- injectText falls back to macOS frontmost-paste when the target has no tty/tmuxPane — always guard inject on `tmuxPane || tty` (the /api/inject endpoint already does) (2026-06-22).
- A true dispatch e2e can't run on a test port: companion hooks in ~/.claude/settings.json globally target prod :4245, so a spawned worker reports there, not to a test server (2026-06-22).
- keyboard-inject.ts:385 has a pre-existing tsc error on main (string|undefined vs string|null) — not from this work.
- **The real e2e found 3 bugs the simulated-hook test masked** (2026-06-22):
  1. Binding only ran in the session-start hook — but spawned workers often surface via ps-discovery first, so the hook never fired and the task never bound. Fix: reconcile binding off `onSessions` (any registration path).
  2. A tmux-wrapped worker discovered via ps has empty `tmuxPane`, and its client tty has no Terminal tab → AppleScript/tty inject fails ("no tab for tty"). Fix: capture the worker's tmux session name at spawn (Mac Terminal/iTerm paths weren't returning `sessionName` — only Linux was) and deliver via `tmux send-keys -t <session>`.
  3. Inside tmux the worker's pty ≠ the ps-discovered key, so stop-hook reply matching by session key missed. Fix: match by cwd — the only identifier present in every hook payload.
- Send-keys before Claude's TUI renders is silently dropped; ps-discovery sees the process seconds before the input box is ready. Gate the send on a pane-content readiness poll (Welcome/auto-mode/shortcuts markers) (2026-06-22).
- Lesson: simulated-hook tests prove the state machine but hide the real spawn/registration/inject environment. A real-worker e2e is mandatory before declaring dispatch done.
- **Phase 2 brain runs via `claude -p` (Max OAuth, no API key)** — but `claude -p` is a full agent WITH tools, so left unconstrained it DOES the task instead of classifying it. Must pass `--disallowed-tools <work tools>` + `--append-system-prompt` pinning classifier-only behavior. Use only valid tool names (an unknown name prints a warning to stdout that corrupts JSON parsing) and parse the wrapper from the first `{"type"` (2026-06-22).
- Launchd service PATH excludes ~/.local/bin where claude installs — the brain must resolve the claude binary to an absolute path, not rely on `claude` in PATH (2026-06-22).
- **Dispatched workers wedge on project onboarding dialogs** (new-MCP-server enable, folder-trust) that overlay the input box AFTER the welcome/footer renders — so the `auto mode` readiness marker is fooled and the prompt lands on the dialog. Mitigation: detect dialog markers in the pane and send Escape to dismiss before delivering. `ensureFolderTrusted` handles trust pre-seed but not MCP-enable (2026-06-22).
- A proposal is a task in `proposed` state; reconcileDispatch ignores it (only acts on `dispatched`+unbound), so approve must spawn FIRST then `setTaskSpawn` flips it to dispatched+tmux — never bind a worker before we know its tmux session (2026-06-22).
- **Phase 3 model tiers, shaped by `claude -p` reality** (2026-06-23):
  - Each `claude -p` carries a ~11s process-startup floor (no API-key path on Max to avoid it). So the literal 3-tier (Haiku gate → Sonnet chat → Opus compose) would add a whole extra call's latency to chat for marginal gain. Folded gate+chat into ONE Haiku call; only a task escalates to a second (Opus) call.
  - Running brain calls in the project cwd makes claude -p load that project's MCP servers every time (~+5s). Run them in a bare cwd (`~/.claude-companion`, no .mcp.json) instead. Measured: 9s→4s api, 20s→15s wall.
  - Net on prod: chat ~10s (1 Haiku call), task ~22s (Haiku gate + Opus compose). The ~10s floor is inherent to claude -p; true-instant would need API access.
  - The brain's headless `claude -p` sub-sessions trigger the companion's OWN user-prompt hook (they show as `tty=?` user-prompts in the log/feed). Minor noise; could suppress later by tagging brain sessions.
  - Tradeoff: tasks pay a small Haiku gate tax vs Phase 2's single-Opus, but the common case (chat) drops from Opus to Haiku — the right call for an always-on orchestrator where chat dominates.
- **Phase 4 native iOS UI** lives in `~/apps/claude companion/` (separate Xcode project, fully native SwiftUI — NOT the React PWA in claude-companion/client). Integration points: WSFrame.swift (2 new frame cases), CompanionSocket.swift (SocketEvent + emit), AppState.swift (@Published orchestratorTurns/Proposals + apply cases + 4 methods), CompanionClient.swift (4 HTTP methods, withFailover pattern), Models.swift (OrchestratorTurn/Task structs), OrchestratorView.swift (new), ContentView.swift (top-bar button + sheet) (2026-06-23).
  - The socket GROUP's `default:` case forwards unknown SocketEvents unchanged → new event cases auto-propagate. But WSFrame.emit() and AppState.apply() are exhaustive switches (no default) → new enum cases MUST be handled there or it won't compile.
  - SourceKit single-file diagnostics report every cross-file type as "Cannot find type X in scope" (it can't see other files in the module) — these are noise. The real check is `xcodebuild -scheme "claude companion" -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO` — it compiled clean here, so the loop is closable without Xcode/a device.
  - The mobile-ux gate (frontend-mobile.md) applies to native SwiftUI too (STATIC mode). Found + fixed: input bar needs `.safeAreaInset(edge:.bottom)` not fixed padding; bar buttons need 44pt hit area even if visually smaller (`.frame(44).contentShape(Rectangle())`); TextField ≥16pt to avoid iOS auto-zoom; never `focused=true` during sheet entrance animation.
- **Phase 6a channels** (2026-07-19): `thread_id` was designed non-breaking (default `'main'`) so activating it was mostly plumbing the existing param through callers + a one-time `main→general` backfill. The one real bug class: a task's status/worker turns silently defaulted to General because `appendTurn`'s `threadId` defaults — every `orchAppendTurn` carrying a `taskId` must pass `task.threadId`. Test the real sqlite via `COMPANION_DB_PATH` (isolated file), never a mock. Channels are USER-CREATED (not auto-from-cwd) per Jeremie; dispatch falls back to the channel's bound cwd.
- **Phase 6b channels (iOS)** (2026-07-19): keep the flat `orchestratorTurns`/`orchestratorTasks` stores global and filter by `activeChannelId` in computed slices — but `loadOrchestratorThread` must MERGE (upsert by id), not replace, or switching channels drops the other channels' already-loaded history (the thread response only carries the active channel). Menu row selection: use `Toggle`, not `Button`+SF-symbol — the symbol swap is invisible to VoiceOver; Toggle gives the native checkmark + spoken "selected" for free (mobile-ux HIGH). SourceKit still cross-file-blind ("Cannot find type AppState/Theme…") — xcodebuild is the only real check, compiled clean.
