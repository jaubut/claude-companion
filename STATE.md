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
- [ ] Phase 1: real-worker e2e (manual phone-spawn against prod :4245) — global hooks target prod port, can't e2e on a test port
- [ ] Phase 2: propose-confirm dispatch (orchestrator proposes worker+context, one-tap approve)
- [ ] Phase 3: model tiers (Haiku gate / Opus compose / Sonnet inline chat)
- [ ] UI phase (mobile-ux-gated): orchestrator thread in the session picker + chat surface

## Learnings

- `broadcast()` is `Record<string, unknown>` — no WsMessage union to extend; new `{type:"orchestrator"}` events just work (2026-06-22).
- Worker→thread linkage: cwd is the only signal shared between /dispatch (we pick cwd) and the session-start hook before the session key exists. Bind oldest unbound task for that cwd, then match turn-ends by the bound session key (2026-06-22).
- injectText falls back to macOS frontmost-paste when the target has no tty/tmuxPane — always guard inject on `tmuxPane || tty` (the /api/inject endpoint already does) (2026-06-22).
- A true dispatch e2e can't run on a test port: companion hooks in ~/.claude/settings.json globally target prod :4245, so a spawned worker reports there, not to a test server (2026-06-22).
- keyboard-inject.ts:385 has a pre-existing tsc error on main (string|undefined vs string|null) — not from this work.
