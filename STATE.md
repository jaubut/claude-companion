# STATE — Claude Companion: Single-Thread Orchestrator (PRJ-OR1T)

Last updated: 2026-06-22

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

## Progress

- [x] Phase 0: memory-proof gate (kb-memory-proof suite, 5/5) — 2026-06-22
- [x] Phase 1: orchestrator-chat.ts (SQLite thread + tasks) — 2026-06-22
- [x] Phase 1: endpoints /api/orchestrator/{send,dispatch,thread} (Bearer) — 2026-06-22
- [x] Phase 1: worker bind on session-start + reply capture on stop, tagged by task — 2026-06-22
- [x] Phase 1: verified — send/thread/auth + dispatch state machine via simulated hooks; persistence across restart
- [x] Phase 1: real-worker e2e GREEN — dispatch spawns a real Claude worker, prompt delivered, reply lands tagged in 15s, fully automated (2026-06-22, after dispatch-delivery fix)
- [x] Phase 2: propose-confirm dispatch — brain (claude -p, tools disabled) classifies chat vs task; task → proposal with reasoning; approve → spawn+deliver; reject → drop. Real e2e green, fully automated (2026-06-22)
- [x] Phase 3: model tiers — Haiku gates+chats in one cheap call; Opus composes only on a task. Brain runs in a bare cwd (no project MCP). chat ~10s, task ~22s on prod (2026-06-23)
- [x] Phase 4: native iOS UI — OrchestratorView (thread + proposal cards + input) in the SwiftUI app, reachable from the top-bar sparkles button. Compiles (BUILD SUCCEEDED via xcodebuild), mobile-ux-auditor pass + fixes applied (2026-06-23)

## Learnings

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
