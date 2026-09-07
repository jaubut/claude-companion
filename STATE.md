# STATE — Claude Companion: Single-Thread Orchestrator (PRJ-OR1T)

Last updated: 2026-09-07

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

## Change Plans

### Change Plan — split-activity (2026-09-07)
**Request:** Split `server/lib/activity.ts` (681 lines: 200-cap event feed, live activity pill, 1.5 s transcript poll, token accounting, assistant-text streaming, the turn-end retry that catches late-flushed closing blocks, and the feed/activity/feed-reset listener sets) into modules under the 600 cap. Every contract unchanged — same export names/signatures for `routes/hooks.ts`, `routes/api.ts`, `wiring/events.ts`, `lib/codex-feed.ts`, `ws.ts`; same `event` / `activity` / `feed_pruned` frames; same feed shapes; same turn-end retry behaviour. Mechanical move, no redesign.
**Done when:**
- archmap shows **no ⚠ under server** (`lib/activity.ts` was the last one); every new module < 600.
- `bun test` 51/51 green; route/WS/stderr smoke diff vs the pre-split baseline is empty.
- Long-answer regression check green: a streamed turn whose closing block flushes *after* Stop still reaches the feed as `assistant_text`.

**State decisions**
- `feed` (200-cap `FeedEvent[]`) + `feedListeners` + `feedResetListeners`: live in **`lib/feed.ts`**. Mutated only by `appendFeedEvent()` (id-dedupe + FEED_CAP splice) and the moved prune block, now `pruneFeedForSession(meta): void` (private to feed.ts, called by `forgetSession`). Announced by `event` (onFeed) / `feed_pruned` (onFeedReset) via `wiring/events.ts`. Persistence: none (in-memory, unchanged).
- `activity` pill + `activityListeners` + `pollTimer`: stay in **`lib/activity.ts`**. Mutated only by private `setActivity()` — called by the 4 recorders, the 1.5 s heartbeat and `forgetSession`. Announced by `activity`. Persistence: none.
- `states` Map (per-transcript `PathState`) + `keyFor` + `getState` (incl. weak-key migration) + `identityFor`: move to **`lib/transcript.ts`** — the state is keyed by transcript path and the delta reader is its main mutator (`lastTokens`, `seenAssistantText`, `streamedThisTurn`). Recorders in activity.ts keep mutating `turnStartedAt` / `toolStarts` / turn resets through the record they get from `getState()`. Two new internal exports, no external consumer: `activeStates()` (poll iteration) and `forgetStates(meta)` (drop on session end). Persistence: none.
- Pure formatters (`summarize`, `verbFor`, `isShellTool`, `extractToolResult`, `stripAnsi`, `clampLong`) move to **`lib/tool-format.ts`** — zero state, only import is `isQuestionTool` from `questions.ts` (which imports nothing → no cycle).
- **No barrel re-export from `activity.ts`.** A façade would be a back-compat shim (global rule). The 5 importers get their import lines rewritten to the new owner; export names and signatures are byte-identical. Archmap fan-in owners change (`summarize()` → `lib/tool-format.ts`, `getFeed()` → `lib/feed.ts`) — expected map churn, not a contract change.

**Contracts touched** (from architecture.md) — no shape changes anywhere
| contract | kind | change | consumers / callers | compat |
|---|---|---|---|---|
| `event` `activity` `feed_pruned` | frame | none — still emitted by `wiring/events.ts`; only the module its `onFeed`/`onFeedReset`/`onActivity` import resolves to changes | client/hooks/use-companion.ts, ios/WSFrame.swift (`event`,`activity`) | identical |
| `* /api/feed`, `* /ws` init | endpoint/frame | none — `getFeed()`/`getActivity()` keep shape (`getFeed` still returns a copy) | routes/api.ts, ws.ts | identical |
| `summarize()` | export | file moves to `lib/tool-format.ts` | lib/codex-feed.ts, wiring/events.ts, routes/hooks.ts#POST /hooks/pre-tool-use, #POST /hooks/permission-request | same signature |
| `getFeed()` `appendFeedEvent()` `onFeed()` `onFeedReset()` + types `FeedEvent` `EventKind` `Verdict` | export | file moves to `lib/feed.ts` | routes/api.ts#* /api/feed, ws.ts, lib/codex-feed.ts, wiring/events.ts, routes/hooks.ts (`Verdict`) | same signatures |
| `getActivity()` `onActivity()` `recordToolStart/End()` `recordUserPrompt()` `recordTurnEnd()` `forgetSession()` + type `Activity` | export | stay in `lib/activity.ts` | routes/api.ts, routes/hooks.ts, ws.ts, wiring/events.ts | unchanged |
| iOS TestFlight build + React client | — | zero code change | — | untouched |

**Files — one owner each** (all builder; sequenced, never two open at once)
| file | change | lines now → after cap check |
|---|---|---|
| `server/lib/tool-format.ts` | NEW, pure moves: `summarize`, `verbFor`, `isShellTool`, `extractToolResult`, `stripAnsi` + `ANSI_PATTERN`, `clampLong` (shared by transcript.ts and activity.ts) | 0 → ~130 ✓ |
| `server/lib/feed.ts` | NEW: `EventKind`/`Verdict`/`FeedEvent` types, `feed`, `FEED_CAP`, `emit`→`appendFeedEvent`, `getFeed`, `onFeed`, `onFeedReset`, `pruneFeedForSession` | 0 → ~100 ✓ |
| `server/lib/transcript.ts` | NEW: `SessionMeta`, `PathState`, `states`, `keyFor`, `getState`, `identityFor`, `activeStates`, `forgetStates`, `readTranscriptDelta` (**keeps `: number` return**), `hashText` | 0 → ~175 ✓ |
| `server/lib/activity.ts` | keeps: `Activity`, pill + `setActivity`/`getActivity`/`onActivity`, `POLL_MS`/`startPoll`/`stopPollIfIdle`, `toolKey`, `activityMatches`, `recordToolStart/End`, `recordUserPrompt`, `recordTurnEnd` (retry verbatim), `forgetSession` | 681 → ~315 ✓ |
| `server/routes/hooks.ts` | import line only: `Verdict`←feed, `summarize`←tool-format, recorders+`forgetSession`←activity | 555 → 557 ✓ |
| `server/routes/api.ts` | import line only: `getFeed`←feed | 316 → 317 ✓ |
| `server/wiring/events.ts` | import line only: `onFeed`/`onFeedReset`/`FeedEvent`←feed, `summarize`←tool-format, `onActivity`←activity | 108 → 110 ✓ |
| `server/lib/codex-feed.ts` | import line only: `appendFeedEvent`/`FeedEvent`←feed, `summarize`←tool-format (no longer imports activity at all) | 354 → 355 ✓ |
| `server/ws.ts` | import line only: `getFeed`←feed, `getActivity`←activity | 132 → 133 ✓ |
| `server/lib/transcript.test.ts` | NEW, last commit, own step: delta returns emitted-count, dedupe by `hashText`, `silent` primes without emitting, token high-water | 0 → ~90 ✓ |

**Move order** (server boots + `bun test` + smoke diff after every step; one commit per step)
1. `lib/tool-format.ts` — pure leaf, no state, no timers. activity.ts imports it back. Update `codex-feed.ts` / `routes/hooks.ts` / `wiring/events.ts` for `summarize`. **After this step activity.ts is ~545 → already under the cap**, so every later step is optional-safe.
2. `lib/feed.ts` — feed store + event types + prune. activity.ts calls `appendFeedEvent` where it called `emit`; `forgetSession` calls `pruneFeedForSession`. Update `ws.ts`, `routes/api.ts`, `wiring/events.ts`, `codex-feed.ts`, `routes/hooks.ts` (`Verdict`). activity.ts → ~420.
3. `lib/transcript.ts` — state map + delta reader. activity.ts imports `getState`, `identityFor`, `activeStates`, `forgetStates`, `readTranscriptDelta`. activity.ts → ~315.
4. Regenerate archmap; confirm server ⚠ list is empty and 19 frames / 30 endpoints / 7 hooks still listed.
5. `lib/transcript.test.ts` (51 → 54). The 51 must be green before this commit lands, so a failure here is provably the new test, never the move.

Dependency direction is a DAG: `tool-format` (leaf) ← `feed` (leaf) ← `transcript` ← `activity`. No module under `lib/` imports `activity.ts` after step 3.

**Fan-in paths to guard**
- `summarize()` — 4 call sites (codex-feed import-time helper, wiring/events push title, `#POST /hooks/pre-tool-use`, `#POST /hooks/permission-request`). Pure; the `isQuestionTool` branch must keep firing first or question rows lose their text.
- `recordToolStart()` — `#POST /hooks/pre-tool-use` + `#POST /hooks/permission-request` fire as a pair for one AskUserQuestion (STATE learning). Today that emits two `tool_start` events (ids are fresh UUIDs, so `emit`'s id-dedupe does not collapse them) and sets the same `toolStarts` key twice. **Keep that exactly** — do not "fix" it into a dedupe during the move.
- `appendFeedEvent()` — codex-feed supplies its own stable ids; the id-dedupe inside `emit` is what makes a re-read of a rollout file idempotent against its `offsets` Map. Must stay inside feed.ts, first line of the function.
- `recordUserPrompt()` — `/api/inject` and `#POST /hooks/user-prompt-submit`. Stays the only turn-boundary reset (`turnStartedAt`, `lastTokens=0`, `toolStarts.clear()`, `seenAssistantText.clear()`, `streamedThisTurn=false`) and the only `silent:true` delta read.
- `getFeed()`/`getActivity()` — `* /api/feed` and WS `init`. Same two keys in the init frame, same order.
- `forgetSession()` — `#POST /hooks/session-end` only, but now fans out to three modules (`forgetStates` → `setActivity(null)` → `pruneFeedForSession` → `stopPollIfIdle`). Order must stay as written: prune fires `feed_pruned` after the pill is cleared.

**Risks**
- **Long-answer regression (the one that matters).** `recordTurnEnd`'s retry depends on `readTranscriptDelta` returning the count of *non-silent* emits and on `s.streamedThisTurn = true` being set **inside** the reader. If the move drops the return type to `void`, or lifts the `streamedThisTurn` flip into activity.ts, the 250 ms × 4 s loop silently no-ops and long closing answers vanish again (memory: companion known bugs, "Long answers never reached phone"). Mitigation: return type is named in the files table, step 5's test pins it, and Verify 5 exercises it end to end.
- Type-only import cycle if `PathState` were left in activity.ts. Mitigation: `PathState`/`SessionMeta` move with the states Map; grep guard in Verify 6.
- Module-eval side effects: none of the three new files may start a timer at import. `pollTimer` stays lazy (first `recordToolStart`/`recordUserPrompt`). Guard: `grep -n "setInterval" server/lib/{feed,transcript,tool-format}.ts` → empty.
- `clampLong` has two callers after the split (transcript `assistant_text`, activity `user_prompt` + `turn_end`) with different caps (64 000 / 16 000 / 64 000). Copy the call sites, not the constant.
- Map blind spot: archmap's `state:` column attributes module-level state per file; after the move re-read the server table and confirm `feed`/`states`/`activity`/`pollTimer` are each listed under exactly one module. If a Set/Map shows under two, that's a duplicated declaration, not an adapter bug.

**Verify**
1. `bun test` → 51 pass / 0 fail / 208 expects / 8 files (baseline today), after every step. After step 5: 54 pass / 9 files.
2. `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^server/'` → only the pre-existing `keyboard-inject.ts:385` error (baseline), nothing new.
3. `wc -l server/lib/*.ts server/routes/*.ts server/wiring/*.ts server/*.ts | sort -n | tail -3` → max < 600; `bun run ~/.claude/tools/archmap/cli.ts . --quiet` → **server section has no ⚠**, and still 19 frames / 30 endpoints / 7 hook routes.
4. Route + WS + stderr smoke, same fixture as the split-companion-server plan (port 4299, scratch `COMPANION_DB_PATH`), captured BEFORE step 1: `/api/feed` (`{feed:[],activity:null}`), `/api/status`, hooks `user-prompt-submit` → `user_prompt` frame, `post-tool-use`, `session-end`; WS `init` key set. `diff before.out after.out` and `diff before.err after.err` empty after every step.
5. **Long-answer regression, scripted (no phone needed):** on the test port, POST `user-prompt-submit` with a `transcript_path` pointing at a scratch JSONL; append one assistant text block, wait ~2 s so the 1.5 s poll emits it (`streamedThisTurn = true`); POST `/hooks/stop` with `finalText` empty and the same transcript path; **then**, ~1 s later, append a second 3 500-char assistant block. `GET /api/feed` within 5 s must contain that block as `kind:"assistant_text"` with full length, and exactly one `turn_end` with no `text`. Run it against `main` first — it must pass before and after.
6. Grep guards: `grep -rn "from \"./activity\"" server/lib` → empty; `grep -rn "let activity\|const feed\b\|const states" server` → one hit each, in the owning module.
7. Real e2e on the Mac after merge: one long tool-heavy turn (≥3 000-char closing answer) in a live session → the closing block lands on the phone; one `/api/inject` prompt → `user_prompt` row; one session close → `feed_pruned` drops only that session's rows.

**Out of scope:** `client/app.tsx` (906) and the iOS over-cap files; any change to the feed cap, poll interval, retry window, dedupe policy or clamp sizes; merging codex-feed's `summarizeCodexTool` with `summarize`; persisting the feed; new route/frame/log lines; the duplicate `tool_start` on the PreToolUse+PermissionRequest pair (documented above, deliberately preserved).

### Change Plan — split-client-app (2026-09-07)
**Request:** Split `client/src/app.tsx` (906 lines: layout, session picker, feed rendering, approval card, tool-call summaries, composer, spawn-session form, sound toggle) into components under the 600 cap. No behaviour or visual change: same WS frames (via `hooks/use-companion.ts`, untouched), same `/api/spawn-session` call, same DOM/classes. Mechanical move, no new deps.
**Done when:**
- every `client/src/**` module < 600 lines; archmap client target shows no ⚠
- `bun run build` (client, = `vite build`) green + `bunx tsc -b` clean; built `dist/` loads through the server's static handler on an isolated port
- className inventory and `dist/index.html` (modulo asset hashes) identical before/after

**State decisions**
- All shared state stays the `useCompanion()` return value, called **exactly once, in `App`**, passed down as props. No context, no second call — the hook opens the `/ws` socket in a mount effect, so a second call = a second WebSocket. Persistence: none (hook-internal `localStorage` untouched).
- `picking` (picker open) stays **lifted in `app.tsx`**: `TargetBar` renders the picker, `Composer`'s input `onFocus` closes it. Passed as `picking` + `onTogglePick`/`onFocusInput`.
- Pushed **down** with their only consumer (nothing else reads them today): `text`/`listening`/`history`/`suggestionsOpen`/`recognitionRef` → `Composer`; `pinned`/`scrollRef` → `TerminalFeed`; `now` → `ActivityPill`; `spawning`/`spawnCwd`/`spawnBusy`/`spawnError` → `SpawnSession` (one level down from `TargetBar`). Reset-on-close behaviour is preserved because the whole `{picking && …}` subtree still unmounts.
- `companion.history` localStorage key + shape unchanged, owner moves to `Composer`.

**Contracts touched** (from architecture.md) — no shape changes anywhere
| contract | kind | change | consumers / callers | compat |
|---|---|---|---|---|
| `sessions` `activity` `event` `feed_pruned` `approval` `resolved` `waiting_input` `inject_error` `init` `pong` | frame | none — `hooks/use-companion.ts` is not edited | client/hooks/use-companion.ts, ios/WSFrame.swift | identical |
| `POST /api/spawn-session` | endpoint | same request/response; **caller file moves** `client/app.tsx` → `client/components/spawn-session.tsx` (map row will change) | server/routes/api.ts, ios/CompanionClient.swift | identical |
| `App` named export at `client/src/app.tsx` | export | must keep name + path — `main.tsx` does `import { App } from "./app"` | client/main.tsx | identical |
| `unlockAudio()` from `lib/alert-sound.ts` | export | fan-out grows: called from `Composer`, `StatusBar`, and `app.tsx` approve/deny | client/lib/alert-sound.ts | additive |

**Files — one owner each** (all builder, sequential; no parallel workstreams — every step edits `app.tsx`)
| file | change | lines now → after cap check |
|---|---|---|
| `client/src/lib/format.ts` | NEW: `hashHue`, `shortKey`, `formatTime`, `formatElapsed`, `formatDuration`, `formatTokens`, `truncate` | 0 → ~50 ✓ |
| `client/src/lib/tool-summary.ts` | NEW: `TOOL_ICONS` + `getToolSummary` (fan-in: ApprovalCard + FeedLine) | 0 → ~45 ✓ |
| `client/src/components/session-badge.tsx` | NEW: `SessionDot` + `SessionBadge` (used by pill, feed, approval) | 0 → ~80 ✓ |
| `client/src/components/activity-pill.tsx` | NEW: `ActivityPill` | 0 → ~50 ✓ |
| `client/src/components/feed-line.tsx` | NEW: `FeedLine` + `VerdictBadge` (the 5 `ev.kind` branches verbatim) | 0 → ~120 ✓ |
| `client/src/components/terminal-feed.tsx` | NEW: `TerminalFeed` (scroll pin + "Latest" + empty state) | 0 → ~65 ✓ |
| `client/src/components/approval-card.tsx` | NEW: `ApprovalCard` | 0 → ~65 ✓ |
| `client/src/components/spawn-session.tsx` | NEW: `DEFAULT_SPAWN_CWDS`, `spawnClaudeSession()`, `SpawnSession` — returns a **fragment** (the "+ New Claude session" button then `{spawning && form}`), same two adjacent siblings in the same parent → identical DOM. Derives `spawnSuggestions` from `sessions` prop | 0 → ~90 ✓ |
| `client/src/components/target-bar.tsx` | NEW: `TargetBar` minus the spawn block; zero hooks after the move, so the `return null` early exit is safe | 0 → ~130 ✓ |
| `client/src/components/composer.tsx` | NEW: `Composer` — history + suggestion chips + speech recognition + input row + send; carries the `declare global { interface Window { SpeechRecognition… } }` block with it | 0 → ~155 ✓ |
| `client/src/components/status-bar.tsx` | NEW: `StatusBar` — connection dot, status word, "N queued", sound toggle (the only settings affordance) | 0 → ~40 ✓ |
| `client/src/app.tsx` | keeps: `useCompanion()` call, `picking`, the inject-error banner (13 lines, stays inline), layout + composition | 906 → ~95 ✓ |
| `client/src/hooks/use-companion.ts` | untouched | 399 ✓ |

**Move order** (build green between every step; imports use the existing `@/` alias from vite.config.ts + tsconfig.app.json)
1. `lib/format.ts` → 2. `lib/tool-summary.ts` → 3. `session-badge` → 4. `activity-pill` → 5. `feed-line` → 6. `terminal-feed` → 7. `approval-card` → 8. `spawn-session` → 9. `target-bar` → 10. `composer` → 11. `status-bar` → 12. final `app.tsx` cleanup (dead imports).
Leaves first, composites after; each step is cut → import back → `bun run build` + `bunx tsc -b`. One commit per step so a visual regression bisects to a single component.

**Fan-in paths to guard**
- `App` is reached only from `client/src/main.tsx` — name and path are frozen.
- `TOOL_ICONS` is reached from `FeedLine` (tool_start) and `ApprovalCard`; `getToolSummary` only from `ApprovalCard`. One owner: `lib/tool-summary.ts` — do not duplicate the icon map.
- `SessionBadge` has three call sites with different affordances (`onClick` present = 44px button, absent = compact span). Keep the prop optional; passing `onClick` unconditionally silently changes ActivityPill/ApprovalCard markup.
- `hashHue`/`shortKey` are reached from `TargetBar`, `SessionDot`, `SessionBadge` — single owner `lib/format.ts`.

**Risks**
- `bun run build` is bare `vite build` — **it does not typecheck**. A broken prop type ships silently. → run `bunx tsc -b` in `client/` at every step, not just at the end.
- Tailwind v4 scans source files; classes now live in new paths. A missed file = missing styles with a green build. → diff the built CSS selector set before/after (verify 3).
- The spawn form's fragment shape is the one place where a wrapper `<div>` would change layout (it sits inside the picker's `space-y-0.5` flow). → assert no extra wrapper element.
- A second server instance on the isolated port shares the real hook/watcher singletons (activity poller, dialog watcher, APNs fan-out). → keep the test window to seconds and kill it; do not run it while a live session is ending.
- No client tests exist — the only regression net is the build + the two diffs below. Accepted for a mechanical move; not a place to also "improve" anything.
- Map blind spot: none found for this change. The archmap react-client adapter does record client `fetch` call sites (it caught `/api/spawn-session`), and `use-companion.ts` uses WS only — the `calls:` gap on it is correct, not a miss.

**Verify**
1. Baseline before touching anything: `cd client && bun run build && cp -R dist /tmp/dist-before` → note the `assets/*.js|css` names.
2. After each step: `cd client && bun run build && bunx tsc -b` → both exit 0.
3. Final CSS/class proof: `grep -ohE 'className=(\"[^\"]*\"|\{`[^`]*`\})' <old app.tsx from git> | sort -u` vs the same over `src/app.tsx src/components/*.tsx` → empty diff; and sorted CSS selectors of `/tmp/dist-before/assets/*.css` vs the new one → empty diff.
4. Served-bundle load on an isolated port: `bun -e 'const m = await import("/Users/jeremieaubut/claude-companion/server/companion-server.ts"); m.createCompanionServer(4299)'` then `curl -s localhost:4299/ -o /tmp/index-after.html` → 200 HTML; `diff /tmp/dist-before/index.html /tmp/index-after.html` differs only in asset hashes; `curl -sI localhost:4299/assets/<new-hash>.js` → 200 + `Cache-Control: public, max-age=31536000, immutable`; `curl -s localhost:4299/nope` → SPA fallback HTML. Kill the process.
5. `bun test` at repo root still 50/50 (server untouched — regression guard only).
6. `bun run ~/.claude/tools/archmap/cli.ts . --quiet` → client target lists 13 modules, no ⚠, and `/api/spawn-session` now shows `client/components/spawn-session.tsx` as caller.

**Out of scope:** `hooks/use-companion.ts` (not edited, not split), any frame/endpoint shape change, the iOS app, `server/lib/activity.ts` (681, pre-existing ⚠), adding client tests, any styling/UX/mobile change, new deps, PWA/manifest/service-worker work.

### Change Plan — split-companion-server (2026-09-07) — ✅ shipped (branch refactor/split-companion-server, 10 commits)
**Request:** Split `server/companion-server.ts` (1714 lines: all HTTP routes, hook endpoints, WS upgrade/init/message, orchestrator wiring, dialog-mirror wiring) into route/wiring modules, no server file over 600 lines, every contract unchanged (WS frame names/shapes, endpoints + methods, hook responses, auth gate, log lines). iOS TestFlight build 4 + React client untouched. Mechanical move — the only dedupe is the AskUserQuestion fast path shared by PreToolUse and PermissionRequest.
**Done when:**
- every `server/**/*.ts` < 600 lines except pre-existing `lib/activity.ts` (681, out of scope); archmap shows only that ⚠ under server
- `bun test` 50/50; before/after route + WS + stderr smoke diff empty; 3 real e2e green (Zettlab dispatch, phone AskUserQuestion, /model mirror)

**State decisions**
- `clients` Set, `broadcast()`, `HOST_INFO`, `WsData`: live in `server/state.ts` (new; imports nothing from server/ → no cycles). `clients` mutated only by `ws.ts` open/close.
- `waitingForInput/waitingCwd/waitingKey`: `server/state.ts`, module `let`s behind `getWaiting()`, `setWaiting(cwd, key)`, `clearWaiting()`. Setters are forced, not a redesign — an imported `let` is read-only. Setters only assign; the `broadcast({type:"waiting_input", waiting:false})` line stays verbatim at its 3 sites (pre-tool-use guarded by `if (getWaiting().active)`, `/api/inject`, WS `input`); the stop hook keeps its richer `waiting_input` frame + push inline. Persistence: none.
- Sharing = **module imports, not a context object**: every side effect runs at import time today (listeners, `dialogWatcher.start()`, queue tick, `workerTail.resumeAll`, boot drain) before `createCompanionServer()` is called; a ctx object would force factories = redesign. Libs already are module singletons (sessions.ts, questions.ts, pty-manager.ts).
- One `dialogWatcher` instance in `wiring/dialogs.ts` (3 consumers: routes/dialogs, `/api/status`, WS `init`). One `onSessions` listener in `wiring/events.ts` doing `sessions` frame THEN `reconcileDispatch` — two listeners could reorder `sessions` vs `orchestrator_task`.

**Contracts touched** (from architecture.md) — no shape changes; only the emitting/handling file moves
| contract | kind | change | consumers / callers | compat |
|---|---|---|---|---|
| `approval` `question` `resolved`(expired) `event` `feed_pruned` `activity` `sessions` | frame | emitter → `wiring/events.ts` | client/hooks/use-companion.ts, ios/WSFrame.swift | identical |
| `orchestrator` `orchestrator_task` `orchestrator_channel` `orchestrator_worker_output` / `dialog` `dialog_closed` | frame | emitter → `wiring/orchestrator.ts` / `wiring/dialogs.ts` | ios/WSFrame.swift | identical |
| `init` `pong` `inject_error` + `resolved` `waiting_input` `user_prompt` `super_auto` | frame | emitter → `ws.ts` / `routes/hooks.ts` / `routes/api.ts` | client/hooks/use-companion.ts, ios/WSFrame.swift, ios/AppState.swift | identical |
| 7 `POST /hooks/*` | hook endpoint | handler → `routes/hooks.ts`; `hookDecisionResponse` (incl. Codex empty-body branch) moves verbatim | Claude Code / Codex hook scripts | identical |
| 21 `/api/*` + `/api/status` `/api/feed` / 8 `/api/orchestrator/*` / `/api/dialog/{key,pick}` | endpoint | handler → `routes/api.ts` / `routes/orchestrator.ts` / `routes/dialogs.ts` | client/app.tsx (`/api/spawn-session`), ios/CompanionClient.swift | identical |
| auth gate, `/health`, `/ws` upgrade, static + SPA | — | stay in `companion-server.ts` (gate runs before any route module; `import.meta.dir/../client/dist` only resolves from `server/`) | all | identical |

**Files — one owner each** (all builder; cli.ts untouched — `createCompanionServer` name/signature kept)
| file | change | lines now → after cap check |
|---|---|---|
| `server/state.ts` | NEW: `WsData`, `clients`, `broadcast`, `HOST_INFO`, waiting `let`s + `getWaiting/setWaiting/clearWaiting` | 0 → ~55 ✓ |
| `server/lib/hook-common.ts` | NEW, pure moves: `agentFromHeaders`, `agentTitle`, `cwdFromPayload`, `hookDecisionResponse`, `projectLabelFor`, `subtitleFor` (fan-in: routes/hooks + wiring/events) | 0 → ~80 ✓ |
| `server/lib/tmux-pane.ts` | NEW, moves: `capturePane`, `paneInputReady`, `paneHasDialog` (fan-in: wiring/dialogs + wiring/orchestrator) | 0 → ~30 ✓ |
| `server/wiring/dialogs.ts` | `readSessionStatus`, `dialogWatcher = createDialogWatcher({listSessions, capturePane, getPendingQuestions, broadcast, setSessionStatus})` + `.start()`; exports `dialogWatcher` | 0 → ~45 ✓ |
| `server/wiring/orchestrator.ts` | `orchEmit`, `emitTask`, `emitChannel`, `WIP_CAP`, `workerQueue` (+30 s tick), `workerTail` (+`resumeAll`, boot drain), `sendToTmux`, `reconcileDispatch`, `candidateCwds`, `executeDispatch`, `runBrain`. Exports orchEmit/emitTask/emitChannel/WIP_CAP/workerQueue/runBrain/reconcileDispatch. Needs `broadcast`, tmux-pane, orchestrator-chat/-brain/-queue, worker-tail, spawn-session, listSessions | 0 → ~240 ✓ |
| `server/wiring/events.ts` | lib-event → frame/push bridge: `onApprovalRequest/Expired`, `onQuestionRequest/Expired`, `onFeed`, `onFeedReset`, `onActivity`, `onSessions` (+`reconcileDispatch`), `setTitleResolver`. Needs state, hook-common labels, wiring/orchestrator, pty-manager, questions, activity, sessions, session-titles, apns, push | 0 → ~110 ✓ |
| `server/routes/hooks.ts` | `handleHookRoute(req, url): Promise<Response \| null>`: 7 hooks + `driveAnswer`, `questionInjectTarget`, `hasQuestionInjectTarget`, `readAssistantAfterLastUser`, `extractLastAssistantMessage`, NEW private `questionFastPath`. Needs state (waiting setters, broadcast), hook-common, wiring/orchestrator (emitTask, orchEmit, workerQueue), libs | 0 → ~540 ✓ (relief valve if Phase 8 worker-identity headers push it over: move the 2 transcript readers to `lib/transcript.ts`) |
| `server/routes/api.ts` | `handleApiRoute`: resolve, answer, register-token ×2, push/{tokens,test,broadcast}, inject, learned ×3, super-auto ×2, spawn-session, status, feed. Needs state (`clients.size`, getWaiting, clearWaiting, broadcast, HOST_INFO), `dialogWatcher.current()`, libs | 0 → ~330 ✓ |
| `server/routes/orchestrator.ts` | `handleOrchestratorRoute`: channels GET/POST, channels/<id>/auto, thread, send, dispatch, task/<id>/cancel, proposal/<id>/{approve,reject}; private `resolveChannel`. Needs wiring/orchestrator exports, orchestrator-chat | 0 → ~170 ✓ |
| `server/routes/dialogs.ts` | `handleDialogRoute`: dialog/key, dialog/pick. Needs `dialogWatcher`, resolveSession, pickKeys | 0 → ~65 ✓ |
| `server/ws.ts` | exported `websocket` handlers: open (replay pending + `init`), message (approve/deny/answer/input/ping), close. Needs state, `dialogWatcher`, pty-manager, questions, activity, sessions, super-auto, keyboard-inject | 0 → ~145 ✓ |
| `server/companion-server.ts` | keeps `createCompanionServer`: auth gate, `/health`, `/ws`, then `for (h of [handleHookRoute, handleApiRoute, handleOrchestratorRoute, handleDialogRoute])` first non-null wins, then static/SPA. Ordered side-effect imports: state → wiring/dialogs → wiring/orchestrator → wiring/events → routes → ws | 1714 → ~95 ✓ |

**Move order** (server boots + `bun test` + smoke diff after every step; one commit per step)
1. `state.ts` — extract clients/broadcast/HOST_INFO/waiting; replace the 3 clear blocks with `clearWaiting()` and stop's with `setWaiting(cwd, key)`.
2. `lib/hook-common.ts` + `lib/tmux-pane.ts` — pure moves.
3. `wiring/dialogs.ts` → `wiring/orchestrator.ts` → `wiring/events.ts` (events imports reconcileDispatch, so orchestrator first).
4. `routes/orchestrator.ts` → `routes/dialogs.ts` → `routes/api.ts` → `routes/hooks.ts` (largest, last; the `questionFastPath` dedupe is its own commit inside this step).
5. `ws.ts`; companion-server.ts is now the ~95-line host. Regenerate archmap.

**Shared helper (the one dedupe):** `questionFastPath({ agent, eventName, tool, input, sessionId, cwd, tty, session, headerMeta }): Promise<Response | null>` in `routes/hooks.ts`. Body = today's PreToolUse block verbatim; `eventName` feeds `hookDecisionResponse` and the `question already answered — allow (<eventName>)` log suffix; returns null after the `question fallback` log line so the caller continues to its generic approval path. Callers: `POST /hooks/pre-tool-use` (after the waiting-input reset) and `POST /hooks/permission-request` (right after `recordSession`). `wasQuestionAnswered(dedupeKey)` stays the first check inside — idempotency across the PreToolUse+PermissionRequest pair (STATE learning). NOT deduped: the two generic approval paths (super-auto + branch-guard exist only in PreToolUse; `← phone` vs `← permission` log suffixes differ).

**Fan-in paths to guard**
- `recordSession()` (6 hooks + discover + rehydrate) fires `onSessions` → exactly one listener: `sessions` frame, then `reconcileDispatch` (bind → `emitTask` → `sendToTmux`); idempotent via `matchUnboundTaskByCwd`.
- `setTaskStatus()`/`getTask()` from stop hook, orchestrator routes, wiring — every flip is followed by `emitTask()`; all three import the one `emitTask` from wiring/orchestrator.
- `resolveApproval()`/`resolveQuestion()` from HTTP (`routes/api.ts`) and WS (`ws.ts`) — both keep broadcasting `resolved`; HTTP validates + returns `{ok}`, WS is fire-and-forget.
- `injectText()` + `recordUserPrompt()` — `/api/inject` records `user_prompt` on success (issue #8), WS `input` does not. Keep the asymmetry.
- `workerQueue.drain()` from stop hook, cancel route, `setTaskDead`, boot, 30 s tick — re-entrancy lives inside the queue; callers stay `void drain()`.
- `dialogWatcher`: `/api/dialog/*` call `.refresh(key)` at +350 ms; `/api/status` and `init` read `.current()`.

**Risks**
- Cross-module `let` assignment → tsc error (good); `grep -rn "let waiting" server` must hit state.ts only.
- Import cycle → forbid: nothing under `lib/`, `wiring/`, `state.ts` imports `companion-server.ts`, `ws.ts`, or `routes/*` (grep guard in Verify).
- Module-eval order shifts (listeners now register after `dialogWatcher.start()` + boot drain). Safe: every emitter is async (2 s poll, timers, promises) and cannot fire during synchronous import — confirm boot-log line order on the test port.
- Route order: hooks → api → orchestrator → dialogs. All matches are exact path(+method) or disjoint prefixes; the prefix pairs (`/api/learned` vs `/api/learned/`, `channels` vs `channels/`) stay inside one module in today's order; `/api/status`, `/api/feed` keep matching any method.
- Map blind spot: archmap attributes frames/routes by literal `broadcast({type})` / `url.pathname` per file — after the split confirm 19 frames + 30 endpoints + 7 hooks still listed; if not, it's an adapter bug to file, never a code change.
- Log lines: every `process.stderr.write` and per-handler ANSI const block moves verbatim (consolidating colors = redesign); stderr diff proves it.

**Verify**
1. `bun test` → 50 pass / 0 fail (baseline 2026-09-07: 50 pass, 204 expects, 8 files).
2. `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E '^server/|^cli\.ts'` → empty (baseline today: empty; `client/` errors pre-existing, unrelated).
3. `wc -l server/*.ts server/routes/*.ts server/wiring/*.ts server/lib/*.ts | sort -n | tail -3` → only `lib/activity.ts` ≥ 600; `bun run ~/.claude/tools/archmap/cli.ts . --quiet` → server ⚠ = activity.ts only.
4. Route smoke diff — BEFORE step 1: `COMPANION_PORT=4299 COMPANION_DB_PATH=<scratch>/smoke.db bun cli.ts 2><scratch>/before.err`, fixed curl set → `before.out`: `/health`; `/api/status` no token → 401, with token → 200 (keys pending/clients/waitingForInput/waitingCwd/waitingKey/sessions/dialogs/host); `/api/feed`; `GET /api/learned`; `GET /api/super-auto`; `GET /api/orchestrator/channels` + `/thread`; 400s: `POST /api/resolve {}`, `/api/answer {}`, `/api/inject {}`, `/api/spawn-session {}`, `/api/orchestrator/send {}`, `/api/push/broadcast {}`; 404s: `/api/dialog/key {}`, `/api/dialog/pick {}`, `/api/orchestrator/proposal/x/approve`, `/api/orchestrator/task/x/cancel`; hooks `post-tool-use`, `session-start`, `session-end`, `user-prompt-submit` synthetic → `{}`/`{ok:true}`; `pre-tool-use` with super-auto ON + tool Read → `hookSpecificOutput.permissionDecision:"allow"`, same with `x-companion-agent: codex` → empty body; `/nope` → SPA index. After every move step: rerun, `diff before.out after.out` and `diff before.err after.err` (boot banner stripped) both empty.
5. WS smoke (`bun -e`, `ws://127.0.0.1:4299/ws?token=…`): `init` key set == {type,pending,waitingForInput,waitingCwd,waitingKey,activity,feed,sessions,superAuto,dialogs,host}; `ping`→`pong`; `input` key "nope" → `inject_error target_gone`; `POST /hooks/user-prompt-submit` → `user_prompt` frame {text,key,cwd,sessionId}.
6. Grep guards: `grep -rn "companion-server\|from \"\.\./ws\"\|from \"\.\./routes/" server/lib server/wiring server/state.ts` → empty.
7. Real e2e after PR merge with Zettlab on `main` (STATE rule): (a) `POST /api/orchestrator/dispatch` → `orchestrator_task` dispatched→running→done with `logTail`, worker reply in thread; (b) AskUserQuestion from the phone → one card, `question already answered — allow (PermissionRequest)` on the duplicate, `picker driven`, transcript "User answered"; (c) `/model` in a tmux session → `dialog` frame, `/api/dialog/pick` → `dialog_closed`. Mac: PermissionRequest-only question path.
8. iOS build 4 + React client: zero code change; steps 4/5/7 are the proof.

**Out of scope:** `lib/activity.ts` (681), `client/app.tsx` (906), iOS over-cap files; unifying `capturePane` with keyboard-inject.ts's private tmux capture (l.503) or `readSessionStatus` with discover.ts's session-file reader; ANSI const consolidation; new test files (route tests need the one-sqlite-module-per-test-file rule — separate task); any frame/route/log change; deploy units (entry `bun cli.ts` unchanged).

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

- **First `/change` run (2026-09-07):** the split shipped as 10 commits, `bun test` 50/50 + server tsc + a fixed route/WS/stderr smoke diffed against the pre-split baseline after every one. Both cross-module contract checks that the plan named paid off: the mechanical route extractor moved a section's *neighbours* along with it when an earlier extraction had removed the marker between them, so three chain calls ended up nested inside other route modules — every behavioural check stayed green (identical responses) and only the **import-boundary guard** ("no module imports routes or the host") exposed it. That is the boundary lint's job; wire it into CI (PRJ-LGDV Phase 4).
- Layout after the split: `state.ts` (clients, broadcast, host, waiting flag) · `lib/hook-common.ts` + `lib/tmux-pane.ts` (shared helpers) · `wiring/{orchestrator,dialogs,events}.ts` (singletons + listeners, side effects at import) · `routes/{hooks,api,orchestrator,dialogs}.ts` (each returns null for other paths) · `ws.ts` · host = auth gate, health, upgrade, route chain, static. Add a route to the matching `routes/` file, never to the host; new always-on state goes in `wiring/`.
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
