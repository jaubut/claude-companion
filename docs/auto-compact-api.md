# Auto-compact API (smart /compact between tasks)

Server: `server/lib/auto-compact.ts` (gates, transcript tail parsing,
controller), `server/wiring/auto-compact.ts` (tmux / APNs / fs deps),
`server/routes/auto-compact.ts` (HTTP). Auth: the standard `/api/*` bearer gate.

**Off by default.** Enabled only when `AUTO_COMPACT_TOKENS` is set to a
positive number (e.g. `600000`). Unset, blank, `0`, negative or non-numeric =
off. GET `/api/auto-compact` reports the effective `threshold` (0 = off).

## Triggers

On every Stop hook, with the context size = the last main-chain assistant
usage:

- **size** — context > `AUTO_COMPACT_TOKENS`.
- **task boundary** — context > `AUTO_COMPACT_BOUNDARY_TOKENS` (default
  `250000`; `0` = off; unset/garbage = default; ignored while
  `AUTO_COMPACT_TOKENS` is off) AND a unit of work just closed in this session
  (`server/lib/auto-compact-keep.ts`, `SessionScan`):
  - `pr_merged` — a `gh pr merge` whose result is not an error / "not
    mergeable", or a `gh pr …` result saying `MERGED`, for a PR not already
    seen merged;
  - `task_completed` — `dispatch.sh: <id> → completed`, or a Bash command
    running `UPDATE tasks SET … done=1` / `/api/task … "done": true`;
  - `closing_prompt` — the latest human prompt is ≤ 3 words, all from
    nice / perf / parfait / good / great / dope / merci / ok / thanks / cool /
    super / top / bravo / job / work… ("ok fix it" is not closing).

  A merge / completion counts only after the last non-closing prompt and the
  last compaction ("since the last boundary"); every closing is used once (the
  countdown consumes it). Sidechain (subagent) entries are ignored.

Both triggers then pass the same gates: idle 3 min, Claude status `idle`, no
open background Bash/Agent, empty input box, 30 min per-session cooldown, 60 s
cancellable countdown push. The countdown body names the boundary
("Context 300k tokens, PR merged. …").

## Keep text

The typed command is `/compact keep: …` built from durable state, not the
chat — one line, ≤ 1500 chars:

- `PRs:` every PR this session touched with `gh pr <verb> <n|url>` (open first,
  ≤ 6), state read live from `gh pr view <url> --json state` when the repo is
  known, else the last state seen in the transcript;
- `Turso note <id> (<ref_code>) open tasks: …` for the notes / tasks this
  session wrote (`UPDATE|INSERT … notes|tasks`, `/api/note|task`,
  `file-dev-task.sh`, `dispatch.sh`; ≤ 4 notes, ≤ 5 tasks each);
- `STATE.md next:` lines of the session cwd's STATE.md (cwd up to the git
  root): the body of a heading naming "next" / "resume here", and `Next:` lines;
- `pending human steps:` open tasks of those notes assigned to
  `COMPANION_TASK_ASSIGNEES` (default `human:jeremie,human`).

Lookups are capped at 8 s each. If nothing is found or a lookup fails, the
keep is the generic
`/compact keep: current task, open PRs/branches, decisions made, next steps`.

## Stats

Each completed compaction (our inject answered by a `compact_boundary`) is a
companion.db `auto_compactions` row (trigger, pre / post tokens). Totals per
range are on `GET /api/body/tokens` → `compactions` (`docs/body-api.md`).

## Endpoints

```
GET  /api/auto-compact
  → 200 { threshold: number, pending: [{ key, phase, name, tokens, trigger }] }
     phase:   "scheduled" | "countdown" | "injecting" | "awaiting_boundary"
     trigger: "size" | "pr_merged" | "task_completed" | "closing_prompt"

POST /api/auto-compact/cancel
  body  { key: string }          // session key from the push userInfo.key
  → 200 { ok: true, cancelled: boolean }  // false = nothing cancellable (already typed / gone)
  → 400 { ok: false, error: "key_required" }
```

Cancel works only in `scheduled` / `countdown`. A cancel (like a prompt or
typing in the pane) also starts the 30 min per-session cooldown.

## Push contract (for the iOS Cancel action)

Countdown push (`apns-collapse-id` = `compact-<sha1(key)[:16]>`, the result push
replaces it):

```
category:   "auto_compact"
title:      "compacting <name> in 60s"
body:       "Context <X> tokens[, PR merged | task completed | task closed]. To cancel, type anything in the session's pane."
userInfo:   { key, sessionId, action: "auto_compact_cancel", cancelPath: "/api/auto-compact/cancel" }
```

Result push: category `auto_compact_done`, title
`compacted <name>: <X> -> <Y> tokens`, passive.

### iOS work still open (claude-companion-ios)

The `auto_compact` category has **no registered action yet**, so a tap only
opens the app; the push body tells the user to cancel by typing in the pane.
To wire it:

1. Register `UNNotificationCategory("auto_compact")` with one action
   `"auto_compact_cancel"` titled "Cancel" (`.destructive`, no foreground
   needed).
2. On that action: `POST <host><userInfo.cancelPath>` with the bearer token and
   JSON `{ "key": userInfo.key }`, to the host that sent the push.
3. Treat `cancelled: false` as "too late" (the `/compact` was already typed).

Once shipped, the countdown body can go back to "Tap Cancel to keep it as is."
