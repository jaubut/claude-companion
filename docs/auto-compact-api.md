# Auto-compact API (smart /compact between tasks)

Server: `server/lib/auto-compact.ts` (gates, transcript tail parsing,
controller), `server/wiring/auto-compact.ts` (tmux / APNs / fs deps),
`server/routes/auto-compact.ts` (HTTP). Auth: the standard `/api/*` bearer gate.

**Off by default.** Enabled only when `AUTO_COMPACT_TOKENS` is set to a
positive number (e.g. `600000`). Unset, blank, `0`, negative or non-numeric =
off. GET `/api/auto-compact` reports the effective `threshold` (0 = off).

**Scope.** `AUTO_COMPACT_ONLY` = comma list of session keys or name globs
(`*`, `?`, case-insensitive; matched against the key and the session name
shown in the push). When set, only matching sessions can be armed by a Stop (size AND boundary trigger,
skipped before the transcript is read); the test trigger ignores it;
unset/blank = every session. E.g. `AUTO_COMPACT_ONLY=claude:tty:/dev/ttys003,wt-*`.
GET reports it as `only` (`[]` = all).

## Triggers

On every Stop hook, with the context size = the last main-chain assistant
usage:

- **size** — context > `AUTO_COMPACT_TOKENS`.
- **test** — `POST /api/auto-compact/test` (below): size floor skipped, scope ignored.
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

Every trigger, including `test`, types this state-aware keep (falling back to the
generic one); a finished test compaction is recorded with `trigger: "test"`
and its countdown push body names the reason ("Context 40k tokens, test.").

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
  → 200 { threshold: number, only: string[], pending: [{ key, phase, name, tokens, trigger }] }
     phase:   "scheduled" | "countdown" | "injecting" | "awaiting_boundary"
     trigger: "size" | "pr_merged" | "task_completed" | "closing_prompt" | "test"

POST /api/auto-compact/cancel
  body  { key: string }          // session key from the push userInfo.key
  → 200 { ok: true, cancelled: boolean }  // false = nothing cancellable (already typed / gone)
  → 400 { ok: false, error: "key_required" }

POST /api/auto-compact/test
  body  { key: string }          // session key (`sessions[].key` in GET /api/status)
  → 200 { ok: true, key, name, tokens: number | null, checkInSeconds: number }
  → 400 { ok: false, error: "key_required" }
  → 404 { ok: false, error: "session_not_found" }      // unknown / not a Claude session
  → 409 { ok: false, error: "off" | "busy" | "in_progress" | "cooldown" }
  → 422 { ok: false, error: "transcript_unreadable" }
```

### Test trigger

`POST /api/auto-compact/test` proves the feature on any session without
waiting for 600k tokens. It runs the **normal path** for that one session
with every gate except the size threshold (and `AUTO_COMPACT_ONLY`, since the
target is explicit):

1. waits until the user has been quiet 3 min (`checkInSeconds`, 0 if already idle);
2. re-checks the gates (idle status, no background tasks, empty input box);
3. sends the countdown push `compacting <name> in 60s`;
4. after 60 s, still idle and not cancelled, types `/compact …` into the pane;
5. sends the result push on the `compact_boundary`.

Cancel during steps 1–3 by typing anything in the session's pane, or with
`POST /api/auto-compact/cancel {key}`. Refused when the feature is off
(`AUTO_COMPACT_TOKENS` unset/0), when the session is not `idle`
(busy / waiting on a dialog), while a `/compact` it injected is still
settling, and inside the 30 min cooldown (a cancelled test counts as an
attempt). Every request is logged (`auto-compact test requested for <key>`).

```
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"key":"claude:tty:/dev/ttys003"}' http://<host>:<port>/api/auto-compact/test
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

Tracked as companion-ios #82 (open). Until it ships, cancel = type in the pane.
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
