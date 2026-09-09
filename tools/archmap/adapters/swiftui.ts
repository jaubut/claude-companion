import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { emptyModule, uniq, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, computeFanIn, sourcesOf } from "./shared"

// SwiftUI app: no route grammar, so contracts are read from literals —
// WSFrame `case "x":` (frames decoded), SocketEvent `case name(` (events),
// `case .name` in a handler switch (events applied), `path: "/api/…"` (HTTP
// paths called), `.sheet(isPresented:/item:)` sites, @Published state.
// Fan-in: types and top-level funcs referenced from 2+ files (`Name(`,
// `Name.`, `Name<`).

const TYPE_RE = /^(?:(?:@\w+|public|internal|nonisolated|final|indirect)\s+)*(?:struct|class|enum|actor|protocol)\s+([A-Za-z_]\w*)/
const FUNC_RE = /^\s*(?:(?:@\w+|public|internal|static|class|mutating|nonisolated|override)\s+)*func\s+([A-Za-z_]\w*)\s*\((.*)$/
// The first argument label of a func declaration: `update(timeline id:` →
// "timeline", `contains(_ frame:` → null (unlabeled), `snap()` → "" (no
// parameters). A call is matched on it, so `h.update(data:` and a SwiftUI
// `.frame(width:` stop counting as calls to `update(timeline:)` and
// `frame(atX:)` — the false positives that put IngestEngine among the
// callers of RecordingEngine.update() (Video Assist, 2026-09-09).
function firstLabel(m: RegExpMatchArray): string | null {
  const rest = m[2]!
  if (/^\s*\)/.test(rest)) return ""
  const head = rest.match(/^\s*(?:(_|[A-Za-z_]\w*)\s+)?([A-Za-z_]\w*)\s*:/)
  if (!head) return null                       // parameters on the next line: unknown, stay loose
  if (head[1] === "_") return null
  // a default value on the first parameter lets a call omit it, so the
  // label cannot be required: scan to the first top-level `,` or `)`.
  let depth = 0
  for (const ch of rest) {
    if ("([<{".includes(ch)) depth++
    else if (")]>}".includes(ch)) { if (depth === 0) break; depth-- }
    else if (ch === "," && depth === 0) break
    else if (ch === "=" && depth === 0) return null
  }
  if (!/[,)]/.test(rest)) return null          // first parameter continues on the next line
  return head[1] ?? head[2]!
}
// `case "a", "b":` — every literal on a case line, not just the first.
const FRAME_CASE_LINE_RE = /^\s*case\s+("[a-z_]+"(?:\s*,\s*"[a-z_]+")*)\s*:/gm
const PATH_RE = /path:\s*"([^"?]+)/g
const PUBLISHED_RE = /@Published(?:\s+private\(set\))?\s+var\s+([A-Za-z_]\w*)/g
// presentation SITES only — `.sheet(isPresented:` / `.sheet(item:` — not a
// modifier's own declaration or a `.sheet` enum case.
const SHEET_RE = /\.(?:sheet|fullScreenCover)\(\s*(?:isPresented|item)\s*:|\.confirmationDialog\(/g
const EVENT_CASE_RE = /^\s*case\s+([a-z]\w*)\(/  // enum case name(payload)
const APPLY_CASE_RE = /case\s+\.([a-z]\w*)(?:\(|:)/g
// `import Foo`, `@_exported import Foo`, `import struct Foo.Bar` → Foo
const SWIFT_IMPORT_RE = /^\s*(?:@_exported\s+|@testable\s+)*import\s+(?:(?:struct|class|enum|protocol|typealias|func|var|let)\s+)?([A-Za-z_]\w*)/

// `(?:\\s*timeline\\s*:|\\s*\\))` for the labels a func is declared with; an
// unlabeled overload (null) makes the call loose, as before.
function labelAlternation(set: Set<string | null> | undefined): string {
  if (!set || set.has(null)) return ""
  const alts = [...set].map((l) => (l === "" ? "\\s*\\)" : `\\s*${l}\\s*:`))
  // `addInput(` at the end of a line carries its labels on the next one
  return `(?:${alts.join("|")}|\\s*$)`
}

export function scanSwiftUI(cfg: TargetConfig, repoRoot: string): Target {
  const root = resolveRoot(repoRoot, cfg.root)
  const cap = cfg.cap ?? 600
  const files = walk(root, [".swift"], cfg.ignore).filter((f) => !isTest(f))
  // a module named like a directory under the root (or like the target) is the
  // app's own; everything else — Apple frameworks included — is external
  const local = new Set([cfg.name.toLowerCase(), ...readdirSync(root).filter((e) => statSync(join(root, e)).isDirectory()).map((e) => e.toLowerCase())])
  const modules: ModuleInfo[] = []
  // func name → the first argument labels of its declarations (overloads)
  const labels = new Map<string, Set<string | null>>()
  for (const file of files) {
    const { text, lines } = read(file)
    const isView = /:\s*View\b/.test(text)
    const m = emptyModule(rel(root, file), lines.length, isView ? "view" : /ObservableObject|@Published/.test(text) ? "state" : "lib")
    let inSocketEvent = false
    for (const l of lines) {
      const t = l.match(TYPE_RE); if (t) { m.exports.push(t[1]!); inSocketEvent = t[1] === "SocketEvent" || t[1] === "WSFrame" }
      const f = l.match(FUNC_RE); if (f && !/^\s{8,}/.test(l)) {
        m.exports.push(`${f[1]}()`)
        const set = labels.get(f[1]!) ?? labels.set(f[1]!, new Set()).get(f[1]!)!
        set.add(firstLabel(f))
      }
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
    m.externals = uniq(lines.map((l) => l.match(SWIFT_IMPORT_RE)?.[1]).filter((n): n is string => !!n && !local.has(n.toLowerCase()))).sort()
    m.exports = uniq(m.exports)
    modules.push(m)
  }
  // One module, so no import gate. A func is used as `x.name(` or bare
  // `name(`; a type as `Name(`, `Name.`, `Name<`, `: Name` or `-> Name`.
  // String literals and `//` comments are stripped first — "play.fill" is
  // not a call to play().
  const funcs = new Set(modules.flatMap((m) => m.exports.filter((e) => e.endsWith("()")).map((e) => e.slice(0, -2))))
  const fanIn = computeFanIn(modules, sourcesOf(root, modules), {
    minLen: 4,
    stripLiterals: true,
    callRe: (n) => funcs.has(n)
      ? new RegExp(`(?<![\\w])\\.?${n}\\s*\\(${labelAlternation(labels.get(n))}`)
      : new RegExp(`(?<![\\w.])${n}\\s*[(.<]|[:>]\\s*\\[?${n}\\b`),
  })
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
