// archmap — generated architecture map. Static, regex-level, no AST.
// One adapter per stack; the renderer joins them into cross-target contracts.

export interface Endpoint {
  method: string   // GET | POST | PAGE | * (unknown)
  path: string     // "/api/dialog/key", "/api/note/:id", or "/api/orchestrator/proposal/" (prefix)
  prefix: boolean
}

export interface ModuleInfo {
  path: string           // relative to the target root
  lines: number
  kind: string           // free-form per adapter: "route-host" | "router" | "lib" | "view" | "page" | "state" | ...
  exports: string[]      // exported symbol names (functions/consts/types)
  state: string[]        // module-level mutable state ("sessions: Map", "let timer")
  emits: string[]        // WS frame types this module broadcasts
  consumes: string[]     // frame types this module switches on (raw case literals; renderer filters)
  endpoints: Endpoint[]  // HTTP routes handled here
  apiCalls: string[]     // HTTP paths this module calls (clients)
  imports: string[]      // local module paths imported
  listeners: string[]    // event registrations at top level (onSessions(...), setInterval, watcher.start)
  sheets: number         // SwiftUI presentation sites
  externals?: string[]   // bare external import specifiers ("hono/cors", "@libsql/client", "SwiftUI"); optional so older maps stay valid
}

// Per-target view of the external packages its modules import, resolved
// against the nearest lockfile. `version` is null when no lockfile pins it.
export interface PackageUse {
  version: string | null
  modules: string[]      // module paths (target-relative) importing the package
}

export interface Target {
  name: string
  adapter: string
  root: string
  cap: number
  modules: ModuleInfo[]
  // export name → { module, callers: [module, ...] } across the target
  fanIn: Record<string, { module: string; callers: string[] }>
  packages?: Record<string, PackageUse>   // package name → use; optional so older maps stay valid
}

// A sibling repo's committed map, joined by reference: its targets take part in
// the contract tables (frames, endpoints) but never in this repo's JSON, so the
// committed map stays fresh when the sibling changes.
export interface RefConfig {
  name: string
  repo: string           // path (relative, absolute, or ~/…) to a repo with architecture.json
}

export interface ArchMap {
  generatedAt: string
  repo: string
  intent: string
  targets: Target[]
  refs: RefConfig[]
}

// --- Fleet: many repos' committed maps, aggregated by external package -------
// The roster lists repos with candidate paths (Mac and Zettlab differ); the
// first existing path with an architecture.json wins. The aggregation reads
// committed maps only — it never scans a sibling.
export interface RosterEntry {
  name: string
  paths: string[]
}

export interface FleetPackage {
  repos: string[]                         // roster names importing it
  modules: string[]                       // "<repo>:<target>/<module>" — every importing module
  versions: Record<string, string | null> // roster name → pinned version (null = unresolved)
  fanIn: number                           // modules.length — a plain count, NOT Target.fanIn's shape
}

export interface FleetMap {
  generatedAt: string
  repos: { name: string; path: string; generatedAt: string }[]
  skipped: string[]                       // roster entries with no committed map on this machine
  packages: Record<string, FleetPackage>  // sorted by fanIn desc, then name
}

export type AdapterName = "bun-server" | "hono-server" | "react-client" | "swiftui" | "nuxt"

export interface TargetConfig {
  name: string
  adapter: AdapterName
  root: string
  cap?: number
  ignore?: string[]
  extraDirs?: string[]   // nuxt: extra top-level dirs to scan (trigger/, scripts/)
}

// Import boundary: modules matching `from` may not import modules matching any
// `deny` pattern. Patterns are target-relative path globs (`routes/**`,
// `lib/*.ts`, `companion-server.ts`).
export interface ImportRule {
  target: string
  from: string | string[]
  deny: string[]
  why: string
}

export interface RepoConfig {
  repo: string
  // What the repo is for and how it is used — one paragraph. Printed at the
  // top of architecture.md; the architect judges the current shape against
  // the state of the art for THIS intent, not against the shape it finds.
  intent?: string
  targets: TargetConfig[]
  refs?: RefConfig[]
  rules?: ImportRule[]
}

export function emptyModule(path: string, lines: number, kind: string): ModuleInfo {
  return { path, lines, kind, exports: [], state: [], emits: [], consumes: [], endpoints: [], apiCalls: [], imports: [], listeners: [], sheets: 0, externals: [] }
}

export function uniq(xs: string[]): string[] {
  return [...new Set(xs)]
}
