# Canvas board API (canvas-board-sync P1)

One tldraw sync room (`main`) on the brain host (`COMPANION_BRAIN=1`, Zettlab). The Mac Canvas and the iPad are replicas of it, and agents edit it through the board MCP. Elsewhere, every path below answers `404 {ok:false, error:"board_disabled"}`. All of them sit behind the `/api/` Bearer gate (header, or `?token=` where a header can't be sent).

Storage: `companion.db` tables `board_documents`, `board_tombstones`, `board_metadata` (+ `board_objects`), written on every commit. Images: `~/.claude-companion/board-assets/<sha256-32>.<png|jpeg|gif|webp>`. Records hold only `src: "/api/board/assets/<file>"`, never a token or a host.

| endpoint | in | out |
|---|---|---|
| `GET /api/board/sync?token=&sessionId=&storeId=` (WS) | tldraw sync protocol 5.6.0 | the room. A schema mismatch is refused at connect. `sessionId` `[A-Za-z0-9_-]{1,128}` is required (400 `bad_session`) |
| `POST /api/board/import` | `getSnapshot(store)` JSON (`{document:{store,schema}}`) or `{store,schema}` | `200 {ok, imported}` · `409 board_not_empty` · `400 bad_snapshot`. Only document records are kept, `data:` images become asset files, and every record is migrated and validated before anything is written. Concurrent imports: one wins |
| `POST /api/board/assets` | raw body, `Content-Type` png/jpeg/gif/webp, ≤25 MB, bytes must match the type | `{ok, src, path}` · `415 unsupported_type` / `type_mismatch` · `413 too_large` |
| `GET /api/board/assets/<file>?token=` | the file name from `src` | bytes, `Cache-Control: private, immutable` · `404` |
| `OPTIONS /api/board/*` | CORS preflight, answered **before** the Bearer gate | `204`. Only for Origin `companion-sketch://app` does it set `Allow-Origin` (echoed) and `Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: Authorization, Content-Type`, `Max-Age: 600`. Always `Vary: Origin`, and no credentials. No CORS outside `/api/board/*` |
| `POST /api/mcp/board` | MCP Streamable HTTP (JSON-RPC, JSON responses). `GET` → 405 | `initialize` (returns `Mcp-Session-Id`), `tools/list`, `tools/call`. Notifications → 202 |

## Board MCP tools

Caller label (`meta.by` of created shapes): `X-Board-Caller` header (set by `scripts/board-mcp-headers.sh` to `<mac|zettlab>:<COMPANION_BOARD_CALLER or session id>`), else the session's `clientInfo.name`, else `agent`.

- `board_read {ids?, focus?, html?}` → `{ok, pages:[{id,name}], shapes:[…], presence:[…], truncated?}`. Default scope: the page Jeremie is on (newest presence). `ids` adds descendants. `focus` = his selection + descendants, else the shapes intersecting his viewport. Cap 500.
  - shape: `{id, type, parentId, pageId, x, y, w, h, page:{x,y,w,h}, rotation, text?, geo?, color?, title?, html? (only with html), arrow?:{from,to}, image?:{file, path, url, mime, w, h}, by?}`. `w`/`h` are null where the record stores none. A note is 200 × scale. `page` sums the parent chain and ignores parent rotation.
  - presence: `{user, pageId, selection, viewport:{x,y,w,h}, lastActivity}`.
- `board_write {ops}`: ≤50 ops in one transaction. Any invalid op → `isError {ok:false, error, at}` and nothing is applied. html ≤512 KB.
  - `{op:"create", type:"note"|"text"|"geo"|"arrow"|"live-frame", id?, parentId?, x?, y?, text?, geo?, color?, w?, h?, from?, to?, html?, title?}`. An arrow needs `from`/`to` (2 `binding` records). With no x/y, a shape goes 80 px right of Jeremie's selection, else to his viewport centre, else 0,0. Several such shapes stack downwards.
  - `{op:"update", id, x?, y?, rotation?, text?, w?, h?, color?, geo?, html?, title?}`. A prop the shape lacks → error.
  - `{op:"delete", id}` also deletes descendants and every binding touching them.
- `board_asset {file}` → an MCP `image` block (≤5 MB), else `{ok, url, file}`.

## Registration (once per host, not automatic)

`bun scripts/board-mcp-register.ts [--host mac|zettlab]` → `claude mcp add-json --scope user board {"type":"http","url":…,"headersHelper":"<abs>/scripts/board-mcp-headers.sh"}`.
- Zettlab: `http://127.0.0.1:4245/api/mcp/board`. Mac: `https://zettlab.tailfc45f2.ts.net/api/mcp/board`.
- The token is read by the helper at connect time (`$COMPANION_PEER_ZETTLAB_TOKEN`, else `$COMPANION_AUTH_TOKEN`, else `~/.claude-companion/auth.token`) and is never written to `~/.claude.json`.
- The brain gets the same `board` definition through `--mcp-config ~/.claude-companion/brain-mcp.json` (0600, no token) plus `COMPANION_BOARD_CALLER=brain` (`wiring/brain-headless.ts`).

## Probe

`COMPANION_PROBE_TOKEN=… bun scripts/board-probe.ts --url <host> [--note "text"]` is a headless sync client. It prints every remote shape change with `meta.by`.
