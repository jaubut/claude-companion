# rc → Companion gap table

Phase 12 step 2 (PRJ-OR1T). Companion: this repo @ `main` 491c179. Source for the `rc has` column: [`docs/rc-teardown.md`](./rc-teardown.md) — docs fetched 2026-09-13 plus a live experiment on Claude Code 2.1.270. **No row here is written from recall.**

Discipline is the herdr eval's verdict C: **borrow ideas, don't integrate.** Default is `skip`. A row earns `adopt` only if it closes a gap Jeremie actually hits on the phone.

**Status: UNSIGNED.** Phase 12 closes when the `Jeremie` column is filled, not when parity ships. Put `yes` / `no` / a note in that column; anything left blank stays out of Phase 13+.

## A. Grounded rows — decidable today

| # | Capability | rc has | we have | Recommend | Jeremie |
|---|---|---|---|---|---|
| A1 | Set model without a picker | `/model <id>` as text; refused if unrecognized | screen-scrape: open picker, count rows, arrow, Enter (`dialogs.ts`) | **adopt** — native picker in the app, emits `/model <id>` via `injectText` | |
| A2 | Model scope = this session only | native model control, session-scoped | picker + `s` hint, already reachable via `/api/dialog/key` | **already-ours** — keep the `s` path as the session-only branch behind the same UI | |
| A3 | Model list = real entitlements | device control lists the account's models | `/model` picker parse (Default · Opus 1M · Fable · Sonnet · Haiku) | **already-ours** — parse, never hardcode; A1 only *sets* | |
| A4 | Set effort from the phone | `/effort <level>` as text, session-scoped control | nothing native; dialog mirror only | **adopt, with the fallback** — text form first, dialog mirror when the cached-conversation confirm fires (Finding 3b) | |
| A5 | Guard inject against an open dialog | n/a — rc routes dialogs as dialogs | **bug**: `/api/inject` injects blind; a dialog eats the text (Finding 3c) | **adopt (bug fix, pre-req)** — must land before A1/A4 ship | |
| A6 | Rename a session from the phone | `/rename <name>` as text | session titles exist (`session-titles.ts`), no phone rename | **skip** unless Jeremie wants it — cheap later, low pain today | |
| A7 | `/compact`, `/clear`, `/context`, `/usage` from the phone | all work as text commands | injectable today as raw text, no UI | **skip** — one-line affordance, not a phase | |
| A8 | Diff pane of uncommitted changes, computed locally | yes, on request from the device | nothing | **skip for Phase 12** — real gap, own phase if wanted | |
| A9 | Stop a running subagent / workflow from the device | yes | tasks panel shows work; no stop | **skip for Phase 12** — revisit after the queued iOS reader tasks | |
| A10 | Queue a prompt sent mid-turn | queued, kept in transcript after the turn | inject lands immediately in the pane | **skip** — note it; our send-keys readiness gate already covers the worst case | |
| A11 | Dialog auto-expiry | 5 min default, `dialogExpiry` setting | dialogs stay open forever | **skip** — our dialogs are watched live, expiry adds a failure mode | |
| A12 | Push notifications | Claude decides; two toggles, no per-event config | auto-judge + APNs fan-out, curated interruption | **already-ours, and better** — explicitly do not adopt the relay model | |
| A13 | Session origination from the phone | server mode `--spawn worktree`, needs a per-directory server pre-started, plan-gated | `spawn-session` → tmux worker → dispatch, any host/cwd, self-hosted | **already-ours** — narrower claim than the note had; see teardown §1a | |
| A14 | Transcript location | stored on Anthropic servers; ZDR orgs can't use rc | local sqlite | **already-ours** — this is the durable edge, say it out loud in the README | |

## B. Blocked rows — need the device half of the teardown

Do not fill these from memory of the Claude app. Each needs a real session on a real phone (teardown §4).

| # | Capability | Blocked on |
|---|---|---|
| B1 | Chat composer fidelity (multi-line, markdown, edit/resend, stop) | device item 1 |
| B2 | History depth + pagination in a long thread | device item 2 — also gated by our own `getThread` bug (task `f65d35e7`) |
| B3 | Model/effort controls as UI — is scope visible to the user? | device item 3 |
| B4 | Permission + question card shape on the phone | device item 4 |
| B5 | Attachments from the phone into a session | device item 5 — undocumented, unknown, not "no" |
| B6 | Session list / switching / online-dot latency | device item 6 |
| B7 | What a reconnect looks like in the hand | device item 7 |

## C. Proposed Phase 13+ (falls out of the adopt column — nothing starts until signed)

1. **13 — dialog guard on inject** (A5). Smallest, unblocks the rest, fixes a shipping bug.
2. **14 — native model control** (A1 + A2 + A3): picker-sourced list, `/model <id>` to set, `s`-hint branch for session-only, scope shown in the UI.
3. **15 — effort control** (A4) with the confirm-dialog fallback.

Ordering rule from the note stands: the `getThread` oldest-N-turns fix (`f65d35e7`) lands **before** any of this, because it corrupts the thread surface all of it builds on.
