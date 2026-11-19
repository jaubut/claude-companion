# Canvas auto-layout: S0 prior-art scan

Stage S0 of [plan.md](plan.md) (Jeremie: "go canvas", 2026-11-19). No feature code. This page covers where the code lives, what the prior art does, what to borrow, what the BYQ probe showed, and the changes to S1-S6 that follow.

## 1. Where the code lives

**Board server** (this repo, `claude-companion`, **public**):

| file | role | S1 touch |
|---|---|---|
| `server/lib/board-schema.ts` | `boardSchema = createTLSchema({ shapes: { ...defaultShapeSchemas, "live-frame": … } })`, a hand copy of the client's props | add `ui-block` + `auto-layout-frame` props **and their migrations** |
| `server/lib/board-records.ts` (+ `.test.ts`) | record validation and migration on import | test literal per new shape, built from the client's default props |
| `server/lib/board-tools.ts` | `boardRead` / `parseBoardOps` / `boardWrite` (one `room.updateStore` per call), `BOARD_SHAPE_TYPES` | S1: accept the two types in `create`/`update`, reject bad props. S4: `board_tree`, `board_append_block`, `board_update_layout`, `board_wrap`, `board_export` |
| `server/lib/board-mcp.ts` | `POST /api/mcp/board`, `BOARD_MCP_TOOLS` list | S4 tool definitions |
| `server/lib/board-room.ts` | the `TLSocketRoom` (`main`), SQLite storage in companion.db | none |
| `server/lib/board-assets.ts`, `server/routes/board.ts`, `server/wiring/board.ts` | assets, HTTP + WS routes, wiring | none |
| `docs/board-api.md` | the contract | S1 + S4 doc updates |

**Canvas client** (repo `claude-companion-ios`, **private**): one Vite + React 19 + tldraw 5.6 app, `web/tldraw-canvas/`, built single-file (`vite-plugin-singlefile`) and copied by `scripts/copy-out.mjs` into the `TLDraw.bundle` that both the Mac Canvas and the iPad load in a WKWebView (`companion-sketch://app`).

- **Branch to build on: `feat/canvas-board-sync` (PR #241, open, base `build/testflight-240`).** `main` (38843215) still has the pre-strip layout (`Companion Canvas/TLDraw.bundle`, no sync, no library). The current tree lives on `build/testflight-240` (#232 canvas strip, #234, #235, #236 library) plus #241 (sync P2). S1 branches from `feat/canvas-board-sync` or waits for #241 to merge.
- Sources on that branch (`web/tldraw-canvas/src/`): `main.tsx` (Tldraw mount, `shapeUtils`), `LiveFrame.tsx` (the `live-frame` shape: sandboxed iframe, no `allow-same-origin`, Tailwind browser runtime inlined), `live-html.ts` (`buildLiveReactHtml`: sucrase compiles a BYQ `.tsx` and mounts it with React inside the iframe; `placeByqItemCard`), `react-iframe-runtime.js` (React for inside the iframe), `byq-library.tsx` (Design Library panel: tabs, search, chips, drag-to-board), `board-sync.tsx` (`useSync`), `board-assets.ts`, `bridge.ts` (`native.byqDetail(path)` reads BYQ source on the Mac), `make-real.ts`, `pen-input.ts`.
- Bundle output: `CompanionKit/Sources/CompanionUI/Resources/TLDraw.bundle/` (+ `byq-index.json`, `byq-thumbs/`, 2,454 JPEG previews, ~24 MB).
- Plan section 6.1's `src/features/canvas/` becomes **`web/tldraw-canvas/src/features/canvas/`** in `claude-companion-ios`.

**BYQ source mirror**: `~/work/byq-lib` on Zettlab (git, no remote by design). 3,587 catalog items; fetched: 2,886 components, 285 wireframes, 222 gems, 194 styles. Layout `<kind>/<category>/<id>/{item.md, meta.json, <Name>.tsx}`, `index.json`, `build_index.py`. `LICENSE-NOTE.md`: TLS-internal, never pushed or redistributed.

**Schema lock-step**: the sync handshake refuses a client whose schema differs from the server's. Every new shape or prop is a coordinated two-repo change (server deploy on Zettlab first, then the bundle), with tldraw pinned to exactly 5.6.0 in both.

## 2. BYQ probe (2026-11-19)

- **Access works from Zettlab**: the BYQ Supply MCP answers `search_byq_components` and `get_byq_component`. The probe used `truebase-hero-2` ("Split Hero with Social Proof", `requiresPro: true`). It was not committed.
- **Format**: an integration prompt (markdown) containing:
  - a screenshot;
  - one `.tsx` file (`HeroSection.tsx`, with a named and a default export) that imports only `react`;
  - `@fonts Geist, IBM Plex Serif` in a JSDoc header;
  - Google Fonts setup;
  - absolute CDN image URLs (`byqsupply-components.netlify.app`);
  - arbitrary-value Tailwind classes (`bg-[#faf6ea]`, `text-[64px]`);
  - a "style adaptation" list of hard-coded colours, fonts and radii, plus layout, interaction and responsive notes.

  `~/work/byq-lib` already holds the same thing for 2,886 sections (`item.md` + `meta.json` + `<Name>.tsx`).
- **No props.** Across all 2,886 fetched sections, 0 take props: content and colours are hard-coded. Plan 6.2's "variants = the component's real props" has nothing to read. See S1/S3 below.
- **Viewport breakpoints.** 2,831 of 2,886 use `max-[767px]:` / `max-[991px]:`, which key off the viewport. Rendered straight into the board's DOM, they would follow the Mac window, not the frame. Inside an iframe they follow the iframe's width, which is what we want: a 390-wide frame shows the mobile layout. 1,943 start with `'use client'`. 5 import an npm package (gsap / motion).
- **Licence** ([BYQ licensing FAQ](https://byq.supply/help/faq/licensing-usage-rights), [resale FAQ](https://byq.supply/faqs/can-i-resell-byq-templates-or-sections)):
  - Allowed: unlimited client projects, no attribution required.
  - Not allowed: resale, or repackaging as templates or libraries. The account is licensed to one person.
  - `~/work/byq-lib/LICENSE-NOTE.md` goes further: never push or redistribute; ship BYQ-derived code only inside finished sites, adapted to that site's design.

  **Consequences:**
  - BYQ source must never land in this public repo.
  - Plan 6.1 puts a committed `canvas-lib/byq/` next to the canvas client, which conflicts with our own note even in the private iOS repo. See decision D1.

## 3. Prior art

All paths below were verified through the GitHub API on 2026-11-19. Licences were checked against each repo's LICENSE file.

| project | licence · activity | (a) DOM layout + write-back | (b) element→code, JSX/Tailwind | (c) inspector | (d) agent/MCP |
|---|---|---|---|---|---|
| **tldraw examples + templates** | `LicenseRef-tldraw` SDK; templates and `apps/mcp-app` MIT · 51.5k★, daily | **`flex-layout`** (below) is our R1 almost exactly. `size-from-dom` sizes a shape from its own DOM. `frame-layouts` is a pure-function layout run from `onChildrenChange` | none | `contextual-style-panel`, `contextual-toolbar` examples | agent template: zod "Focused" shapes, typed `AgentActionUtil`s. `apps/mcp-app`: `search` + an open `exec` (JS in the live editor) |
| **tldraw make-real** | no LICENSE file, archived 2026-02 | LLM HTML in an iframe; no layout | none | none | ideas only (we already have Make Real) |
| **tldraw computer** | no public repo (404) | n/a | n/a | n/a | n/a |
| **Onlook** | Apache-2.0 · 27.3k★, daily. v1 web editor frozen at tag `v1-final`; `main` is now an Electron app | user app in an iframe, a preload script posts `getBoundingClientRect` + computed styles over penpal RPC; browser does layout | Babel adds `data-oid` to each JSX element → oid↔AST map; Tailwind edits merged into `className` with tailwind-merge | Tailwind-driven editor bar (display, direction, gap, align, padding) | none of its own |
| **Penpot** | MPL-2.0 · 62.5k★, daily | **own flex/grid solver** (ClojureScript + Rust/WASM), no DOM | HTML/CSS codegen, no JSX/Tailwind | best "Mixed" handling and layout-item sizing menus | official MCP: an LLM writes plugin code run in the editor |
| **Webstudio** | **AGPL-3.0** · 9.2k★, daily | canvas iframe, `getBoundingClientRect` + ResizeObserver, synced via nanostores | instance tree → JSX (`react-sdk`), own atomic CSS | documented 3x3 alignment matrix (`alignment-ui.tsx`) | official MCP via its CLI: typed batch edits + checkpoint/preview |
| **Plasmic** | MIT outside `platform/`, **AGPL** for `platform/` (editor, inspector, codegen) · 7.2k★, daily | same-origin canvas iframe, jQuery bounds | React + CSS modules (AGPL) | `FlexContainerControls.tsx` (AGPL) | in-app Copilot only |
| **Builder.io** | MIT (SDKs, Mitosis) · 8.9k★ / 14.5k★; editor closed | page in an iframe, `enable-editor` postMessage bridge, parent draws the overlay | Mitosis JSON IR → ~20 targets, **no Tailwind generator** | closed; open part is `registerComponent({inputs})` | Fusion is an MCP client; no official server |
| **Framer** | proprietary, ideas only | Stack: direction, distribute, align, gap, padding, wrap; per child **fixed / fill / fit (hug) / relative** | code components + `addPropertyControls` | that field set | official MCP (`mcp.framer.com`) bridged to the live editor |

**Summary:** every DOM tool (Onlook, Webstudio, Plasmic, Builder, tldraw's own example) lets the browser lay out and reads boxes back. Only Penpot runs a solver, and that confirms R1. Nobody ships a JSX + Tailwind exporter we can reuse (Webstudio and Plasmic's are AGPL, Mitosis has no Tailwind), so we write ours.

### 3.1 Borrow list

Code we may copy (permissive licence; keep the notice in the file header):

| what | where | for |
|---|---|---|
| Frame shape: `BaseFrameLikeShapeUtil` (clip + reparent), a hidden CSS flex container with one placeholder `<div data-shape-id>` per child sized from its geometry, a `ResizeObserver` reading `offsetLeft/offsetTop` → `updateShapes` (skips < 0.5 px), no write-back while a child is being translated, `onDragShapesOut`, `onDropShapesOver` with a drop index from the pointer, drop-indicator lines, a contextual toolbar | [FlexLayoutExample.tsx @ v5.6.0](https://github.com/tldraw/tldraw/blob/v5.6.0/apps/examples/src/examples/shapes/tools/flex-layout/FlexLayoutExample.tsx), [FlexContainerHelpers.tsx](https://github.com/tldraw/tldraw/blob/main/apps/examples/src/examples/shapes/tools/flex-layout/FlexContainerHelpers.tsx) (tldraw licence: examples are part of the SDK we already use) | S2 base of `AutoLayoutFrameUtil` |
| Leaf size from content: `EditorAtom<id → size>` fed by a ResizeObserver, read in `getGeometry` (bounds, hit-test and culling stay right with no `canCull` hack) | [SizeFromDomExample.tsx](https://github.com/tldraw/tldraw/blob/main/apps/examples/src/examples/shapes/tools/size-from-dom/SizeFromDomExample.tsx) | S2 hug height of `ui-block` (fed by the iframe's postMessage, below) |
| Pure layout fallback from `onChildrenChange` | [FrameLayoutsExample.tsx](https://github.com/tldraw/tldraw/blob/main/apps/examples/src/examples/shapes/tools/frame-layouts/FrameLayoutsExample.tsx), [BoardLayouts.ts](https://github.com/tldraw/tldraw/blob/main/apps/examples/src/examples/shapes/tools/frame-layouts/BoardLayouts.ts) | S4 server-side first placement (see below) |
| Canvas → LLM format, typed actions with `sanitizeAction` | [FocusedShape.ts](https://github.com/tldraw/tldraw/blob/main/templates/agent/shared/format/FocusedShape.ts), [CreateActionUtil.ts](https://github.com/tldraw/tldraw/blob/main/templates/agent/client/actions/CreateActionUtil.ts) (MIT) | S4 `board_tree` shape and op validation |
| In-iframe element payload (rect, parent rect, styles) and typed postMessage RPC | Onlook [preload helpers.ts](https://github.com/onlook-dev/onlook/blob/v1-final/apps/web/preload/script/api/elements/helpers.ts), [penpal child.ts](https://github.com/onlook-dev/onlook/blob/v1-final/packages/penpal/src/child.ts) (Apache-2.0) | S2 height report from the sandboxed BYQ iframe |
| `data-oid` injection; Tailwind class merge into JSX | Onlook [parser/ids.ts](https://github.com/onlook-dev/onlook/blob/v1-final/packages/parser/src/ids.ts), [code-edit/style.ts](https://github.com/onlook-dev/onlook/blob/v1-final/packages/parser/src/code-edit/style.ts), [code-edit/layout.ts](https://github.com/onlook-dev/onlook/blob/v1-final/packages/parser/src/code-edit/layout.ts) (Apache-2.0) | S5 export (class merge); later, content slots |
| Component registration schema (props, defaults) | Plasmic [registerComponent.ts](https://github.com/plasmicapp/plasmic/blob/master/packages/host/src/registerComponent.ts) (MIT); Builder [register-component.ts](https://github.com/BuilderIO/builder/blob/main/packages/sdks/src/functions/register-component.ts) (MIT) | S1 `meta.json` field names |

Ideas only (no code: MPL file-level copyleft, AGPL, proprietary):
- Penpot's [layout_container.cljs](https://github.com/penpot/penpot/blob/develop/frontend/src/app/main/ui/workspace/sidebar/options/menus/layout_container.cljs), [layout_item.cljs](https://github.com/penpot/penpot/blob/develop/frontend/src/app/main/ui/workspace/sidebar/options/menus/layout_item.cljs) and [multiple.cljs](https://github.com/penpot/penpot/blob/develop/frontend/src/app/main/ui/workspace/sidebar/options/shapes/multiple.cljs): the inspector rows and "Mixed".
- Webstudio's 3x3 matrix: x → justify-content, y → align-items, transposed for column.
- Framer's per-child sizing set.
- Webstudio's typed-batch MCP over Penpot/tldraw's open `exec`.

### 3.2 Avoid

- **An open `exec` / run-JS MCP tool** (tldraw mcp-app, Penpot). It is an arbitrary-code surface on the board host. Keep typed ops, as plan R5 already says.
- **Our own flex solver** (Penpot, and the plan's original Step 2). It is superseded by R1 and by the tldraw example.
- **`getBoundingClientRect() / zoom` for positions.** `offsetLeft/offsetTop` are layout-space, so they are zoom-free and exact under tldraw's transform. Use rects only inside the iframe, where there is no zoom.
- **Bindings-based layout** (tldraw `layout-bindings`). It is superseded.
- **Onlook `main`**, Mitosis as a dependency, anything under Plasmic `platform/`, any Webstudio code.

## 4. Recommended changes to S1-S6

**S1 Schema + BYQ sync**
- **Paths.**
  - Client modules: `claude-companion-ios/web/tldraw-canvas/src/features/canvas/{schema,shapes,layout,inspector}/`, on top of `feat/canvas-board-sync`.
  - Server: `server/lib/board-schema.ts` + `board-records.test.ts` + `board-tools.ts` (`BOARD_SHAPE_TYPES`, prop checks) here, deployed on Zettlab before the bundle.
- **`canvas-lib/byq/` is generated, not committed** (D1).
  - `sync.ts` reads `~/work/byq-lib` (Mac: the same mirror, or `native.byqDetail` as today) at build time into a gitignored folder.
  - It writes only a registry (`slug, name, category, thumbnail, sourcePath, fonts, deps, viewportWidth`) that may be committed.
- **Registry without props.**
  - `variantProps` stays in the schema (`T.dict`) but is empty for BYQ v1.
  - The "variants" the inspector offers in S3 are: a **width preset** (desktop 1440 / tablet 991 / mobile 390, which drives the iframe width and so BYQ's own breakpoints) and **theme tokens**.
  - For theme tokens, `sync.ts` rewrites each component's hard-coded hex/font values (listed in `item.md`'s "Style adaptation") to CSS variables set per board/frame. That is the plan's 6.2 per-board theme.
  - Text/image content slots (Onlook-style `data-oid`) are out of v1.
- **Rendering stays an iframe per `ui-block`**, reusing `LiveFrame`'s sandbox + `buildLiveReactHtml`. Viewport breakpoints need it, and the sandbox keeps BYQ scripts away from the board and the native bridge. Fonts come from each block's `@fonts` (Google Fonts link inside the iframe); images stay CDN URLs. Both need the network, so an offline iPad shows fallbacks.
- **Migrations from day one** for `ui-block` and `auto-layout-frame` (`live-frame` has none, which is follow-up F2), since their props will change in S2/S3.
- **Acceptance tweak:** "renders identical to its BYQ preview" means a screenshot diff at the preview's width (1440), fonts loaded. Pick the 10-15 v1 sections from those with no npm import.

**S2 Layout engine**
- **Start from tldraw's `flex-layout` example (v5.6.0)** instead of the spec's Step 2/3 code.
  - Extend it with the plan's props (padding, gap, justify, align, hug/fixed).
  - Measure with `offsetLeft/offsetTop` on placeholders. This replaces R1's `getBoundingClientRect / zoom`.
  - Wrap every write-back in `editor.run(…, { history: 'ignore' })`, coalesced per animation frame (R2; the example lacks this).
- **Leaf hug height:** the BYQ iframe can't be read from outside (no `allow-same-origin`). A small script inside it posts `document.documentElement.scrollHeight` on ResizeObserver (Onlook preload pattern). The parent keeps it in an `EditorAtom` read by `getGeometry` (`size-from-dom`), and writes `h` back only when it changes by more than 1 px.
- **One writer per change.**
  - With the Mac and the iPad both live, two replicas measuring and writing the same frame can ping-pong: different fonts, zoom rounding or widths give slightly different numbers.
  - Rule: only the client with the newest presence (Jeremie's active device) writes reflow results; the other renders what syncs.
  - Add to the acceptance: Mac and iPad open together, no write loop (S6 two-client sync builds on this).
- **Add a `fill` child sizing mode** (`flex: 1`), per Framer and Penpot. The browser does the work, so it costs one prop value.

**S3 Inspector:** borrow the row layout and "Mixed" handling (Penpot) and the 3x3 matrix mapping (Webstudio). Use the `contextual-style-panel` example as the tldraw hook-up. Variants = width preset + theme tokens (see S1).

**S4 Agents via board MCP**
- Typed tools as planned; no `exec`.
- `board_tree` follows the agent template's Focused-shape idea: flat, typed, ids, no x/y.
- When no client is open, an agent's `board_append_block` / `board_wrap` would leave children at stale x/y until a client measures. So the server places new children with a pure stack function (`frame-layouts` style: padding + gap + the child's last known size), and the next live client corrects it from the DOM.

**S5 Export:** our own frame → JSX + Tailwind serializer, about 100 lines (`flex`, `flex-col`, `gap-[n]`, `px-[n]`, `justify-*`, `items-*`, `w-full` for fill). Merge classes with `tailwind-merge`, as Onlook does. Exported BYQ code goes only into a client or own site repo, adapted by the theme tokens, which is what BYQ's licence allows. Nothing changes in the branch + PR flow.

**S6:** unchanged, plus the two-client writer rule test.

## 5. Decisions for Jeremie

- **D1 BYQ source in git.** The plan commits `canvas-lib/byq/<slug>/component.tsx`. Our `LICENSE-NOTE.md` says BYQ code is never pushed, and this repo is public. Recommendation: generate it at build time, gitignored, and commit only the registry.
  - Related: the private iOS repo already ships `byq-index.json` + 2,454 rendered thumbnails in `TLDraw.bundle` (PR #236). Keep it, or move the thumbs to a build step too?
- **D2 tldraw licence (R6, closed as "not a blocker").** For the record: per [tldraw.dev/pricing](https://tldraw.dev/pricing), production needs a licence key (100-day trial, commercial at undisclosed value-based pricing, or a non-commercial hobby key with the watermark), and the SDK enforces it. Nothing to do in S1. It only matters before the board is used for client-facing work.
