import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { emptyModule, uniq, type Endpoint, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, computeFanIn, sourcesOf, stripLiterals } from "./shared"

// SwiftUI app: no route grammar, so contracts are read from literals —
// WSFrame `case "x":` (frames decoded), SocketEvent `case name(` (events),
// `case .name` in a handler switch (events applied), `path: "/api/…"` (HTTP
// paths called), `case ("GET", "/state"):` (routes SERVED by an in-app control
// server), `.sheet(isPresented:/item:)` sites, @Published state.
// Fan-in: types and top-level funcs referenced from 2+ files (`Name(`,
// `Name.`, `Name<`), plus non-private MEMBER PROPERTIES, keyed by their
// declaring type (`Layer.activeEffects`) and matched as `.activeEffects`.

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
// `/api/…` literals passed to a request helper (`req("/api/week/\\($0)")`); an
// interpolation segment becomes `:p`, a query string is dropped.
const API_LIT_RE = /"(\/api\/(?:[A-Za-z0-9_\-.\/]|\\\([^)]*\))+)/g
const PUBLISHED_RE = /@Published(?:\s+private\(set\))?\s+var\s+([A-Za-z_]\w*)/g
// presentation SITES only — `.sheet(isPresented:` / `.sheet(item:` — not a
// modifier's own declaration or a `.sheet` enum case.
const SHEET_RE = /\.(?:sheet|fullScreenCover)\(\s*(?:isPresented|item)\s*:|\.confirmationDialog\(/g
const EVENT_CASE_RE = /^\s*case\s+([a-z]\w*)\(/  // enum case name(payload)
const APPLY_CASE_RE = /case\s+\.([a-z]\w*)(?:\(|:)/g
// `import Foo`, `@_exported import Foo`, `import struct Foo.Bar` → Foo
const SWIFT_IMPORT_RE = /^\s*(?:@_exported\s+|@testable\s+)*import\s+(?:(?:struct|class|enum|protocol|typealias|func|var|let)\s+)?([A-Za-z_]\w*)/

// --- Routes served in-app ----------------------------------------------------
// A Swift control server has no route DSL; it switches over (method, path):
//   switch (method, path) { case ("GET", "/state"): … case ("POST", "/a"), ("POST", "/b"): … }
// The whole case line is matched, then every tuple on it (same reason the
// frame `case` scan matches the line: a single-tuple regex drops the rest).
const ROUTE_CASE_LINE_RE = /^[ \t]*case\s+(\(\s*"[A-Z]+"\s*,\s*"\/[^"]*"\s*\)(?:\s*,\s*\(\s*"[A-Z]+"\s*,\s*"\/[^"]*"\s*\))*)\s*:/gm
const ROUTE_TUPLE_RE = /\(\s*"([A-Z]+)"\s*,\s*"(\/[^"]*)"\s*\)/g

// --- Member properties -------------------------------------------------------
// `var`/`let` at TYPE-MEMBER scope (brace depth == the type's member depth), so
// locals inside a func or a closure never count. `private`/`fileprivate` are
// skipped, `private(set)` is not (it is readable everywhere). Names under 4
// characters and protocol/stdlib members are dropped: `.id` and `.body` say
// nothing about who reaches whom and match half the repo.
const MODIFIER = String.raw`(?:@[\w.]+(?:\([^()]*\))?|public|internal|open|package|private\(set\)|fileprivate\(set\)|private|fileprivate|static|class|final|lazy|weak|unowned(?:\([^()]*\))?|nonisolated(?:\([^()]*\))?|override|dynamic|mutating|distributed)`
const PROP_RE = new RegExp(String.raw`^\s*((?:${MODIFIER}\s+)*)(?:var|let)\s+([A-Za-z_]\w*)`)
const PRIVATE_RE = /(?:^|\s)(?:private|fileprivate)\s/
const SCOPE_TYPE_RE = new RegExp(String.raw`^\s*(?:${MODIFIER}\s+)*(?:struct|class|enum|actor|protocol|extension)\s+([A-Za-z_]\w*)`)
const PROP_MIN_LEN = 4
const PROP_DENY = new Set([
  // protocol conformance — every View has a `body`, every RawRepresentable a `rawValue`
  "body", "description", "debugDescription", "localizedDescription", "errorDescription",
  "rawValue", "hashValue", "allCases", "wrappedValue", "projectedValue", "animatableData",
  // stdlib collection members: `.count` on our own type would match every array
  "count", "first", "last", "isEmpty", "indices", "startIndex", "endIndex", "keys", "values", "capacity",
])

// Non-Swift files that call the in-app control server (an MCP server, a Stream
// Deck plugin). They join the map ONLY as endpoint callers: a file is kept when
// it quotes a path the app actually serves, so a build script or a fixture with
// a `/tmp/...` literal stays out. One over the target's cap is a bundle, not a
// caller — the Stream Deck plugin ships a 17k-line esbuild copy of its own
// 48-line source next to it — so the cap drops it and no tool file can trip the
// cap lint. Externals are left empty on purpose: their npm/pip deps are pinned
// by their own lockfile, not the app's.
const TOOL_EXTS = [".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".rb"]
const TOOL_PATH_RE = /["'`](\/[A-Za-z0-9_\-./]*)["'`]/g

// `(?:\\s*timeline\\s*:|\\s*\\))` for the labels a func is declared with; an
// unlabeled overload (null) makes the call loose, as before.
function labelAlternation(set: Set<string | null> | undefined): string {
  if (!set || set.has(null)) return ""
  const alts = [...set].map((l) => (l === "" ? "\\s*\\)" : `\\s*${l}\\s*:`))
  // `addInput(` at the end of a line carries its labels on the next one
  return `(?:${alts.join("|")}|\\s*$)`
}

function lowerFirst(s: string): string {
  return s[0]!.toLowerCase() + s.slice(1)
}

// Type names a piece of source mentions, so `.activeEffects` can be tied to
// Layer. An identifier that STARTS UPPERCASE is one name — `MemoryLayout` is
// not a mention of `Layout`, which is what made every `MemoryLayout<T>.size`
// look like a read of `Layout.size`. A lowercase-initial identifier is a
// variable, so each of its camel segments counts, singular or plural:
// `layers`, `videoLayer`, `layerStack` all mention `Layer`.
function typeMentions(text: string): Set<string> {
  const out = new Set<string>()
  for (const id of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (/^[A-Z]/.test(id)) { out.add(id); continue }
    // the whole name (`inputManager` → InputManager) and each segment
    // (`videoLayer` → Video, Layer), singular or plural
    for (const seg of [id, ...id.split(/(?=[A-Z])/)]) {
      const s = seg[0]!.toUpperCase() + seg.slice(1)
      out.add(s)
      if (/e?s$/.test(s)) out.add(s.replace(/e?s$/, ""))
    }
  }
  return out
}

// Members of a type declared in this file, in declaration order. Returns
// `["Layer.activeEffects", …]`; the brace depth is tracked on literal-stripped
// lines so `{` inside a string or a `"""` block cannot shift the scope.
function memberProperties(lines: string[]): string[] {
  const out: string[] = []
  const stack: { name: string; memberDepth: number }[] = []
  let depth = 0
  let inMultiline = false
  for (const raw of lines) {
    const quotes = (raw.match(/"""/g) ?? []).length
    if (inMultiline) { if (quotes % 2 === 1) inMultiline = false; continue }
    if (quotes % 2 === 1) { inMultiline = true; continue }
    const code = stripLiterals(raw)
    const opens = (code.match(/\{/g) ?? []).length
    const closes = (code.match(/\}/g) ?? []).length
    const type = code.match(SCOPE_TYPE_RE)
    if (type && opens > 0) {
      stack.push({ name: type[1]!, memberDepth: depth + 1 })
    } else if (stack.length && depth === stack[stack.length - 1]!.memberDepth) {
      const p = code.match(PROP_RE)
      if (p && !PRIVATE_RE.test(` ${p[1]!}`) && p[2]!.length >= PROP_MIN_LEN && !PROP_DENY.has(p[2]!)) {
        out.push(`${stack[stack.length - 1]!.name}.${p[2]}`)
      }
    }
    depth += opens - closes
    while (stack.length && depth < stack[stack.length - 1]!.memberDepth) stack.pop()
  }
  return out
}

function routesOf(text: string): Endpoint[] {
  const out: Endpoint[] = []
  for (const line of text.matchAll(ROUTE_CASE_LINE_RE)) {
    for (const t of line[1]!.matchAll(ROUTE_TUPLE_RE)) {
      const key = `${t[1]} ${t[2]}`
      if (!out.some((e) => `${e.method} ${e.path}` === key)) out.push({ method: t[1]!, path: t[2]!, prefix: false })
    }
  }
  return out
}

export function scanSwiftUI(cfg: TargetConfig, repoRoot: string): Target {
  const root = resolveRoot(repoRoot, cfg.root)
  const cap = cfg.cap ?? 600
  const all = walk(root, [".swift", ...TOOL_EXTS], cfg.ignore).filter((f) => !isTest(f))
  const files = all.filter((f) => f.endsWith(".swift"))
  // a module named like a directory under the root (or like the target) is the
  // app's own; everything else — Apple frameworks included — is external
  const local = new Set([cfg.name.toLowerCase(), ...readdirSync(root).filter((e) => statSync(join(root, e)).isDirectory()).map((e) => e.toLowerCase())])
  const modules: ModuleInfo[] = []
  const texts = new Map<string, string>()
  // func name → the first argument labels of its declarations (overloads)
  const labels = new Map<string, Set<string | null>>()
  // "Layer.activeEffects" → "Layer" — the type a property hangs off, used to
  // require the caller to mention it
  const propOwner = new Map<string, string>()
  // bare property name → the types declaring it; 2+ means `.name` cannot say
  // whose, so those keys are matched by the stricter line gate below
  const propTypes = new Map<string, Set<string>>()
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
    for (const key of memberProperties(lines)) {
      const dot = key.indexOf(".")
      const type = key.slice(0, dot), name = key.slice(dot + 1)
      m.exports.push(key)
      propOwner.set(key, type)
      ;(propTypes.get(name) ?? propTypes.set(name, new Set()).get(name)!).add(type)
    }
    m.consumes = uniq([...text.matchAll(FRAME_CASE_LINE_RE)].flatMap((x) => [...x[1]!.matchAll(/"([a-z_]+)"/g)].map((y) => y[1]!)))
    // events applied: `case .name` in switch bodies (AppState.apply, socket emit)
    const applied = uniq([...text.matchAll(APPLY_CASE_RE)].map((x) => `.${x[1]}`))
    if (applied.length && !m.path.endsWith("WSFrame.swift")) m.listeners = applied
    m.apiCalls = uniq([...[...text.matchAll(PATH_RE)].map((x) => x[1]!), ...[...text.matchAll(API_LIT_RE)].map((x) => x[1]!.replace(/\\\([^)]*\)/g, ":p"))]
      .filter((p) => p.startsWith("/") && !p.endsWith("/")))
    m.state = uniq([...text.matchAll(PUBLISHED_RE)].map((x) => `@Published ${x[1]}`))
    m.sheets = [...text.matchAll(SHEET_RE)].length
    m.endpoints = routesOf(text)
    if (m.endpoints.length && m.kind === "lib") m.kind = "route-host"
    m.externals = uniq(lines.map((l) => l.match(SWIFT_IMPORT_RE)?.[1]).filter((n): n is string => !!n && !local.has(n.toLowerCase()))).sort()
    m.exports = uniq(m.exports)
    texts.set(m.path, text)
    modules.push(m)
  }
  // One module, so no import gate. A func is used as `x.name(` or bare
  // `name(`; a type as `Name(`, `Name.`, `Name<`, `: Name` or `-> Name`; a
  // member property as `.name` (the qualified key is never written literally,
  // so the prefilter runs on the bare property name and `accept` below decides
  // whether the hit really reaches that type). String literals and `//`
  // comments are stripped first — "play.fill" is not a call to play().
  const funcs = new Set(modules.flatMap((m) => m.exports.filter((e) => e.endsWith("()")).map((e) => e.slice(0, -2))))
  const prop = (n: string) => (propOwner.has(n) ? n.slice(n.indexOf(".") + 1) : null)
  const accessRe = new Map<string, RegExp>()
  const access = (p: string) => accessRe.get(p) ?? accessRe.set(p, new RegExp(`\\.\\s*${p}(?![\\w])`, "g")).get(p)!
  const fileMentions = new Map(modules.map((m) => [m.path, typeMentions(texts.get(m.path) ?? "")]))
  // a property whose own name names its type (`Take.take`) would satisfy any
  // gate from its own accesses: the line has to spell the type out instead
  const selfNamedCache = new Map<string, boolean>()
  const selfNamed = (p: string, owner: string) => {
    const k = `${owner}.${p}`
    return selfNamedCache.get(k) ?? selfNamedCache.set(k, typeMentions(p).has(owner)).get(k)!
  }
  const exactRe = new Map<string, RegExp>()
  const exact = (t: string) => exactRe.get(t) ?? exactRe.set(t, new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`)).get(t)!
  const fanIn = computeFanIn(modules, sourcesOf(root, modules), {
    minLen: 4,
    stripLiterals: true,
    callRe: (n) => {
      const p = prop(n)
      if (p) return new RegExp(`\\.\\s*${p}(?![\\w])`)
      return funcs.has(n)
        ? new RegExp(`(?<![\\w])\\.?${n}\\s*\\(${labelAlternation(labels.get(n))}`)
        : new RegExp(`(?<![\\w.])${n}\\s*[(.<]|[:>]\\s*\\[?${n}\\b`)
    },
    needles: (n) => {
      const p = prop(n)
      return p ? [p] : uniq([n, lowerFirst(n), n.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()])
    },
    // The declaring type has to show up for a `.name` hit to count. A property
    // name unique in the target only needs it somewhere in the caller's FILE
    // (`layers.first?.activeEffects` reaches Layer through a chain that never
    // names it). A name several types declare — `name`, `width`, `icon` —
    // needs it on the LINE, or the row would guess whose property it is.
    // The accesses themselves are cut out first: in `slate.take` the word
    // `take` is the property, not a mention of the type `Take`.
    accept: (n, caller, line) => {
      const owner = propOwner.get(n)
      if (!owner) return true
      const p = prop(n)!
      const rest = line.replace(access(p), " ")
      if (selfNamed(p, owner)) return exact(owner).test(rest)
      if ((propTypes.get(p)?.size ?? 0) > 1) return typeMentions(rest).has(owner)
      return fileMentions.get(caller.path)?.has(owner) ?? false
    },
  })
  // Non-Swift callers of the in-app routes, appended after fan-in so they are
  // never scanned for Swift symbols.
  const served = new Set(modules.flatMap((m) => m.endpoints.map((e) => e.path)))
  if (served.size) {
    for (const file of all.filter((f) => !f.endsWith(".swift"))) {
      const { text, lines } = read(file)
      const calls = uniq([...text.matchAll(TOOL_PATH_RE)].map((x) => x[1]!).filter((p) => served.has(p)))
      if (!calls.length || lines.length > cap) continue
      const m = emptyModule(rel(root, file), lines.length, "tool")
      m.apiCalls = calls
      modules.push(m)
    }
  }
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
