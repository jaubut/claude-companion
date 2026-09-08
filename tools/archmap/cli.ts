#!/usr/bin/env bun
// archmap — generate (or check / lint) a repo's architecture map.
//   bun run ~/.claude/tools/archmap/cli.ts <repo> [--check] [--lint [--baseline <json>]] [--quiet]
//   bun run ~/.claude/tools/archmap/cli.ts --fleet <out.json> [--fleet-from <roster.json>]
// Reads <repo>/archmap.json, writes <repo>/architecture.md + architecture.json.
// --check: exit 1 if the committed map is stale (JSON differs, timestamp aside).
// --lint:  exit 1 on import-rule violations or cap growth vs the baseline map
//          (see lint.ts). Both may be combined; neither writes files.
// --fleet: aggregate every roster repo's COMMITTED map by external package into
//          <out.json> (see fleet.ts). Needs no repo argument; scans nothing.
// Unknown flags exit 2 — a typo must not fall through to a full regenerate.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
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
import { findLockfile, resolvePackages } from "./packages"
import { aggregateFleet, loadRoster, writeFleet } from "./fleet"

const FLAGS_WITH_VALUE = new Set(["--baseline", "--fleet", "--fleet-from"])
const FLAGS = new Set([...FLAGS_WITH_VALUE, "--check", "--lint", "--quiet"])
const args = process.argv.slice(2)
const flagValue = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const positional: string[] = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]!
  if (a.startsWith("--")) {
    if (!FLAGS.has(a)) { console.error(`archmap: unknown flag ${a}`); process.exit(2) }
    if (FLAGS_WITH_VALUE.has(a)) { if (args[i + 1] === undefined || args[i + 1]!.startsWith("--")) { console.error(`archmap: ${a} needs a value`); process.exit(2) } i++ }
    continue
  }
  positional.push(a)
}
const quiet = args.includes("--quiet")

// --fleet runs before any repo resolution: it reads committed maps, not this cwd.
const fleetOut = flagValue("--fleet")
if (fleetOut) {
  const roster = loadRoster(flagValue("--fleet-from") ?? "~/.claude/archmap-fleet.json")
  const fleet = aggregateFleet(roster)
  writeFleet(fleet, fleetOut)
  if (!quiet) {
    const top = Object.entries(fleet.packages).slice(0, 8).map(([k, v]) => `${k}(${v.fanIn})`).join(" ")
    console.log(`archmap: fleet ${fleet.repos.length} repos, ${Object.keys(fleet.packages).length} packages → ${fleetOut}\n  top: ${top}`)
    if (fleet.skipped.length) console.log(`  skipped (no committed map here): ${fleet.skipped.join(", ")}`)
  }
  process.exit(0)
}

const repo = resolve(positional[0] ?? ".")
const check = args.includes("--check")
const doLint = args.includes("--lint")
const cfgPath = join(repo, "archmap.json")
if (!existsSync(cfgPath)) {
  console.error(`archmap: no archmap.json in ${repo}`)
  process.exit(2)
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as RepoConfig
// On a case-insensitive volume `architecture.md` and a hand-written
// `ARCHITECTURE.md` are the same file — never overwrite someone's design doc.
for (const name of ["architecture.md", "architecture.json"]) {
  const clash = readdirSync(repo).find((e) => e !== name && e.toLowerCase() === name)
  if (clash) {
    console.error(`archmap: ${clash} exists and would be overwritten by ${name} on a case-insensitive filesystem — rename it (e.g. docs/${clash.replace(/\.md$/, "-DESIGN.md")}) first`)
    process.exit(2)
  }
}
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
}).map((t) => ({ ...t, packages: resolvePackages(t.modules, findLockfile(repo, resolveRoot(repo, t.root), t.adapter === "swiftui")) }))
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
  const basePath = flagValue("--baseline") ?? jsonPath
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
