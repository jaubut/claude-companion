# Remote Control vs Claude Companion — Teardown

Date: 2026-09-13. Phase 12 step 1 (PRJ-OR1T). Subject: Claude Code **Remote Control** (`claude remote-control`, `claude --remote-control`, `/remote-control` · aka `/rc`) driven from claude.ai/code and the Claude iOS/Android app.

**Provenance — two sources, both first-hand, neither recalled:**
1. **Official docs**, fetched 2026-09-13 from <https://code.claude.com/docs/en/remote-control> (the old `docs.claude.com/en/docs/claude-code/remote-control` 301s here). Everything in a `>` block below is a verbatim quote from that page.
2. **Live experiment on this machine**, Claude Code **2.1.270**, macOS, in a throwaway tmux pane driven by `tmux send-keys` — the same delivery path `injectText` uses. Section 3 is our own observed output, pasted, not summarized from docs.

> **Correction to the project note.** `projects/2026-06-22-companion-orchestrator` claimed this doc was "✅ desk half done 2026-09-12 (committed on branch `docs/rc-teardown`)". It was not. No such file, branch, or commit existed on the Mac or on Zettlab on 2026-09-13. This file is the first version of it. Treat the note's other unverified ✅ marks with the same suspicion.

---

## 1. What rc actually is

- **Execution stays local.** "When you start a Remote Control session on your machine, Claude keeps running locally the entire time, so your code execution and filesystem access stay on your machine." Local filesystem, MCP servers, tools, project config all remain available; `@` autocompletes local paths.
- **Transport is outbound-only, through Anthropic.** "Your local Claude Code session makes outbound HTTPS requests only and never opens inbound ports on your machine." It registers with the Anthropic API and polls for work.
- **Three CLI invocation modes** plus VS Code:
  - **Server mode** — `claude remote-control`. Long-lived, serves many sessions.
  - **Interactive** — `claude --remote-control` (`--rc`). One local interactive session, also drivable remotely.
  - **From an existing session** — `/remote-control`, which "starts a Remote Control session that carries over your current conversation history."
- **Server mode creates sessions on demand.** `--spawn <mode>`: `same-dir` (default), `worktree` ("each on-demand session gets its own git worktree"), `session` ("Serves exactly one session and rejects additional connections"). `--capacity <N>` — "Maximum number of concurrent sessions. Default is 32."
- **Plan-gated.** "available on Pro, Max, Team, and Enterprise plans. API keys are not supported." Off by default on Team/Enterprise until an Owner enables it.
- **Blocked by a non-Anthropic endpoint.** Not available on Bedrock, Google Cloud Agent Platform, Microsoft Foundry, a custom `ANTHROPIC_BASE_URL` (LLM gateway/proxy), or an enterprise Claude apps gateway. Also disabled by `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, or `DISABLE_GROWTHBOOK`, each of which "disable the feature-flag evaluation that Remote Control availability depends on."
- **Transcripts are stored on Anthropic servers.** "While Remote Control is connected, the session transcript, including your messages, Claude's responses, and tool activity, is stored on Anthropic servers." And: "Organizations with compliance requirements such as Zero Data Retention can't enable Remote Control."

### 1a. Where the origination edge actually sits (narrower than the note's original claim, still real)

`/rc` *attach* mode cannot originate a session, but **server mode can** — a pre-started `claude remote-control --spawn worktree` server creates sessions on demand, up to `--capacity` (32). So "only we can start work from the phone" is **false as stated**. What survives:

- rc needs a server **already running in that directory**, started from the desk. Companion spawns into **any registered host and cwd** with nothing pre-started per-directory.
- rc is **plan-gated** (Pro/Max/Team/Enterprise, no API keys) and **ZDR-incompatible**. Companion is self-hosted; nothing leaves the machine.
- rc's transcript lives on Anthropic's servers by design. Companion's lives in our sqlite.

That is the defensible edge. It is not "they can't create sessions."

---

## 2. What the phone/web client can drive (doc-grounded)

**Commands that work from mobile and web** — quoted in full, because this is the contract Phase 12 is built on:

> `/model`, `/effort`, `/fast`, `/color`, and `/rename`: pass the value as an argument, for example `/model sonnet` or `/effort high`. From mobile and web, `/model` and `/effort` take the argument in place of the terminal picker or slider.

Also working from mobile/web: `/compact`, `/clear`, `/context`, `/usage`, `/exit`, `/usage-credits`, `/recap`, `/reload-plugins`; `/mcp` (text summary on mobile; `reconnect`/`enable`/`disable` subcommands both surfaces); `/config key=value` (v2.1.181+); `/autocompact <size>` (v2.1.221+); `/advisor <model>|off` (v2.1.260+, "Both forms apply to the current session only and leave your saved default unchanged").

**Local-only:** "commands that only run in the terminal interface, such as `/plugin` or `/resume`, work only from the local CLI, whether or not you pass an argument."

**Model control — two distinct paths, different scope.** This is the single most important paragraph for us:

> A model you pick from the device's model control applies to the current session only. When you send `/model <name>` from the device to an interactive session, Claude Code also sets your default for new sessions.

So rc has a **native model control** (session-scoped) *and* the text-argument form (session + saved default). They are not the same thing. Version floor: "Requires Claude Code v2.1.238 or later."

> If you send a name Claude Code doesn't recognize, such as a display name where a model ID is expected, Claude Code refuses the pick and the session keeps its current model. Before v2.1.260, Claude Code saved an unrecognized pick from the device's model control, and your next message failed.

**Effort:** device effort control applies to the session; "If you pinned a level with `CLAUDE_CODE_EFFORT_LEVEL`, the session keeps that level, and Claude Code refuses a different pick." Floor v2.1.234.

**Other surfaces the device gets:** live conversation mirror; subagent and workflow progress, with the ability to stop one from the device; compaction and `/clear` reflected remotely; queued mid-turn prompts ("Claude Code queues it and keeps it in the device's transcript after that turn finishes"); a **diff pane** of uncommitted changes, computed on the local machine on request; session list with a computer icon + green online dot; rename round-tripping to the local `claude --resume` title.

**Push:** "Claude decides when to push." Two toggles only — **Push when Claude decides**, **Push when actions required** — "Beyond the two on/off toggles below, there is no per-event configuration." Pushes are skipped while you are focused on the connected terminal, extendable to any at-the-machine time via `CLAUDE_CLIENT_PRESENCE_FILE` (v2.1.181+).

**Dialog forwarding has a deadline.** Permission prompts and `AskUserQuestion` stay open until answered, but "When Claude Code forwards another kind of dialog to the remote session, such as the model-choice prompt shown after a safety refusal, it waits five minutes by default, then closes the dialog and continues with the dialog's no-action default" (`dialogExpiry`, v2.1.224+).

---

## 3. Live experiment — does the text-argument form work through `tmux send-keys`?

This is the cheap experiment the project note gated Phase 12 on. **Answer: yes, and it is picker-free.** Run on Claude Code 2.1.270, scratch cwd, delivery via `tmux send-keys` — byte-for-byte the path `/api/inject` already uses.

| Sent | Observed | Picker opened? |
|---|---|---|
| `/model sonnet` | `⎿ Set model to Sonnet 5 and saved as your default for new sessions` | **No** |
| `/model bogus-model-xyz` | `⎿ Model 'bogus-model-xyz' not found` | **No** — refused, not stored |
| `/effort medium` | **Confirmation dialog** — see below | **Yes** |
| `/effort xhigh` | `⎿ Set effort level to xhigh (saved as your default for new sessions): …` | No |
| `/model opus` | `⎿ Set model to Opus 5 and saved as your default for new sessions` | No |
| `/model claude-opus-5[1m]` | `⎿ Set model to Opus 5 (1M context) and saved as your default for new sessions` | No |
| `/model opus[1m]` | same — the short form takes the `[1m]` suffix too | No |

`/status` after the first send confirmed it was not cosmetic: `Sonnet 5 with xhigh effort · Claude Max`, and the companion statusline redrew as `🤖 ☕ idle · Sonnet 5 · rc-exp`.

**Finding 3a — the text form always writes the default.** Every successful set said *"and saved as your default for new sessions."* There is no argument form for session-only; the terminal picker reserves that for a hint key:

```
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.
     1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks
   ❯ 2. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday, complex tasks
     3. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks
     4. Sonnet                 Sonnet 5 · Efficient for routine tasks
     5. Haiku                  Haiku 4.5 · Fastest for quick answers
   ◉ xHigh effort ←/→ to adjust
   Enter to set as default · s to use this session only · Esc to cancel
```

So `/model <id>` ≠ rc's native model control. Ours would be the *default-setting* variant unless we keep a picker path for the session-only case. **We already have that path**: `/api/dialog/key` accepts one literal character and its own comment names this exact case — `"s" answers a hint like "s to use this session only"`. Session-scoped model change is reachable today; it is just three screen-scraped round-trips instead of one.

**Finding 3b — `/effort <level>` is not unconditionally picker-free.** It opened a confirm dialog:

```
   Change effort level?
   Your next response will be slower and use more tokens
   This conversation is cached for the current effort level. Switching to medium means the full history gets re-read on your next message.
   ❯ 1. Yes, switch to medium
     2. No, go back
```

Model parity collapses to UI work. **Effort parity does not** — it needs the dialog mirror as a fallback whenever the conversation is cached.

**Finding 3c — a live bug, found by accident, in a path we ship today.** While that effort dialog was open, the next injected line (`/model opus`) was **eaten by the dialog**: the text landed in the picker, Enter confirmed the cursor row, and the effort switch was accepted. The `/model opus` command never ran. `/api/inject` (`server/routes/api.ts:159`) has **no open-dialog guard** — it checks target registration and tty, clears the turn-end waiting reason, then injects. `dialogWatcher.current()` already knows a dialog is open for that session key; inject never asks. Any phone-sent prompt that arrives while a dialog is up silently answers the dialog instead. Filed as a task on PRJ-OR1T.

**Finding 3d — unrelated, but noticed:** `/status` reported `⚠ Your login expires in 2 days · run /login to renew`.

---

## 4. Verified vs not

**Closed from the desk (docs + local experiment), no device needed:**

- [x] Slash-command argument contract from mobile/web, with version floors
- [x] `/model <id>` sets model without a picker, and also writes the new-session default
- [x] Unrecognized model id is refused, not stored (on ≥ 2.1.260)
- [x] `/effort <level>` can open a confirmation dialog
- [x] Session-only model scope exists only behind the picker's `s` hint
- [x] Session origination in rc server mode (`--spawn worktree`, `--capacity 32`)
- [x] Plan gating, ZDR incompatibility, transcript storage location
- [x] Push notification model (two toggles, Claude decides)
- [x] Forwarded-dialog expiry (5 min default, `dialogExpiry`)
- [x] Reconnect semantics and the four documented takeover/ended/not-found reasons

**Still open — needs the real app on a real device (Jeremie):**

1. **Chat composition fidelity** — what the mobile composer actually offers: multi-line, markdown, queued-while-running affordance, edit/resend, stop.
2. **History fidelity** — how much scrollback the app loads, whether it paginates, and what a long thread looks like. (Directly relevant: our `getThread` oldest-N-turns bug, task `f65d35e7`.)
3. **Model + effort control as UI** — where the controls live, what they list, whether the session-only vs default distinction is visible to the user at all.
4. **Permission prompts and `AskUserQuestion` on the phone** — card shape, multi-choice rendering, how a stale one is presented.
5. **Attachments** — can the phone send an image or file into a session? Not covered anywhere on the rc docs page. Unknown, not "no".
6. **Session list and switching** — the online/offline dot, how fast it flips, what switching mid-turn does.
7. **Reconnect behaviour in the hand** — what the user sees during a drop, and whether the transcript backfills.

Do not write these from recall. The gap table's `rc has` column stays empty for any row that only these items could fill.

---

## 5. What this changes for Companion

1. **`dialogs.ts` arrow-key round-trip is not the only way to set a model.** A native picker emitting `/model <id>` down the existing `injectText` path replaces it for the common case. One round-trip, no pane parsing.
2. **Scope is a real product decision, not a detail.** Text form = session + default. Picker + `s` = session only. Pick one as the app's default behaviour and label it; silently rewriting Jeremie's new-session default from the phone is a bug waiting to be reported.
3. **Model IDs must come from the picker, not a hardcoded list.** `/model` lists the account's actual entitlements (here: Default, Opus 1M, Fable, Sonnet, Haiku). A hardcoded list rots the day Anthropic ships a model. The picker parse we already have is the right source; the arg form is the right *setter*.
4. **Inject needs a dialog guard before any of this ships** (Finding 3c). Phase 12 makes the phone send more commands, which makes this bug fire more often.
5. **The auto-judge stays.** rc relays everything and lets Claude decide when to push. That is a different product from curated interruption; nothing here argues for adopting it.

---

## 6. Source files read for this teardown

`server/routes/dialogs.ts` (full), `server/routes/api.ts:159-241` (`/api/inject`), `server/lib/dialogs.ts:1-80` + `pickKeys`. Not read, so not claimed about: `dialog-watch.ts`, `keyboard-inject.ts`, the iOS app.
