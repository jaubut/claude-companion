# Canvas board API (canvas-board-sync P1)

One tldraw sync room (`main`) on the brain host (`COMPANION_BRAIN=1`, Zettlab). The Mac Canvas and the iPad are replicas of it, and agents edit it through the board MCP. Elsewhere, every path below answers `404 {ok:false, error:"board_disabled"}`. All of them sit behind the `/api/` Bearer gate (header, or `?token=` where a header can't be sent).

Storage: `companion.db` tables `board_documents`, `board_tombstones`, `board_metadata` (+ `board_objects`), written on every commit. Images: `~/.claude-companion/board-assets/<sha256-32>.<png|jpeg|gif|webp>`. Records hold only `src: "/api/board/assets/<file>"`, never a token or a host.

| endpoint | in | out |
|---|---|---|
| `GET /api/board/sync?token=&sessionId=&storeId=` (WS) | tldraw sync protocol 5.6.0 | the room. A schema mismatch is refused at connect. `sessionId` `[A-Za-z0-9_-]{1,128}` is required (400 `bad_session`) |
| `POST /api/board/import` | `getSnapshot(store)` JSON (`{document:{store,schema}}`) or `{store,schema}` | `200 {ok, imported}` · `409 board_not_empty` · `400 bad_snapshot`. Only document records are kept, `data:` images become asset files, and every record is migrated and validated before anything is written. Concurrent imports: one wins |
| `POST /api/board/assets` | raw body, `Content-Type` png/jpeg/gif/webp, ≤25 MB, bytes must match the type | `{ok, src, path}` · `415 unsupported_type` / `type_mismatch` · `413 too_large` |
| `GET /api/board/assets/<file>?token=` | the file name from `src` | bytes, `Cache-Control: private, immutable` · `404` |
| `GET /api/board/byq/thumbs/<kind>-<id>[.jpg\|.webp]?token=` | a BYQ library item, named as the iOS bundle's `byq-thumbs/` | image bytes (type from the file), `Cache-Control: private, max-age=86400` · `404`. Served from `~/.claude-companion/byq-thumbs/`; on a miss, fetched once from the item's `thumbnailUrl` in the mirror's `index.json` (https, BYQ's two CDN hosts only, ≤5 MB, real jpeg/webp/png bytes) and cached. Add `?v=<thumbHash>` from the manifest to bust caches |
| `OPTIONS /api/board/*` | CORS preflight, answered **before** the Bearer gate | `204`. Only for Origin `companion-sketch://app` does it set `Allow-Origin` (echoed) and `Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: Authorization, Content-Type`, `Max-Age: 600`. Always `Vary: Origin`, and no credentials. No CORS outside `/api/board/*` |
| `POST /api/mcp/board` | MCP Streamable HTTP (JSON-RPC, JSON responses). `GET` → 405 | `initialize` (returns `Mcp-Session-Id`), `tools/list`, `tools/call`. Notifications → 202 |

## Board MCP tools

Caller label (`meta.by` of created shapes): `X-Board-Caller` header (set by `scripts/board-mcp-headers.sh` to `<mac|zettlab>:<COMPANION_BOARD_CALLER or session id>`), else the session's `clientInfo.name`, else `agent`.

- `board_read {ids?, focus?, html?}` → `{ok, pages:[{id,name}], shapes:[…], presence:[…], truncated?}`. Default scope: the page Jeremie is on (newest presence). `ids` adds descendants. `focus` = his selection + descendants, else the shapes intersecting his viewport. Cap 500.
  - shape: `{id, type, parentId, pageId, x, y, w, h, page:{x,y,w,h}, rotation, text?, geo?, color?, title?, html? (only with html), props? (ui-block / auto-layout-frame: all props), arrow?:{from,to}, image?:{file, path, url, mime, w, h}, by?}`. `w`/`h` are null where the record stores none. A note is 200 × scale. `page` sums the parent chain and ignores parent rotation.
  - presence: `{user, pageId, selection, viewport:{x,y,w,h}, lastActivity}`.
- `board_write {ops}`: ≤50 ops in one transaction. Any invalid op → `isError {ok:false, error, at}` and nothing is applied. html ≤512 KB.
  - `{op:"create", type:"note"|"text"|"geo"|"arrow"|"live-frame"|"ui-block"|"auto-layout-frame", id?, parentId?, x?, y?, text?, geo?, color?, w?, h?, from?, to?, html?, title?, props?}`. `props` is for `ui-block` / `auto-layout-frame` only (see below); a `ui-block` needs `props.slug`. An arrow needs `from`/`to` (2 `binding` records). With no x/y, a shape goes 80 px right of Jeremie's selection, else to his viewport centre, else 0,0. Several such shapes stack downwards.
  - `{op:"update", id, x?, y?, rotation?, text?, w?, h?, color?, geo?, html?, title?, props?}`. A prop the shape lacks → error.
  - `{op:"delete", id}` also deletes descendants and every binding touching them.
- `board_asset {file}` → an MCP `image` block (≤5 MB), else `{ok, url, file}`.

## ui-block / auto-layout-frame (canvas auto-layout S1)

Shape props, `server/lib/board-schema.ts` = the client's `web/tldraw-canvas/src/features/canvas/schema`. Both are migration sequence version 0 (`com.tldraw.shape.ui-block`, `com.tldraw.shape.auto-layout-frame`): a prop change adds a migration on both sides, server deployed first. The room validates every put (client push or `board_write`), so an invalid prop is refused whoever sends it. Unknown props are refused.

| shape | prop | type | default (server and client) |
|---|---|---|---|
| both | `w`, `h` | number, > 0, ≤ 100000 | ui-block 1280 × 720 · frame 1280 × 800 |
| `ui-block` | `slug` | `[a-z0-9][a-z0-9-]{0,79}`; `board_write` also requires it to be in the manifest | none (required) |
| | `sizingW` | `"fixed" \| "fill"` | `"fixed"` |
| | `sizingH` | `"fixed" \| "hug"` (hug: h = the iframe's reported content height) | `"hug"` |
| `auto-layout-frame` | `name` | string ≤ 200 | `"Frame"` (`title` on create) |
| | `direction` | `"row" \| "column"` | `"column"` |
| | `justify` | `"flex-start" \| "center" \| "flex-end" \| "space-between"` | `"flex-start"` |
| | `align` | `"flex-start" \| "center" \| "flex-end" \| "stretch"` | `"stretch"` |
| | `gap`, `paddingX`, `paddingY`, `radius` | number 0-1000 | `0` |
| | `sizingW`, `sizingH` | `"fixed" \| "hug" \| "fill"` | `"fixed"`, `"hug"` |
| | `bg` | `""` (none) or `#rrggbb` / `#rrggbbaa` | `""` |

A `ui-block` renders its BYQ section in a sandboxed iframe whose width is the block's `w`, so BYQ's viewport breakpoints follow it. Width presets (`UI_BLOCK_WIDTHS`, manifest `widths`): desktop 1280, tablet 768, mobile 390. BYQ sections take no props: variants are these widths plus per-board theme tokens (S3), never component props.

**BYQ manifest.** `canvas-lib/byq/manifest.json` is committed: metadata only (`slug, kind, name, category, component, file, fonts, thumb, thumbHash`), never BYQ source (licence; this repo is public). `bun scripts/byq-sync.ts` regenerates it from the slugs it lists and copies their sources from the private mirror (`$BYQ_LIB`, default `~/work/byq-lib` on Zettlab) into the gitignored `canvas-lib/byq/src/<slug>/`. It refuses items that import anything but `react`. To add a section: fetch it into the mirror (BYQ Supply MCP), append `{"slug","kind"}` to `items`, re-run the sync.

**Thumbnails.** The iOS bundle's 2,454 rendered previews (claude-companion-ios PR #236) move to Zettlab once: copy `web/tldraw-canvas/public/byq-thumbs/*` into `~/.claude-companion/byq-thumbs/`. Items with a BYQ CDN thumbnail are fetched on first request.

## Registration (once per host, not automatic)

`bun scripts/board-mcp-register.ts [--host mac|zettlab]` → `claude mcp add-json --scope user board {"type":"http","url":…,"headersHelper":"<abs>/scripts/board-mcp-headers.sh"}`.
- Zettlab: `http://127.0.0.1:4245/api/mcp/board`. Mac: `https://zettlab.tailfc45f2.ts.net/api/mcp/board`.
- The token is read by the helper at connect time (`$COMPANION_PEER_ZETTLAB_TOKEN`, else `$COMPANION_AUTH_TOKEN`, else `~/.claude-companion/auth.token`) and is never written to `~/.claude.json`.
- The brain gets the same `board` definition through `--mcp-config ~/.claude-companion/brain-mcp.json` (0600, no token) plus `COMPANION_BOARD_CALLER=brain` (`wiring/brain-headless.ts`).

## Probe

`COMPANION_PROBE_TOKEN=… bun scripts/board-probe.ts --url <host> [--note "text"]` is a headless sync client. It prints every remote shape change with `meta.by`.
