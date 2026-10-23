import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import { emptyModule, uniq, type Endpoint, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, resolveImport, computeFanIn, sourcesOf, normalizeCall, scanTsBasics, identRe, scanExternals } from "./shared"

// Astro site (islands: React .tsx next to .astro). The file system under
// src/pages IS the router: .astro/.md/.mdx → PAGE routes, .ts/.js → endpoints
// whose methods are the exported `GET`/`POST`/… handlers (`ALL` → *).
// Nothing is auto-imported, so fan-in counts importers only: components are
// reached by `<Name` (default import named after the file), lib exports by
// use. Components also carry their declared props, so a props change lists
// every importer that passes them.

const DIRS = ["pages", "components", "layouts", "lib", "styles"]
const EXTS = [".astro", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".md", ".mdx", ".css"]
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"]
const METHOD_RE = new RegExp(`^export\\s+(?:async\\s+)?(?:const|function|let)\\s+(${METHODS.join("|")})\\b`)
// group 2 = string concatenation follows (`fetch("/api/" + x)`): a prefix, not a URL
const FETCH_RE = /\bfetch\(\s*[`"']([^`"'?]+)([`"'?]\s*\+)?/g
// `/api/…` built outside fetch() — form actions, hrefs — are callers too
const API_LIT_RE = /(\/api\/(?:[A-Za-z0-9_\-.\/]|\$\{[^}]*\})+)/g
// side-effect imports (`import '@/styles/paper.css'`) — shared IMPORT_RE wants `from`
const BARE_IMPORT_RE = /^\s*import\s+["'](\.{1,2}\/[^"']+|[~@]\/[^"']+)["']/
// `export { Button, x as Y }` — declared first, exported by list
const EXPORT_LIST_RE = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/
const DEFAULT_EXPORT_RE = /^\s*export\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+)?([A-Za-z_$][\w$]*)/
const PROPS_DECL_RE = /^\s*(?:export\s+)?(?:interface\s+\w*Props\b[^{]*|type\s+\w*Props\s*=\s*)\{/

function route(relPath: string): Endpoint | null {
  const segs = relPath.replace(/\.(astro|mdx?|[cm]?[tj]sx?)$/, "").split("/")
  if (segs.some((s) => s.startsWith("_"))) return null   // underscore = excluded from routing
  if (segs[segs.length - 1] === "index") segs.pop()   // only a terminal index is the dir's route
  // `[id].json` / `post-[id]` are params inside a segment, not literals. A param directly followed
  // by a name char keeps its brackets: `[id]-edit` as `:id-edit` would read as one `[id-edit]` param.
  const parts = segs.map((s) => s.replace(/^\[\.\.\.[\w-]+\]$/, "*").replace(/\[([\w-]+)\](?![\w-])/g, ":$1"))
  const path = ("/" + parts.join("/")).replace(/\/$/, "") || "/"
  return path.endsWith("*") ? { method: "", path: path.replace(/\*$/, ""), prefix: true } : { method: "", path, prefix: false }
}

// Member names at depth 1 of the first `{ … }` from line `from` on — one
// per line or `;`/`,`-separated on one line; nested types are skipped.
function blockKeys(lines: string[], from: number): string[] {
  const text = lines.slice(from).join("\n")
  const keys: string[] = []
  let depth = 1
  let buf = ""
  const flush = (): void => { const k = buf.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/); if (k) keys.push(k[1]!); buf = "" }
  for (const ch of text.slice(text.indexOf("{") + 1)) {
    if ("{([".includes(ch)) depth++
    else if ("})]".includes(ch)) { depth--; if (depth === 0) { flush(); break } }
    else if (depth === 1 && ";,\n".includes(ch)) flush()
    else if (depth === 1) buf += ch
  }
  return keys
}

// `interface Props { … }` (Astro convention, also `XProps` in .tsx), else the
// destructured first parameter of the default-exported (or `name`-exported) component.
function componentProps(text: string, lines: string[], name: string): string[] {
  const decl = lines.findIndex((l) => PROPS_DECL_RE.test(l))
  if (decl >= 0) return blockKeys(lines, decl)
  const fn = text.match(new RegExp(`(?:export\\s+default\\s+function\\s+\\w*|(?:export\\s+)?function\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})\\s*\\(\\s*\\{([^}]*)\\}`))
  if (!fn) return []
  return fn[1]!.split(",").map((p) => p.trim().match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)/)?.[1] ?? "").filter(Boolean)
}

// Fan-in matches by name, so each importer's local bindings are rewritten to
// the owner's key first: a default import of Header.astro bound as SiteHeader,
// or `{ formatPrice as money }`, make `<SiteHeader`/`money(` read as
// `<Header`/`formatPrice(`. Components sharing a file name get a path key
// (`components/admin/Header`, `components/Header.tsx` when only the extension
// differs) so neither loses its consumers.
const IMPORT_BINDINGS_RE = /\bimport\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}\s*)?from\s+["'](\.{1,2}\/[^"']+|[~@]\/[^"']+)["']/g
function componentKeys(modules: ModuleInfo[], src: string, root: string): Map<string, string> {
  const comps = modules.filter((m) => m.props)
  const base = (m: ModuleInfo): string => m.component!
  const count = new Map<string, number>()
  for (const m of comps) count.set(base(m), (count.get(base(m)) ?? 0) + 1)
  const dirKey = (m: ModuleInfo): string => rel(src, join(root, m.path)).replace(/\.[^.]+$/, "")
  const dirCount = new Map<string, number>()
  for (const m of comps) dirCount.set(dirKey(m), (dirCount.get(dirKey(m)) ?? 0) + 1)
  // Header.astro + Header.tsx in one dir: only the extension tells them apart
  const key = (m: ModuleInfo): string => count.get(base(m))! === 1 ? base(m) : dirCount.get(dirKey(m))! > 1 ? rel(src, join(root, m.path)) : dirKey(m)
  return new Map(comps.map((m) => [m.path, key(m)]))
}
// `import * as utils from "…"`: `utils.formatPrice(` is a use of `formatPrice`
const NS_IMPORT_RE = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+["'](?:\.{1,2}\/[^"']+|[~@]\/[^"']+)["']/g
function unaliased(modules: ModuleInfo[], sources: Map<string, string[]>, keys: Map<string, string>, defaults: Map<string, string>, root: string, src: string): Map<string, string[]> {
  const names = new Map(modules.filter((m) => m.component).map((m) => [m.path, m.component!]))
  for (const m of modules) {
    const file = join(root, m.path)
    const renames: [string, string][] = []
    for (const im of sources.get(m.path)!.join("\n").matchAll(IMPORT_BINDINGS_RE)) {
      const target = resolveImport(file, im[3]!, root, src)
      const key = keys.get(target)
      // a default import binds the component key, or a lib's `export default function formatPrice`
      const binds: [string, string][] = im[1] ? [[im[1], key ?? defaults.get(target) ?? ""]] : []
      for (const b of (im[2] ?? "").split(",")) {
        const n = b.trim().replace(/^type\s+/, "").match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
        if (n) binds.push([n[2] ?? n[1]!, key && n[1] === names.get(target) ? key : n[1]!])
      }
      for (const [local, owner] of binds) if (owner && local !== owner) renames.push([local, owner])
    }
    if (renames.length) {
      // one pass: a rewritten owner key (`components/admin/Header`) must not be renamed again
      const owners = new Map(renames)
      const re = new RegExp([...owners.keys()].map((l) => identRe(l).source).join("|"), "g")
      sources.set(m.path, sources.get(m.path)!.map((l) => l.replace(re, (x) => owners.get(x) ?? x)))
    }
    const ns = [...sources.get(m.path)!.join("\n").matchAll(NS_IMPORT_RE)].map((x) => x[1]!.replace(/\$/g, "\\$"))
    if (ns.length) {
      const re = new RegExp(`(?<![\\w$.])(?:${ns.join("|")})\\.(?=[A-Za-z_$])`, "g")
      sources.set(m.path, sources.get(m.path)!.map((l) => l.replace(re, "")))
    }
  }
  return sources
}

export function scanAstro(cfg: TargetConfig, repoRoot: string): Target {
  const root = resolveRoot(repoRoot, cfg.root)
  const cap = cfg.cap ?? 600
  const src = existsSync(join(root, "src")) ? join(root, "src") : root
  const files: string[] = []
  for (const d of DIRS) if (existsSync(join(src, d))) files.push(...walk(join(src, d), EXTS, cfg.ignore))
  const modules: ModuleInfo[] = []
  const defaults = new Map<string, string>()
  for (const file of uniq(files).sort()) {
    if (isTest(file) || file.endsWith(".d.ts")) continue
    const { text, lines } = read(file)
    const path = rel(root, file)
    const inSrc = rel(src, file)
    const top = inSrc.split("/")[0]!
    const isAstro = file.endsWith(".astro")
    const m = emptyModule(path, lines.length, top.replace(/s$/, ""))
    if (!/\.(css|md)$/.test(file)) {   // .md has no ESM; fenced `import` lines are prose
      scanTsBasics(m, file, lines, root, src)
      scanExternals(m, lines)
      m.externals = (m.externals ?? []).filter((s) => !s.startsWith("astro:"))   // virtual modules
    }
    for (const l of lines) {
      const im = l.match(BARE_IMPORT_RE); if (im) m.imports.push(resolveImport(file, im[1]!, root, src))
      const ex = l.match(EXPORT_LIST_RE)
      if (ex) for (const b of ex[1]!.split(",")) { const n = b.trim().replace(/^type\s+/, "").match(/([A-Za-z_$][\w$]*)$/); if (n && n[1] !== "default") m.exports.push(n[1]!) }
    }
    const def = lines.map((l) => l.match(DEFAULT_EXPORT_RE)?.[1]).find((n) => n && m.exports.includes(n))
    if (def) defaults.set(path, def)
    // frontmatter `let` runs per render, not per module
    if (isAstro) { m.state = []; m.listeners = [] }
    if (top === "pages") {
      const r = route(inSrc.slice("pages/".length))
      const isPage = /\.(astro|mdx?)$/.test(file)
      m.kind = !r ? "page-partial" : isPage ? "page" : inSrc.startsWith("pages/api/") ? "api" : "endpoint"
      if (r && isPage) m.endpoints.push({ ...r, method: "PAGE" })
      else if (r) {
        const methods = uniq(lines.map((l) => l.match(METHOD_RE)?.[1] ?? "").filter(Boolean))
        for (const meth of methods.length ? methods : ["ALL"]) m.endpoints.push({ ...r, method: meth === "ALL" ? "*" : meth })
      }
      m.exports = []   // prerender / getStaticPaths / method handlers are framework hooks, not contracts
    } else if (top === "components" || top === "layouts") {
      // `ui/badge.tsx` (shadcn) is used as <Badge>: a non-.astro file's matching PascalCase export names it
      const stem = basename(file).replace(/\.[^.]+$/, "")
      const name = isAstro ? stem : m.exports.find((x) => /^[A-Z]/.test(x) && x.toLowerCase() === stem.replace(/-/g, "").toLowerCase()) ?? stem
      if (isAstro || !m.exports.includes(name)) m.exports.unshift(name)
      m.component = name
      if (/\.(astro|[jt]sx)$/.test(file)) m.props = componentProps(text, lines, name)
    }
    const own = m.endpoints.map((e) => e.path)
    // a full fetch URL with a trailing slash (`/api/data/`) is the `/api/data` route; bare `/api/…/`
    // literals elsewhere are mostly prefix checks (`startsWith("/api/")`), so those stay dropped
    const fetched = [...text.matchAll(FETCH_RE)].filter((x) => !x[2]).map((x) => normalizeCall(x[1]!).replace(/(.)\/$/, "$1"))
    m.apiCalls = uniq([...fetched, ...[...text.matchAll(API_LIT_RE)].map((x) => normalizeCall(x[1]!))]
      .filter((p) => p.startsWith("/") && !p.endsWith("/") && !own.includes(p)))
    m.imports = uniq(m.imports)
    m.exports = uniq(m.exports)
    modules.push(m)
  }
  const keys = componentKeys(modules, src, root)
  const sources = unaliased(modules, sourcesOf(root, modules), keys, defaults, root, src)
  for (const [path, k] of keys) { const m = modules.find((x) => x.path === path)!; m.exports = m.exports.map((x) => x === m.component ? k : x); m.component = k }
  const fanIn = computeFanIn(modules, sources, {
    minLen: 1,   // every use needs an import of the owner, so short names (`cn`) are safe to count
    requireImport: () => true,
    callRe: (n) => new RegExp(`${identRe(n).source}|<${n}[\\s/>]`),
  })
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
