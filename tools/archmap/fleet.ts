import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import type { ArchMap, FleetMap, FleetPackage, RosterEntry } from "./types"

// Fleet = every roster repo's COMMITTED architecture.json, aggregated by
// external package. Reads only; never scans or regenerates a sibling. The
// roster carries candidate paths per repo so Mac and Zettlab share one file;
// entries with no map on this machine land in `skipped`.

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p
}

export function loadRoster(path: string): RosterEntry[] {
  const j = JSON.parse(readFileSync(expandHome(path), "utf-8")) as { repos?: RosterEntry[] } | RosterEntry[]
  const list = Array.isArray(j) ? j : j.repos ?? []
  return list.filter((e) => e && typeof e.name === "string" && Array.isArray(e.paths))
}

export function resolveRepo(entry: RosterEntry, cwd = process.cwd()): string | null {
  for (const raw of entry.paths) {
    const p = expandHome(raw)
    const dir = isAbsolute(p) ? p : resolve(cwd, p)
    if (existsSync(join(dir, "architecture.json"))) return dir
  }
  return null
}

export function aggregateFleet(roster: RosterEntry[], cwd = process.cwd()): FleetMap {
  const repos: FleetMap["repos"] = []
  const skipped: string[] = []
  const acc = new Map<string, FleetPackage>()
  for (const entry of roster) {
    const dir = resolveRepo(entry, cwd)
    if (!dir) { skipped.push(entry.name); continue }
    const map = JSON.parse(readFileSync(join(dir, "architecture.json"), "utf-8")) as ArchMap
    repos.push({ name: entry.name, path: dir, generatedAt: map.generatedAt })
    for (const t of map.targets) {
      for (const [pkg, use] of Object.entries(t.packages ?? {})) {
        const fp = acc.get(pkg) ?? acc.set(pkg, { repos: [], modules: [], versions: {}, fanIn: 0 }).get(pkg)!
        if (!fp.repos.includes(entry.name)) fp.repos.push(entry.name)
        for (const m of use.modules) fp.modules.push(`${entry.name}:${t.name}/${m}`)
        // a repo with two targets pinning different versions keeps the first non-null
        if (!(entry.name in fp.versions) || (fp.versions[entry.name] === null && use.version)) fp.versions[entry.name] = use.version
      }
    }
  }
  const packages: Record<string, FleetPackage> = {}
  const entries = [...acc.entries()].map(([k, v]) => [k, { ...v, repos: v.repos.sort(), modules: v.modules.sort(), fanIn: v.modules.length }] as const)
  entries.sort((a, b) => b[1].fanIn - a[1].fanIn || a[0].localeCompare(b[0]))
  for (const [k, v] of entries) packages[k] = v
  return { generatedAt: new Date().toISOString().slice(0, 10), repos, skipped, packages }
}

export function writeFleet(fleet: FleetMap, out: string): void {
  const p = expandHome(out)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(fleet, null, 2) + "\n")
}
