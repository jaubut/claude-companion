import { emptyModule, uniq, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, resolveImport, computeFanIn, sourcesOf, normalizeCall, identRe, scanExternals } from "./shared"

// React/Vite client: frames consumed (case "x" literals — the renderer keeps
// only those a server emits), HTTP paths called, local imports, exports.
// Fan-in: exports (components, hooks, helpers) reached from 2+ modules —
// a call `name(` or a JSX site `<Name`.

const EXPORT_RE = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/
const CASE_RE = /case\s+"([a-z_]+)"\s*:/g
const TYPE_EQ_RE = /\.type\s*===\s*"([a-z_]+)"/g
const FETCH_RE = /\bfetch\(\s*[`"']([^`"'?]+)/g
// `/api/…` paths built outside fetch() — href, clipboard, window.open — are
// callers too (invoices.tsx builds the public invoice link this way).
const API_LIT_RE = /(\/api\/(?:[A-Za-z0-9_\-.\/]|\$\{[^}]*\})+)/g
const IMPORT_RE = /from\s+"(\.{1,2}\/[^"]+|@\/[^"]+)"/
// Page query parameters. Reader: any module calling `.get("x")` on a receiver
// named *param*/*search* (searchParams, u.searchParams, params) or on an ident
// built from new URLSearchParams( / new URL( / useSearchParams( in the same
// file — so Map.get("x") is not counted. pages/<name>.tsx records
// `/<name>?x` (route = file name); other modules record `?x`, page unknown.
// Setters: a `/page?x=v` string literal, `searchParams.set("x", …)`, or
// `<ident>.set("x", …)` on such an ident — the renderer joins by param name.
// ponytail: route = file name, so a page mounted elsewhere (trip-review at
// /trips/review) shows under its file name; read router.tsx if that misleads.
const QUERY_GET_RE = /(?:\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)|URLSearchParams\([^)]*\))\.get\(\s*"([A-Za-z_]\w*)"\s*\)/g
const QUERY_LIT_RE = /(?:["'`]|\})(\/(?!api\/)[a-z][a-z0-9\-\/]*)\?([A-Za-z_]\w*)=(\$\{|[\w-]*)/g
const QUERY_SET_RE = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.set\(\s*"([A-Za-z_]\w*)"\s*,\s*(?:"([^"]*)")?/g
// `const q = new URLSearchParams(…)`, `const u = new URL(…)`, `const [sp, setSp] = useSearchParams()`
const URL_IDENT_RE = /\b(?:const|let|var)\s+(?:([A-Za-z_$][\w$]*)|\[\s*([A-Za-z_$][\w$]*))[^=]*=\s*(?:new\s+URLSearchParams\(|new\s+URL\(|useSearchParams\()/g

export function scanQuery(m: ModuleInfo, text: string): void {
  const page = m.path.match(/^pages\/([\w-]+)\.tsx$/)?.[1]
  const urlIdents = new Set([...text.matchAll(URL_IDENT_RE)].map((x) => (x[1] ?? x[2])!))
  const isQueryRecv = (recv: string) => /param|search/i.test(recv) || urlIdents.has(recv.split(".")[0]!)
  const reads = uniq([...text.matchAll(QUERY_GET_RE)]
    .filter((x) => x[1] === undefined || isQueryRecv(x[1]))
    .map((x) => `${page ? `/${page}` : ""}?${x[2]}`))
  const sets = uniq([
    ...[...text.matchAll(QUERY_LIT_RE)].map((x) => `${x[1]}?${x[2]}=${x[3] === "${" ? ":p" : x[3]}`),
    ...[...text.matchAll(QUERY_SET_RE)]
      .filter((x) => x[1]!.endsWith("searchParams") || urlIdents.has(x[1]!))
      .map((x) => `?${x[2]}=${x[3] ?? ":p"}`),
  ])
  if (reads.length) m.queryReads = reads
  if (sets.length) m.querySets = sets
}

export function scanReactClient(cfg: TargetConfig, repoRoot: string): Target {
  const root = resolveRoot(repoRoot, cfg.root)
  const cap = cfg.cap ?? 600
  const files = walk(root, [".ts", ".tsx"], cfg.ignore).filter((f) => !isTest(f) && !f.endsWith(".d.ts"))
  const modules: ModuleInfo[] = []
  for (const file of files) {
    const { text, lines } = read(file)
    const m = emptyModule(rel(root, file), lines.length, file.endsWith(".tsx") ? "view" : "lib")
    for (const l of lines) {
      const ex = l.match(EXPORT_RE); if (ex) m.exports.push(ex[1]!)
      const im = l.match(IMPORT_RE); if (im) m.imports.push(resolveImport(file, im[1]!, root))
    }
    scanExternals(m, lines)   // shared scanner: both quote styles, bare specifiers only
    m.consumes = uniq([...text.matchAll(CASE_RE), ...text.matchAll(TYPE_EQ_RE)].map((x) => x[1]!))
    m.apiCalls = uniq([...text.matchAll(FETCH_RE), ...text.matchAll(API_LIT_RE)]
      .map((x) => normalizeCall(x[1]!)).filter((p) => p.startsWith("/") && !p.endsWith("/")))
    scanQuery(m, text)
    m.imports = uniq(m.imports)
    m.exports = uniq(m.exports)
    modules.push(m)
  }
  const fanIn = computeFanIn(modules, sourcesOf(root, modules), {
    requireImport: () => true,
    callRe: (n) => new RegExp(`${identRe(n).source}|<${n}[\\s/>]`),
  })
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
