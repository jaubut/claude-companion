import { dirname } from "node:path"
import { emptyModule, uniq, type Endpoint, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, scanTsBasics, computeFanIn, sourcesOf, scanExternals, normalizeCall } from "./shared"

// Bun.serve server: one or more route hosts (fetch handlers switching on
// url.pathname) plus lib modules. Contracts recorded per module: exports,
// module-level state, WS frames emitted, endpoints, imports, top-level
// listener registrations. Fan-in is computed across the target: for every
// export, which other modules use it (and import its owner).

const ENDPOINT_RE = /url\.pathname(?:\s*===\s*|\.startsWith\()"([^"]+)"\)?(?:\s*&&\s*req\.method\s*===\s*"([A-Z]+)")?/g
const ROUTE_RE = /url\.pathname(?:\s*===\s*|\.startsWith\()"([^"]+)"\)?(?:\s*&&\s*req\.method\s*===\s*"([A-Z]+)")?/
const FRAME_RE = /type:\s*"([a-z_]+)"/g
// Bun ≥1.2 native routing: `Bun.serve({ routes: { "/api/x": handler, "/api/y": { GET: …, POST: … } } })`.
// A route key opens a method object when its value is `{`; method keys inside
// it (deeper indent) are the methods, the matching `}` closes it.
const ROUTES_KEY_RE = /^(\s*)"(\/[^"]*)":\s*(.*)$/
const PACKED_KEY_RE = /,\s*"(\/[^"]*)":/g
const METHOD_KEY_RE = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):/
// Static pages served by the host (public/index.html) are callers of its routes.
const HTML_FETCH_RE = /\bfetch\(\s*[`"']([^`"'?]+)[`"']?(\s*\+)?/g
const HTML_API_LIT_RE = /["'`](\/api\/(?:[A-Za-z0-9_\-.\/]|\$\{[^}]*\})+)/g

export function frameEmits(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (!/\b(broadcast|ws\.send|\.send)\(/.test(l)) continue
    // the type literal is on this line or within the next 3 (multi-line object)
    for (let j = i; j < Math.min(lines.length, i + 4); j++) {
      for (const m of lines[j]!.matchAll(FRAME_RE)) out.push(m[1]!)
      if (/\)\s*;?\s*$/.test(lines[j]!) && j > i) break
    }
  }
  return uniq(out)
}

function servedRoutes(lines: string[]): Endpoint[] {
  const out: Endpoint[] = []
  let obj: { path: string; indent: number } | null = null
  for (const l of lines) {
    if (obj) {
      const mk = l.match(METHOD_KEY_RE)
      if (mk && l.search(/\S/) > obj.indent) { out.push({ method: mk[1]!, path: obj.path, prefix: false }); continue }
      if (/^\s*}/.test(l) && l.search(/\S/) === obj.indent) { obj = null; continue }
    }
    const rk = l.match(ROUTES_KEY_RE)
    if (!rk) continue
    if (/^\{\s*$/.test(rk[3]!)) obj = { path: rk[2]!, indent: rk[1]!.length }
    else {
      out.push({ method: "*", path: rk[2]!, prefix: false })
      // several short routes packed on one line: `"/a.css": asset("a.css"), "/a.js": asset("a.js")`
      for (const more of rk[3]!.matchAll(PACKED_KEY_RE)) out.push({ method: "*", path: more[1]!, prefix: false })
    }
  }
  return out
}

function endpoints(text: string, lines: string[]): Endpoint[] {
  const out: Endpoint[] = []
  for (const m of text.matchAll(ENDPOINT_RE)) {
    out.push({ method: m[2] ?? "*", path: m[1]!, prefix: m[0].includes("startsWith") })
  }
  if (/\bBun\.serve\(/.test(text) && /\broutes:\s*\{/.test(text)) out.push(...servedRoutes(lines))
  const seen = new Set<string>()
  return out.filter((e) => { const k = `${e.method} ${e.path}`; if (seen.has(k)) return false; seen.add(k); return true })
}

export function scanBunServer(cfg: TargetConfig, repoRoot: string): Target {
  const root = resolveRoot(repoRoot, cfg.root)
  const cap = cfg.cap ?? 600
  const files = walk(root, [".ts"], cfg.ignore).filter((f) => !isTest(f))
  const modules: ModuleInfo[] = []
  for (const file of files) {
    const { text, lines } = read(file)
    const eps = endpoints(text, lines)
    const m = emptyModule(rel(root, file), lines.length, eps.length ? "route-host" : "lib")
    scanTsBasics(m, file, lines, root)
    scanExternals(m, lines)
    m.emits = frameEmits(lines)
    m.endpoints = eps
    m.imports = uniq(m.imports)
    m.listeners = uniq(m.listeners)
    modules.push(m)
  }
  // Inside a route host the caller is the ROUTE (nearest preceding
  // `url.pathname` match), not the file — so two hooks reaching one lib
  // function show up as two callers. That is the bug class this map exposes.
  const route = new Map<string, string>()
  const fanIn = computeFanIn(modules, sourcesOf(root, modules), {
    requireImport: () => true,
    label: (m, l) => {
      const r = l.match(ROUTE_RE)
      if (r) route.set(m.path, `${r[2] ?? "*"} ${r[1]}`)
      const rk = m.kind === "route-host" ? l.match(ROUTES_KEY_RE) : null
      if (rk) route.set(m.path, `* ${rk[2]}`)
      const cur = route.get(m.path)
      return m.kind === "route-host" && cur ? `${m.path}#${cur}` : m.path
    },
  })
  // HTML pages (and their scripts) under the root call the routes; appended after fan-in so they
  // are never scanned for TS symbols. `"/api/week/" + id` → `/api/week/:p`.
  // Classic scripts beside a page (public/app.js next to public/index.html)
  // are the same client split into files — callers too.
  const pages = walk(root, [".html"], cfg.ignore)
  const pageDirs = new Set(pages.map((f) => dirname(f)))
  const scripts = walk(root, [".js"], cfg.ignore).filter((f) => pageDirs.has(dirname(f)))
  for (const file of [...pages, ...scripts]) {
    const { text, lines } = read(file)
    const calls = [...text.matchAll(HTML_FETCH_RE)].map((x) => normalizeCall(x[2] && x[1]!.endsWith("/") ? `${x[1]}:p` : x[1]!))
    for (const x of text.matchAll(HTML_API_LIT_RE)) calls.push(normalizeCall(x[1]!))
    const m = emptyModule(rel(root, file), lines.length, "view")
    m.apiCalls = uniq(calls.filter((p) => p.startsWith("/") && !p.endsWith("/")))
    if (m.apiCalls.length) modules.push(m)
  }
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
