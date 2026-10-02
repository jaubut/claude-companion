# Approval History API

Server: `server/lib/approval-history.ts` (store), `server/lib/secret-redact.ts`
(redaction), `server/wiring/events.ts` (lifecycle → rows + WS frame),
`server/routes/api.ts` (HTTP).

A permanent record of every approval and question that **reached the phone**
(the `→ phone` path), with how it ended. Auto-judge allows/denies, learned
allows and SUPER allows are never recorded. Nothing is pruned automatically.

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

Query: `state` = `all` (default) | `resolved` (anything but pending) | one state
from the table above · `kind` = `approval` | `question` · `q` = substring of
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

### `GET /api/approvals/history/:id`

`{ok:true, item:{…list fields, host, device_claimed, detail}}` or
`404 {ok:false, error:"not_found"}`.

`detail` for an approval: `{agent, input, reason?, toolUseId?}` (redacted tool
input). For a question: `{agent, questions:[{question, header, multiSelect,
options:[{label, description?}]}], answers?:[{selected:[…], otherText?}]}`.

### `DELETE /api/approvals/history?before=<iso>`

Manual pruning. Deletes resolved rows with `created_at` before the instant
(pending rows are never deleted). `{ok:true, deleted:<n>}`;
`400 {ok:false, error:"bad_before"}` when `before` is missing or not a date.

## WS frame `approval_history`

Broadcast on every insert and every state change (additive; the `approval`,
`question` and `resolved` frames are unchanged):

```json
{ "type": "approval_history", "item": { /* same fields as a list item */ } }
```

Upsert the row by `item.id`. A re-asked question arrives again with
`state:"pending"` under the same id.
