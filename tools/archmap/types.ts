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
}

export interface Target {
  name: string
  adapter: string
  root: string
  cap: number
  modules: ModuleInfo[]
  // export name → { module, callers: [module, ...] } across the target
  fanIn: Record<string, { module: string; callers: string[] }>
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

export type AdapterName = "bun-server" | "hono-server" | "react-client" | "swiftui" | "nuxt"

export interface TargetConfig {
  name: string
  adapter: AdapterName
  root: string
  cap?: number
  ignore?: string[]
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
  return { path, lines, kind, exports: [], state: [], emits: [], consumes: [], endpoints: [], apiCalls: [], imports: [], listeners: [], sheets: 0 }
}

export function uniq(xs: string[]): string[] {
  return [...new Set(xs)]
}
