#!/usr/bin/env bun
// archmap — generate (or check / lint) a repo's architecture map.
//   bun run ~/.claude/tools/archmap/cli.ts <repo> [--check] [--lint [--baseline <json>]] [--quiet]
// Reads <repo>/archmap.json, writes <repo>/architecture.md + architecture.json.
// --check: exit 1 if the committed map is stale (JSON differs, timestamp aside).
// --lint:  exit 1 on import-rule violations or cap growth vs the baseline map
//          (see lint.ts). Both may be combined; neither writes files.
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ArchMap, RepoConfig, Target } from "./types"
import { scanBunServer } from "./adapters/bun-server"
import { scanHonoServer } from "./adapters/hono-server"
import { scanReactClient } from "./adapters/react-client"
import { scanSwiftUI } from "./adapters/swiftui"
import { scanNuxt } from "./adapters/nuxt"
import { resolveRoot } from "./adapters/shared"
import { renderMarkdown, type RefTarget } from "./render"
import { lint, formatIssues } from "./lint"

const args = process.argv.slice(2)
const repo = resolve(args.find((a) => !a.startsWith("--")) ?? ".")
const check = args.includes("--check")
const doLint = args.includes("--lint")
const quiet = args.includes("--quiet")
const cfgPath = join(repo, "archmap.json")
if (!existsSync(cfgPath)) {
  console.error(`archmap: no archmap.json in ${repo}`)
  process.exit(2)
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as RepoConfig
const t0 = performance.now()
const targets: Target[] = cfg.targets.map((t) => {
  switch (t.adapter) {
    case "bun-server": return scanBunServer(t, repo)
    case "hono-server": return scanHonoServer(t, repo)
    case "react-client": return scanReactClient(t, repo)
    case "swiftui": return scanSwiftUI(t, repo)
    case "nuxt": return scanNuxt(t, repo)
    default: throw new Error(`archmap: unknown adapter ${String(t.adapter)}`)
  }
})
const map: ArchMap = { generatedAt: new Date().toISOString().slice(0, 10), repo: cfg.repo, intent: cfg.intent ?? "", targets, refs: cfg.refs ?? [] }
const jsonPath = join(repo, "architecture.json")
const mdPath = join(repo, "architecture.md")
const strip = (m: ArchMap) => JSON.stringify({ ...m, generatedAt: "" }, null, 2)

let failed = false
if (check) {
  const prev = existsSync(jsonPath) ? readFileSync(jsonPath, "utf-8") : ""
  let prevStripped = ""
  try { prevStripped = strip(JSON.parse(prev) as ArchMap) } catch { /* missing/invalid → stale */ }
  if (prevStripped !== strip(map)) {
    console.error("archmap: architecture.json is stale — regenerate and commit")
    failed = true
  } else if (!quiet) console.log("archmap: up to date")
}
if (doLint) {
  // baseline = --baseline <path> (CI: the base branch's architecture.json),
  // else the committed map, so a local run ratchets against what is checked in.
  const bi = args.indexOf("--baseline")
  const basePath = bi >= 0 ? args[bi + 1]! : jsonPath
  let baseline: ArchMap | null = null
  try { baseline = JSON.parse(readFileSync(basePath, "utf-8")) as ArchMap } catch { /* no baseline → every over-cap module blocks */ }
  const issues = lint(map, cfg, baseline)
  const blocking = issues.filter((i) => i.blocking)
  if (issues.length) console[blocking.length ? "error" : "log"](`archmap: ${blocking.length} blocking, ${issues.length - blocking.length} legacy\n${formatIssues(issues)}`)
  else if (!quiet) console.log("archmap: lint clean")
  if (blocking.length) failed = true
}
if (check || doLint) process.exit(failed ? 1 : 0)

// Referenced maps join the rendered contracts only; the JSON keeps the pointer.
const refs: RefTarget[] = []
const unresolved: string[] = []
for (const r of map.refs) {
  const dir = resolveRoot(repo, r.repo)
  const p = join(dir, "architecture.json")
  if (!existsSync(p)) { unresolved.push(`${r.name} (${r.repo})`); continue }
  const sub = JSON.parse(readFileSync(p, "utf-8")) as ArchMap
  for (const t of sub.targets) refs.push({ ...t, ref: r.name, repo: r.repo, generatedAt: sub.generatedAt })
}
writeFileSync(jsonPath, JSON.stringify(map, null, 2) + "\n")
writeFileSync(mdPath, renderMarkdown(map, refs, unresolved) + "\n")
const over = targets.flatMap((t) => t.modules.filter((m) => m.lines > t.cap).map((m) => `${t.name}/${m.path} (${m.lines} > ${t.cap})`))
if (!quiet) {
  console.log(`archmap: ${targets.map((t) => `${t.name}=${t.modules.length}`).join(" ")} modules → architecture.md (${Math.round(performance.now() - t0)}ms)`)
  if (over.length) console.log(`archmap: over cap → ${over.join(", ")}`)
  if (unresolved.length) console.log(`archmap: unresolved refs → ${unresolved.join(", ")}`)
}
