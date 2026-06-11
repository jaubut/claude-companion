# herdr vs Claude Companion — Teardown

Date: 2026-05-31. herdr: https://herdr.dev · `ogulcancelik/herdr` (Rust, OSS). Companion: this repo.

> Accuracy note: two earlier drafts guessed Companion's internals wrong — first a non-existent `detect.ts`, then a non-existent "5-state machine". This version is corrected against actually-read source: `server/lib/activity.ts` (full, 661 lines), `server/lib/auto-judge.ts` (full), `server/lib/` file inventory, README. Files NOT read are flagged at the bottom — don't treat claims about them as verified.

## TL;DR

They are built for **different primary jobs**, so this isn't replace-vs-keep:
- **Companion** = single-session **watch + approve + push** loop, phone-first.
- **herdr** = desktop **fleet multiplexer** — many agents in panes, each with an idle/working/blocked/done badge, plus a socket API so agents self-orchestrate.

Companion has no fleet-rollup view (it surfaces ONE live pill at a time); herdr has no push/native/approval layer. Verdict: **cherry-pick 1–2 herdr ideas, don't adopt the binary.**

## What Companion's activity layer actually is (`activity.ts`, read in full)

NOT a lifecycle state machine. It's:
- An **event feed** (200-cap, `tool_start`/`tool_end`/`user_prompt`/`assistant_text`/`turn_end`), tagged per session by transcript-path → tty → sessionId → cwd, so concurrent sessions don't trample each other.
- **One live "activity pill"** at a time — "the most recently active session" — e.g. `Editing foo.ts · 12s · 4.2k tokens`, kept alive by a **1.5s poll of the transcript file** (hooks say *when*, transcript says *what*).
- Token accounting + assistant-text streaming pulled from the transcript JSONL.
- A separate **approval `Verdict`** enum (`auto-allow`/`auto-deny`/`approved`/`denied`/`pending`) — this is Companion's "state," and it's about tool approval, not agent lifecycle.

Detection trigger = **Claude Code hooks + transcript polling**. It does NOT inspect the OS process or scrape terminal output for liveness. (Other modules — `pty-manager.ts`, `spawn-session.ts`, `discover.ts`, `keyboard-inject.ts` — exist but were not read; they handle session spawn/discover/inject, not the activity feed.)

## What herdr is

Mouse-native multiplexer (panes/tabs/workspaces), a **4-state rollup per pane/tab/workspace** (🟢idle/🟡working/🔴blocked/🔵done) for glancing at a *fleet*, state from **process + terminal-output inspection + optional semantic hooks**, a newline-JSON **socket API** (`workspace/pane create`, `pane run/read`, `wait agent-status`, `pane report-agent --state/--custom-status`) so agents drive their own panes. Remote over SSH; **mobile = SSH TUI, no push, no native app**.

## Head-to-head (corrected, claims scoped to what was read)

| Axis | Companion | herdr | Edge |
|---|---|---|---|
| Primary job | single-session watch/approve/push | multi-agent fleet multiplexer | different jobs |
| Fleet glance ("5 agents: 2 working, 1 blocked") | ✗ — one pill at a time + event feed | ✓ per-pane 4-state rollup | **herdr** |
| Single-session richness | ✓ event feed, token/cost, streamed text, approvals | basic per-pane badge | **Companion** |
| Detection trigger | hooks + transcript poll (no process/output inspection in activity.ts) | process + output inspection (hook-independent) | **herdr** (robust to unfired hooks) |
| What-Claude-did fidelity | high (reads transcript JSONL) | output heuristics | **Companion** |
| Mobile glance | native iOS + **APNs (app-killed)** + Live Activity + menubar | SSH TUI only | **Companion (decisive)** |
| Phone→terminal steer | `keyboard-inject.ts` + auto-responder | SSH in, type | **Companion** |
| Approval engine | 4-layer auto-judge + learned-allow + branch-guard | none | **Companion** |
| Agent self-orchestration | ✗ | socket API to spawn panes / wait-state | **herdr** |
| Agent breadth | Claude + Codex | Claude/Codex/Pi/OpenCode/Qoder | **herdr** |
| Maturity / fit-to-you | yours, daily use | early OSS, API may churn | **Companion** |

## The two herdr ideas genuinely worth stealing

1. **Multi-agent rollup on the phone.** Companion shows one pill ("most recently active session") — fine for one terminal, weak as Zettlab lanes/agents grow ([[RES-AFEB]]). herdr's per-pane idle/working/blocked/done rollup is the right glance for a fleet. A "lanes" summary view in the PWA/iOS app (N sessions, their current verb + waiting/blocked flag) would be the high-value borrow.
2. **Hook-independent liveness.** Companion's activity feed depends on hooks firing to know *when* to read; if a session is killed/detached with no Stop hook, the pill can go stale (the [[companion_linux_hook_bugs]] class). herdr's process inspection sidesteps that. Companion could add a process/PTY liveness check as a robustness backstop (it already has `pty-manager.ts` — likely a small addition, but confirm by reading it first).

## Options

- **A. Replace with herdr — NO.** Loses APNs/native/Live Activity/approvals/phone-steer; mobile becomes SSH TUI.
- **B. Adopt herdr as Zettlab substrate — weak.** Duplicates session spawn/discover Companion already has, adds a Rust dep + churn risk, and its value (pane UI) is desktop, not phone. Only attractive if *you personally* want a mouse multiplexer at the Zettlab terminal.
- **C. Cherry-pick — RECOMMENDED.** Build a fleet-rollup view in Companion's clients + a process/PTY liveness backstop. Skip the binary and the socket API.

## Recommendation

**Cherry-pick (C).** The honest gap herdr exposes is that Companion is a *single-session* tool and your usage is trending *multi-agent* (lanes). The fix is a fleet-rollup view in Companion, not adopting herdr. Two tickets: (1) multi-session rollup in the PWA/iOS, (2) PTY/process liveness backstop in the activity layer. Orthogonal to the Convex spike.

## Verified vs not
- **Read in full:** `activity.ts`, `auto-judge.ts`, README, `server/lib/` inventory, herdr public docs/landing/repo pages.
- **NOT read (claims about them are inference from filenames):** `pty-manager.ts`, `spawn-session.ts`, `discover.ts`, `keyboard-inject.ts`, `sessions.ts`, `companion-broker`. herdr's socket-API JSON shapes (docs are JS-rendered; only CLI examples seen). Read these before building either ticket.
