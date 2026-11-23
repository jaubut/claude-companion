#!/usr/bin/env bun
// Live smoke check for bin/media on design references (not in CI: needs the network, yt-dlp and
// an installed Chromium). Runs the same pipeline as POST /hooks/brain/media, into a temp dir,
// skipping the 7-day cache, and lists the images each link returned.
//
//   bun scripts/media-smoke.ts [url ...]
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build } from "../server/lib/link-media"
import { checkUrl } from "../server/lib/link-media-guard"

const DEFAULT_URLS = [
  "https://dribbble.com/shots/27460154-Dashboard-Design-for-a-Shopify-Intelligence-Platform",
  "https://dribbble.com/shots/26957747-AI-Workspace-Dashboard-UI-Design-Seto",
  "https://ca.pinterest.com/pin/342555115431838113/",
]

const root = mkdtempSync(join(tmpdir(), "media-smoke-"))
let failed = 0
for (const [i, raw] of (process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_URLS).entries()) {
  const c = await checkUrl(raw)
  if (!c.ok) { console.log(`FAIL ${raw}: ${c.reason}`); failed++; continue }
  const t0 = Date.now()
  const { status, body } = await build(c.url, join(root, String(i)))
  const frames = Array.isArray(body.frames) ? body.frames.map(String) : []
  const ok = status === 200 && frames.length > 0
  if (!ok) failed++
  console.log(`${ok ? "OK  " : "FAIL"} ${raw} → ${status} ${body.kind ?? body.reason} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  for (const f of frames) console.log(`     ${f}`)
  if (typeof body.contactSheet === "string") console.log(`     sheet ${body.contactSheet}`)
}
process.exit(failed ? 1 : 0)
