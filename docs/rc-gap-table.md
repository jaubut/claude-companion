# rc → Companion gap table

Phase 12 step 2 (PRJ-OR1T). Companion: this repo @ `main` 491c179. Source for the `rc has` column: [`docs/rc-teardown.md`](./rc-teardown.md) — docs fetched 2026-09-13 plus a live experiment on Claude Code 2.1.270. **No row here is written from recall.**

**Status: SIGNED 2026-09-13 — ADOPT ALL.** Phase 12 is closed.

The goal Jeremie set, in his words: *"I want the same experience as on claude.ai rc."* That overrides the drafting default. This table was first written with the herdr eval's verdict C (borrow ideas, don't integrate) and a `skip` default, scoped to "close the pain we have actually hit". That is the wrong test for a parity goal, so every row is now `adopt`, and the two the author argued against are adopted too — **behind a toggle, default off**, which is what makes his "we'll reverse it if it turns out unnecessary" actually cheap. Reversing a toggle is a switch; reversing a behaviour change is a revert.

Read `adopt` two ways, and the Build column says which:
- **build** — it does not exist here yet.
- **surface** — the capability already exists server-side; adopting it means exposing it in the app, not rebuilding it.

The one thing parity still can't be scoped from: **table B is still unknown.** Composer fidelity, history depth, attachments, session switching and reconnect are where most of the felt difference between Companion and rc lives, and none of it is written here because none of it has been seen on a real device. A device-half pass reorders everything below it.

## A. Grounded rows — decidable today

| # | Capability | rc has | we have | Build | Signed |
|---|---|---|---|---|---|
| A1 | Set model without a picker | `/model <id>` as text; refused if unrecognized | screen-scrape: open picker, count rows, arrow, Enter (`dialogs.ts`) | build — native picker emitting `/model <id>` via `injectText` | **adopt** |
| A2 | Model scope = this session only | native model control, session-scoped | picker + `s` hint, reachable via `/api/dialog/key` | surface — the `s` branch behind the same UI, with the scope shown | **adopt** |
| A3 | Model list = real entitlements | device control lists the account's models | `/model` picker parse (Default · Opus 1M · Fable · Sonnet · Haiku) | surface — parse, never hardcode; A1 only *sets* | **adopt** |
| A4 | Set effort from the phone | `/effort <level>` as text, session-scoped control | nothing native; dialog mirror only | build — text form first, dialog mirror when the cached-conversation confirm fires (Finding 3b) | **adopt** |
| A5 | Guard inject against an open dialog | n/a — rc routes dialogs as dialogs | shipped 2026-09-13 | — | ✅ **done** (#26, both hosts) |
| A6 | Rename a session from the phone | `/rename <name>` as text | session titles exist (`session-titles.ts`), no phone rename | build — small; rename round-trips to the local title | **adopt** |
| A7 | `/compact`, `/clear`, `/context`, `/usage` from the phone | all work as text commands | injectable today as raw text, no UI | surface — a command affordance, one PR with A6 | **adopt** |
| A8 | Diff pane of uncommitted changes, computed locally | yes, on request from the device | nothing | build — device asks, host computes, app renders. Biggest item here | **adopt** |
| A9 | Stop a running subagent / workflow from the device | yes | we stop our *dispatched workers*; not subagents inside a session | build — genuine gap, distinct from the tasks panel | **adopt** |
| A10 | Queue a prompt sent mid-turn | queued, kept in transcript after the turn | inject lands in the pane; Claude Code queues typed input during a turn | verify — likely already ours. One test decides whether it is a phase at all | **adopt** |
| A11 | Dialog auto-expiry | 5 min default, then answers with the dialog's no-action default (`dialogExpiry`) | dialogs stay open, and inject now refuses while one is up (A5) | build **behind a setting, default off** | **adopt (toggle)** |
| A12 | Push notifications | Claude decides; two toggles, no per-event config | auto-judge + APNs fan-out, curated interruption | build **as a mode toggle** — curated (default) vs relay | **adopt (toggle)** |
| A13 | Session origination from the phone | server mode `--spawn worktree`, needs a per-directory server pre-started, plan-gated | `spawn-session` → tmux worker → dispatch, any host/cwd, self-hosted | surface — already ahead; say so in the UI | **adopt** |
| A14 | Transcript location | stored on Anthropic servers; ZDR orgs can't use rc | local sqlite | surface — the durable edge, say it out loud in the README | **adopt** |

**The two toggles, and why they are toggles.** Both were argued against before signing, and the argument is kept here so a future reader knows the tradeoff was seen rather than missed:

- **A11** — rc expires a forwarded dialog because the host may be unattended. Ours is watched live, and since A5 an inject refuses while a dialog is open rather than answering it. Turning expiry on means a dialog on your own machine can answer itself with a default you never chose. Default off; turn it on only if an unattended host becomes a real shape.
- **A12** — rc pushes whenever Claude decides. The auto-judge exists precisely to not do that. Relay mode is there for parity and for judging the difference side by side; curated stays the default.

## B. The device half — PARTIALLY ANSWERED 2026-09-13, from real use

Build 5 landed on Jeremie's phone and he used it. That is the device half starting to report, and it did not report what this table expected. Verbatim: *"im seeing the model switcher but the interactive /command doesnt work, its not a floating chat bar, the voice command doesnt work, etc. its not like claude.ai app."*

Model control (A1–A3) **works on the phone** — first confirmation from a device. Everything else he reached for was the composer, and the composer is where the gap actually lives:

| # | Reported | Reality in the code | Status |
|---|---|---|---|
| B1a | voice command doesn't work | the mic button was a **stub** — `// v2: SFSpeechRecognizer`, empty action, shipped since build 1. A control that looked real and did nothing | **fixed, build 6** — real `SFSpeechRecognizer` dictation, on-device where supported, live partials |
| B1b | not a floating chat bar | composer was a full-width slab welded to the bottom edge | **fixed, build 6** — inset floating bar |
| B1c | interactive `/command` doesn't work | no slash UI at all. Typing `/model` injects the literal text; the terminal runs it, but there is no command list, no autocomplete, no picker | **built, Phase 16** — server #31, iOS to follow. Typing `/` queries Claude Code's own menu and lists what it matches |

**This reordered the table, and the work followed.** The signed order had 15 (effort) → 16 (commands) with composer work nowhere, because nobody had used the app. One session with it said the composer outranks all of it, so the composer went first: dictation and the floating bar in build 6, `/command` autocomplete as Phase 16 immediately after — ahead of effort control, which is still unbuilt.

The command list is read exactly the way the model list is: Claude Code does the filtering and we mirror it (server PR #31). One thing the build discovered that this table had assumed wrong — **Claude Code's command matching is fuzzy and ranked, not prefix-only.** `/eff` returns `/effort`, then `/caveman:caveman`, then `/marketing-psychology`. The phone passes that ranking through untouched rather than re-sorting it.

**Still unasked, and still not to be written from memory:**

| # | Capability | Blocked on |
|---|---|---|
| B2 | History depth + pagination in a long thread | device item 2 — also gated by our own `getThread` bug (task `f65d35e7`) |
| B3 | Model/effort controls as UI — is scope visible to the user? | device item 3 |
| B4 | Permission + question card shape on the phone | device item 4 |
| B5 | Attachments from the phone into a session | device item 5 — undocumented, unknown, not "no" |
| B6 | Session list / switching / online-dot latency | device item 6 |
| B7 | What a reconnect looks like in the hand | device item 7 |

## C. Phase order

Value first, cost second, and everything below the line reorders once table B is known.

| Phase | Rows | Note |
|---|---|---|
| 13 ✅ | A5 | dialog guard — shipped #26, both hosts, prod-verified |
| 14 | A1 · A2 · A3 | model control. Proven reachable; scope (session vs default) must be visible in the UI |
| 15 | A4 | effort control, with the confirm-dialog fallback |
| 16 | A6 · A7 | command surface — rename, compact, clear, context, usage. One PR |
| 17 | A10 | one test. If inject already queues mid-turn this closes without a phase |
| 18 | A13 · A14 | surface what is already ahead (origination, local transcript) — copy, not code |
| 19 | A9 | stop a subagent / workflow from the device |
| 20 | A8 | diff pane. Biggest build in the table |
| 21 | A11 · A12 | the two toggles, default off |

**The PWA is retired (Jeremie, 2026-09-13): "PWA is not used anymore."** Every row's client half means the **iOS app only**. `client/` still builds and ships with the server — nothing here removes it — but no phase below plans work in it, and a row is done when iOS has it. The Phase 14 split was 14a server / 14b PWA / 14c iOS; **14b is dropped**, not deferred.

Two ordering rules stand:
1. The `getThread` oldest-N-turns fix (task `f65d35e7`) lands **before** phase 14 — it corrupts the thread surface every phase above builds on.
2. **The device half (table B) should run before phase 14, not after.** It is the cheapest thing on this page and it is the only input that can reorder the rest. Composer and history gaps, if they are real, outrank model control.
