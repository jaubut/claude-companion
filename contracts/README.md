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
