# `GET /api/subscriptions` — AI plan usage

Plan-limit usage of each AI subscription on this host, for the iOS usage widget.
Bearer-gated like every `/api/*`. Code: `server/lib/subscriptions.ts`, route in
`server/routes/gauge.ts`. Fixture: `contracts/subscriptions/api.json`.

```json
{ "ok": true, "subscriptions": [Subscription, ...] }
```

Always three entries, in this order: `claude`, `chatgpt`, `gemini`.

## Subscription

| field | type | notes |
|---|---|---|
| `provider` | `"claude" \| "chatgpt" \| "gemini"` | |
| `plan` | string \| null | Display name (`"Max 20x"`, `"Pro Lite"`). null = no local source names it. |
| `windows` | Window[] | `[]` when nothing is measured. |
| `status` | `"ok" \| "near" \| "limited" \| "unknown"` | `unknown` ⇔ no windows (and no "limit reached" flag). `limited`: a window ≥ 100 % or the provider says the limit is reached. `near`: a window ≥ 80 %. Else `ok`. |
| `updatedAt` | ISO string \| null | When the source last measured, not when the server answered. null = never. |

## Window

| field | type | notes |
|---|---|---|
| `label` | `"5h" \| "weekly" \| "daily" \| "monthly"` | Closed set; a source window that maps to none is left out. |
| `usedPct` | number | 0–100+, may be fractional. |
| `resetsAt` | ISO string \| null | Once a window's reset passes the server reports it as `usedPct: 0, resetsAt: null` until the source measures again. |

## Sources (all local, nothing spends tokens)

- **claude** — windows from the context-gauge mod's `rate_limits` (`GET /api/gauge` → `account.limits`): `five_hour` → `5h`, `seven_day` → `weekly`; per-model kinds (`seven_day_opus`, …) and `spend_limit` are left out. Live: it changes on every mod report. `plan` from `~/.claude.json` `oauthAccount.organizationRateLimitTier` (`default_claude_max_20x` → `Max 20x`) or `organizationType`.
- **chatgpt** — the newest `token_count` event with the account-wide `rate_limits` (`limit_id` `"codex"` or absent, at least one window or a reached flag) in a Codex CLI rollout (`~/.codex/sessions/**/rollout-*.jsonl`, newest threads from `~/.codex/state_5.sqlite`, the last 512 KB of each). `primary` / `secondary` by `window_minutes` (300 → `5h`, 1440 → `daily`, 10080 → `weekly`, ~30 d → `monthly`); `plan_type` → `plan`; `rate_limit_reached_type` set → `limited` until its window resets (`"primary"` / `"secondary"` → that slot's, else any window's). As fresh as the last Codex turn on this host.
- **gemini** — always `unknown`, `plan: null`. Antigravity (`agy`) has no quota or status command and keeps no quota or plan on disk; its quota is only reachable through Google's API with agy's OAuth token, which the server does not use.

File reads are cached 5 min; the Claude windows are not cached.

## Example (real values, 2026-11-17)

See `contracts/subscriptions/api.json`.
