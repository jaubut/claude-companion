#!/usr/bin/env bun
// One-time per host (canvas-board-sync A1): register the `board` MCP server
// at user scope. Zettlab (the brain host) → loopback; the Mac → the Zettlab
// tailnet URL, because the board lives with the brain. Auth comes from the
// headersHelper (scripts/board-mcp-headers.sh) at connect time: only its path
// is written to ~/.claude.json, never a token.
//   bun scripts/board-mcp-register.ts [--host mac|zettlab]
import { join, resolve } from "node:path"

const URLS = {
  zettlab: "http://127.0.0.1:4245/api/mcp/board",
  mac: "https://zettlab.tailfc45f2.ts.net/api/mcp/board",
} as const

const flag = process.argv.indexOf("--host")
const host = (flag >= 0 ? process.argv[flag + 1] : process.platform === "darwin" ? "mac" : "zettlab") as keyof typeof URLS
if (!(host in URLS)) {
  console.error("usage: bun scripts/board-mcp-register.ts [--host mac|zettlab]")
  process.exit(2)
}
const headersHelper = resolve(join(import.meta.dir, "board-mcp-headers.sh"))
const config = JSON.stringify({ type: "http", url: URLS[host], headersHelper })

// Replace any earlier entry; a missing one is fine.
await Bun.$`claude mcp remove --scope user board`.quiet().nothrow()
const added = await Bun.$`claude mcp add-json --scope user board ${config}`.nothrow()
if (added.exitCode !== 0) process.exit(added.exitCode)
console.log(`board → ${URLS[host]} (headersHelper ${headersHelper})`)
