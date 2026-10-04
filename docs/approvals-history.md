# Approval History API

Server: `server/lib/approval-history.ts` (store), `server/lib/approval-history-auto.ts`
(batched auto rows, retention, frame throttle), `server/lib/secret-redact.ts`
(redaction), `server/wiring/events.ts` (lifecycle → rows + WS frames),
`server/routes/hooks.ts` (auto decisions), `server/routes/api.ts` (HTTP).

Two kinds of rows in one table:

- **Phone rows** — a permanent record of every approval and question that
  **reached the phone** (the `→ phone` path), with how it ended. Never pruned
  automatically.
- **Auto rows** — an audit trail of every automatic PreToolUse decision (SUPER
  allow, auto-judge allow/deny, learned allow, read-only MCP allow), for Claude
  and Codex alike. Kept `COMPANION_HISTORY_AUTO_DAYS` days (default **30**),
  pruned once a day (first pass a minute after boot); phone rows are never
  touched by that prune.

**Default views are phone-only**: a list call with no `state` (or `state=all`
/ `resolved`) never returns auto rows, so older iOS builds see exactly what they
saw before. Auto rows are opt-in via `state=auto|auto_allowed|auto_denied|everything`.

Store: table `approval_history` in the companion sqlite (`COMPANION_DB_PATH`,
default `~/.claude-companion/companion.db`). One row per approval/question id.
A question re-asked under the same id (PreToolUse window lapsed → the
PermissionRequest sibling re-asks it) is the same row, moved back to `pending`.
A row only ever moves out of `pending` once: a late second exit (an expiry
racing a phone allow) does not overwrite the first outcome.

## States

| `state` | Meaning | `decided_via` |
|---|---|---|
| `pending` | On the phone, waiting | `null` |
| `allowed` | Phone allowed the approval | `phone` |
| `denied` | Phone denied the approval | `phone` |
| `answered` | Phone answered the question (answers in `detail.answers`) | `phone` |
| `expired` | Nobody decided in time, or the turn/session moved past a question | `expiry`, `user_prompt`, `stop`, `session_end`, `server_restart` |
| `elsewhere` | Approval: hook went away or the call ran / turn ended without the phone. Question: answered in the terminal picker | `hook_gone`, `post_tool_use`, `user_prompt`, `stop`, `session_end` |

| `auto_allowed` | Allowed automatically, never reached the phone | `super`, `auto_judge`, `learned`, `mcp_readonly` |
| `auto_denied` | Denied automatically (destructive-command denylist) | `auto_judge` |

Auto rows: `kind` is always `approval`, `resolved_at` equals `created_at`,
`device_claimed` is `null`, and `detail` is `{agent, input, reason?, toolUseId?}`
like a phone approval (`reason` is the judge's reason, `"SUPER mode"` for SUPER).
`decided_via` for auto rows:

| `decided_via` | Source |
|---|---|
| `super` | SUPER mode allowed it (not on the catastrophe list) |
| `auto_judge` | Static rules: always-safe tool, Bash allowlist, routine edit, feature-branch push, destructive denylist (→ `auto_denied`) |
| `learned` | A shape the phone allowed before (learned-allow table) |
| `mcp_readonly` | Read-only MCP verb (`search_/get_/list_/read_/query_`) |

Auto rows are written in batches off the hook path (one transaction every
250 ms or per 50 rows); a write error drops that batch and is logged at most
once a minute. Rows buffered when the process dies (≤ ~250 ms worth) are lost.

`server_restart`: on boot (first open of the store) every row still `pending`
belongs to a dead process, so it ends `expired`.

`device_claimed` (detail only): the `X-Companion-Device` header of the REST call
or WS connection that decided. Client-asserted, never authenticated.

## Redaction

Before `summary` and `detail` are stored, every known secret value (≥ 8 chars)
from `~/.config/tls-agent/secrets.env` (`TLS_SECRETS_FILE`) and its
`secrets.mirror` sibling is replaced with `•••`, including its JSON-escaped form.
The value list is cached in memory for 5 min and never logged. Token shapes are
masked too: `Bearer …`, `sk-…`, `ghp_/gho_/ghu_/ghs_/ghr_…`, `github_pat_…`,
`pss_…`. Then `summary` is capped at 500 chars and `detail` at 8 KB (over the cap
it becomes `{"truncated":true,"preview":"<first ~8 KB of the JSON>"}`).

## Endpoints

Bearer-gated by the host's `/api/*` gate (`Authorization: Bearer <token>`).

### `GET /api/approvals/history`

Query: `state` = `all` (default: every **phone** state) | `resolved` (phone
states but pending) | `auto` (`auto_allowed` + `auto_denied`) | `everything`
(phone + auto) | one state from the table above (incl. `auto_allowed`,
`auto_denied`) · `kind` = `approval` | `question` · `q` = substring of
summary, tool or cwd · `limit` = 1–200 (default 50) · `before` = the previous
page's `next`, verbatim.

```json
{
  "ok": true,
  "host": "Jeremies-MacBook-Pro.local",
  "items": [
    {
      "id": "3f1c…",
      "kind": "approval",
      "state": "allowed",
      "tool": "Bash",
      "summary": "git push origin feat/x",
      "cwd": "/Users/jeremieaubut/claude-companion",
      "session_key": "…",
      "session_id": "a1b2…",
      "decided_via": "phone",
      "created_at": "2026-10-02T17:52:15.958Z",
      "resolved_at": "2026-10-02T17:52:21.004Z"
    }
  ],
  "next": "2026-10-02T17:52:15.958Z|3f1c…"
}
```

Newest first (`created_at` desc, then `id` desc). `next` is `null` on the last
page. A bare `created_at` is also accepted as `before`.
`400 {ok:false, error:"bad_state"|"bad_kind"|"bad_limit"}`.

### `GET /api/approvals/history/stats?since=<iso>`

Row counts per state, for tab badges and filter chips. `since` (optional) counts
rows **created** at or after the instant; omitted = all time. Every key is
always present.

```json
{ "ok": true, "counts": { "pending": 0, "allowed": 12, "denied": 1, "expired": 3, "elsewhere": 4, "answered": 2, "auto_allowed": 811, "auto_denied": 2 } }
```

`400 {ok:false, error:"bad_since"}` when `since` is not a date.

### `GET /api/approvals/history/:id`

`{ok:true, item:{…list fields, host, device_claimed, detail}}` or
`404 {ok:false, error:"not_found"}`.

`detail` for an approval: `{agent, input, reason?, toolUseId?}` (redacted tool
input). For a question: `{agent, questions:[{question, header, multiSelect,
options:[{label, description?}]}], answers?:[{selected:[…], otherText?}]}`.

### `DELETE /api/approvals/history?before=<iso>`

Manual pruning. Deletes resolved rows (phone and auto) with `created_at`
before the instant (pending rows are never deleted). `{ok:true, deleted:<n>}`;
`400 {ok:false, error:"bad_before"}` when `before` is missing or not a date.

## WS frame `approval_history`

Phone rows only. Broadcast on every insert and every state change (additive; the `approval`,
`question` and `resolved` frames are unchanged):

```json
{ "type": "approval_history", "item": { /* same fields as a list item */ } }
```

Upsert the row by `item.id`. A re-asked question arrives again with
`state:"pending"` under the same id.

## WS frame `approval_history_auto`

Auto rows never get an `approval_history` frame. Instead, while auto rows are
being written, at most **one frame per 5 s**:

```json
{ "type": "approval_history_auto", "count": 37, "since": "2026-10-02T17:52:15.958Z" }
```

`count` = auto rows written since the previous frame; `since` = `created_at` of
the oldest of them. The first batch after a quiet period is sent at once; later
batches inside the window are summed into one trailing frame. Show "N new" and
refetch (`state=auto` / `everything`, or `stats?since=`).
