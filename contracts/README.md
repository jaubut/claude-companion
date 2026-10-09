# Wire contracts

`FeedEvent` (the `event` WS frame payload) is declared twice: server `server/lib/feed.ts`
and iOS `WSFrame.swift` `FeedEventPayload`. These fixtures are the shared ground truth
both sides test against.

## `feed-events/`

- `<kind>.json` — one per kind in `FEED_EVENT_KINDS`, with every field that kind
  carries populated (identity `key` / `cwd` / `tty` / `sessionId` on all of them;
  `ts` is ms since epoch). `artifact.json` fills `url`, `path` and `ref` together even
  though a producer emits one — the decoder must accept all three.
- `<kind>.minimal.json` — only the required fields (`id`, `ts`, `kind`); the type
  allows every other field to be absent.
- `unknown-kind.json` — a kind that does not exist, so clients prove they tolerate
  kinds from a newer server.

## Synced copy

The iOS repo (`~/apps/claude companion`) carries a byte-identical copy under
`claude companionTests/Fixtures/feed-events/`. `bun run contracts:sync` writes it
(and refuses if the iOS repo is absent).

`server/lib/feed-contract.test.ts` checks every fixture parses, uses a kind from
`FEED_EVENT_KINDS`, and round-trips through `appendFeedEvent` → `getFeed()`; and,
when the iOS copy exists, that it matches ours byte for byte. On hosts without the
iOS repo the drift check is skipped with a printed reason.

## Rule

Change the type → change the fixture → `bun run contracts:sync` → both tests
(`bun test` here, the iOS decode test there) → commit in both repos.

## `gauge/` — context gauge (`server/lib/gauge.ts`)

Not part of `contracts:sync` (that copies `feed-events/` only); the iOS decoder mirrors
these by hand. `server/routes/gauge.test.ts` checks the live frame and `GET /api/gauge`
carry exactly these keys.

- `frame.json` — the `gauge` WS frame: one `GET /api/gauge` `sessions[]` item plus
  `account`. `sessionKey` is the session registry `key` (the `sessions` frame's `key`).
  ≤ 1 frame / 2 s per session (trailing, so the latest value always lands).
- `frame.cleared.json` — the session's gauge dropped (30 min without a report, or the
  session ended): `ctxTokens` / `ctxWindow` / `ctxPercent` / `source` all null.
- `api.json` — `GET /api/gauge` (bearer). `account` may be null; every account field but
  `limits` and every `ctx*` field may be null. `account.limits` is always an array
  (`[]` until a mod report carries `rate_limits`): `{kind, percentUsed, resetsAt}` per
  rate-limit window, the freshest report's array as a whole (not merged per kind);
  `kind` is open (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
  `spend_limit`, or newer) and passes through; `percentUsed` / `resetsAt` (ISO) may be null.
  A frame with null ctx fields carries an `account` update too (an account-only report
  for a session with no ctx gauge) — read `account` from every frame. `source` is `"mod"` (live, from the context-gauge mod) or
  `"transcript"` (server estimate; no 5h figure on that path). `at` is ms since epoch.

## `copy-jobs/` — footage-copy progress (`server/lib/copy-jobs.ts`)

Not part of `contracts:sync`; the iOS decoder mirrors these by hand (like `gauge/`).
`server/routes/copy-jobs.test.ts` checks the live frame, the empty frame and
`GET /api/copy-jobs` carry exactly these keys.

- `frame.json` — the `copy_jobs` WS frame: every copy job on the host, full list each
  time (replace, never merge). ≤ 1 frame / 2 s per host (trailing). Also sent right
  after `init` on `/ws` open when the host has jobs. Covers `copying`, `hashing`
  (no rate / ETA, null `copyStartedAt`) and `failed` (finished with `failed > 0`).
- `frame.empty.json` — the last job dropped: `jobs: []` clears the host's row.
- `api.json` — `GET /api/copy-jobs` (bearer): `{ok, jobs}`, same items.

Item: `jobId` (opaque, the mod's output-file basename), `sessionKey` (registry `key`,
null when the reporting session is unknown — the job is still shown), `label`, `state`
(`hashing | copying | done | failed`; open — map an unknown one to neutral),
`totalFiles` / `doneFiles` / `totalBytes` / `doneBytes` / `failed`, `current` (file name
or null), `startedAt` / `copyStartedAt` (sticky, ms epoch), `finishedAt` (server time of
the first finished report; the job drops 60 s later), `bytesPerSec` (average since
`copyStartedAt`) and `etaSec` (seconds, `copying` only) — derived by the server, null
when unknown — and `at` (the reporter's time of the last report, ms epoch). Every key is
always present; nullable ones are null, never missing. An unfinished job with no report
for 120 s drops.
