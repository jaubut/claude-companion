import { emptyModule, uniq, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, computeFanIn, sourcesOf } from "./shared"

// SwiftUI app: no route grammar, so contracts are read from literals —
// WSFrame `case "x":` (frames decoded), SocketEvent `case name(` (events),
// `case .name` in a handler switch (events applied), `path: "/api/…"` (HTTP
// paths called), `.sheet(isPresented:/item:)` sites, @Published state.
// Fan-in: types and top-level funcs referenced from 2+ files (`Name(`,
// `Name.`, `Name<`).

const TYPE_RE = /^(?:final\s+)?(?:struct|class|enum|actor)\s+([A-Za-z_]\w*)/
const FUNC_RE = /^\s*(?:@\w+\s+)*(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/
// `case "a", "b":` — every literal on a case line, not just the first.
const FRAME_CASE_LINE_RE = /^\s*case\s+("[a-z_]+"(?:\s*,\s*"[a-z_]+")*)\s*:/gm
const PATH_RE = /path:\s*"([^"?]+)/g
const PUBLISHED_RE = /@Published(?:\s+private\(set\))?\s+var\s+([A-Za-z_]\w*)/g
// presentation SITES only — `.sheet(isPresented:` / `.sheet(item:` — not a
// modifier's own declaration or a `.sheet` enum case.
const SHEET_RE = /\.(?:sheet|fullScreenCover)\(\s*(?:isPresented|item)\s*:|\.confirmationDialog\(/g
const EVENT_CASE_RE = /^\s*case\s+([a-z]\w*)\(/  // enum case name(payload)
const APPLY_CASE_RE = /case\s+\.([a-z]\w*)(?:\(|:)/g

export function scanSwiftUI(cfg: TargetConfig, repoRoot: string): Target {
  const root = resolveRoot(repoRoot, cfg.root)
  const cap = cfg.cap ?? 600
  const files = walk(root, [".swift"], cfg.ignore).filter((f) => !isTest(f))
  const modules: ModuleInfo[] = []
  for (const file of files) {
    const { text, lines } = read(file)
    const isView = /:\s*View\b/.test(text)
    const m = emptyModule(rel(root, file), lines.length, isView ? "view" : /ObservableObject|@Published/.test(text) ? "state" : "lib")
    let inSocketEvent = false
    for (const l of lines) {
      const t = l.match(TYPE_RE); if (t) { m.exports.push(t[1]!); inSocketEvent = t[1] === "SocketEvent" || t[1] === "WSFrame" }
      const f = l.match(FUNC_RE); if (f && !/^\s{8,}/.test(l)) m.exports.push(`${f[1]}()`)
      if (inSocketEvent) { const ec = l.match(EVENT_CASE_RE); if (ec) m.emits.push(`.${ec[1]}`) }
      if (/^}/.test(l)) inSocketEvent = false
    }
    m.consumes = uniq([...text.matchAll(FRAME_CASE_LINE_RE)].flatMap((x) => [...x[1]!.matchAll(/"([a-z_]+)"/g)].map((y) => y[1]!)))
    // events applied: `case .name` in switch bodies (AppState.apply, socket emit)
    const applied = uniq([...text.matchAll(APPLY_CASE_RE)].map((x) => `.${x[1]}`))
    if (applied.length && !m.path.endsWith("WSFrame.swift")) m.listeners = applied
    m.apiCalls = uniq([...text.matchAll(PATH_RE)].map((x) => x[1]!).filter((p) => p.startsWith("/")))
    m.state = uniq([...text.matchAll(PUBLISHED_RE)].map((x) => `@Published ${x[1]}`))
    m.sheets = [...text.matchAll(SHEET_RE)].length
    m.exports = uniq(m.exports)
    modules.push(m)
  }
  const fanIn = computeFanIn(modules, sourcesOf(root, modules), {
    minLen: 4,
    callRe: (n) => new RegExp(`(?<![\\w.])${n}\\s*[(.<]`),
  })
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
