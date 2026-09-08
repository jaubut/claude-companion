import { emptyModule, uniq, type Endpoint, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, resolveImport, scanTsBasics, computeFanIn, sourcesOf, scanExternals } from "./shared"
import { frameEmits } from "./bun-server"

// Hono server: routers (`const router = new Hono()` + `.get("/path", …)`)
// mounted by hosts (`app.route("/api", router)`). Endpoints are recorded with
// their EFFECTIVE path — mount prefix + declared path — so a client call to
// `/api/time/status` joins the handler that declared `/time/status`.
// Routers nobody mounts are flagged `router-unmounted`. Fan-in is route-scoped
// like bun-server: the caller is the nearest preceding route declaration.

const ROUTE_RE = /\.(get|post|put|delete|patch|all)\(\s*["'`](\/[^"'`]*)/g
const ROUTE_LINE_RE = /\.(get|post|put|delete|patch|all)\(\s*["'`](\/[^"'`]*)/
const ON_RE = /\.on\(\s*["']([A-Z]+)["']\s*,\s*["'`](\/[^"'`]*)/g
const USE_RE = /\.use\(\s*["'`](\/[^"'`]*)/g
const MOUNT_RE = /\.route\(\s*["'`]([^"'`]*)["'`]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g
const DEFAULT_IMPORT_RE = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/
const NAMED_IMPORT_RE = /^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/

// "/api" + "/" → "/api"; "" + "/x" → "/x"; "/api" + "/files/" keeps its prefix slash
function joinPath(prefix: string, path: string): string {
  const joined = (prefix.replace(/\/$/, "") + path).replace(/\/{2,}/g, "/")
  if (joined === "" || joined === "/") return "/"
  return path === "/" ? joined.replace(/\/$/, "") : joined
}

// `:id{.+}` → `:id` (Hono's inline param regex adds nothing to the contract)
function cleanPath(p: string): string {
  return p.replace(/(:\w+)\{[^}]*\}/g, "$1")
}

function declared(text: string): Endpoint[] {
  const out: Endpoint[] = []
  for (const m of text.matchAll(ROUTE_RE)) out.push({ method: m[1] === "all" ? "*" : m[1]!.toUpperCase(), path: cleanPath(m[2]!), prefix: false })
  for (const m of text.matchAll(ON_RE)) out.push({ method: m[1]!, path: cleanPath(m[2]!), prefix: false })
  return out.map((e) => e.path.endsWith("*") ? { ...e, path: e.path.replace(/\*$/, ""), prefix: true } : e)
}

export function scanHonoServer(cfg: TargetConfig, repoRoot: string): Target {
  const root = resolveRoot(repoRoot, cfg.root)
  const cap = cfg.cap ?? 600
  const files = walk(root, [".ts"], cfg.ignore).filter((f) => !isTest(f) && !f.endsWith(".d.ts"))
  const modules: ModuleInfo[] = []
  const decl = new Map<string, Endpoint[]>()
  // mounts: host module → [{ prefix, child module }]
  const mounts = new Map<string, { prefix: string; child: string }[]>()
  for (const file of files) {
    const { text, lines } = read(file)
    const path = rel(root, file)
    const m = emptyModule(path, lines.length, "lib")
    scanTsBasics(m, file, lines, root)
    scanExternals(m, lines)
    const isRouter = /new\s+Hono\b/.test(text)
    const imported = new Map<string, string>()
    for (const l of lines) {
      const d = l.match(DEFAULT_IMPORT_RE); if (d) imported.set(d[1]!, resolveImport(file, d[2]!, root))
      const n = l.match(NAMED_IMPORT_RE)
      if (n) for (const name of n[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean)) imported.set(name, resolveImport(file, n[2]!, root))
    }
    const here: { prefix: string; child: string }[] = []
    for (const mt of text.matchAll(MOUNT_RE)) {
      const child = imported.get(mt[2]!)
      if (child) here.push({ prefix: mt[1]!, child })
    }
    if (here.length) mounts.set(path, here)
    m.kind = here.length ? "host" : isRouter ? "router" : "lib"
    decl.set(path, declared(text))
    for (const u of text.matchAll(USE_RE)) m.listeners.push(`use ${u[1]}`)
    m.emits = frameEmits(lines)
    m.imports = uniq(m.imports)
    m.listeners = uniq(m.listeners)
    modules.push(m)
  }
  // effective prefixes: a module mounted nowhere serves at "" (a host, or an
  // orphan router); a mounted one inherits every path its hosts are reached by.
  const mountedBy = new Map<string, { host: string; prefix: string }[]>()
  for (const [host, list] of mounts) for (const { prefix, child } of list) (mountedBy.get(child) ?? mountedBy.set(child, []).get(child)!).push({ host, prefix })
  const prefixesOf = (path: string, depth = 0): string[] => {
    const parents = mountedBy.get(path)
    if (!parents || depth > 5) return [""]
    return uniq(parents.flatMap((p) => prefixesOf(p.host, depth + 1).map((pp) => joinPath(pp, p.prefix))))
  }
  const firstPrefix = new Map<string, string>()
  for (const m of modules) {
    const eps = decl.get(m.path) ?? []
    const prefixes = prefixesOf(m.path)
    firstPrefix.set(m.path, prefixes[0] ?? "")
    if (m.kind === "router" && !mountedBy.has(m.path)) m.kind = "router-unmounted"
    const seen = new Set<string>()
    for (const pf of prefixes) for (const e of eps) {
      const path = joinPath(pf, e.path)
      const k = `${e.method} ${path}`
      if (seen.has(k)) continue
      seen.add(k)
      m.endpoints.push({ method: e.method, path, prefix: e.prefix })
    }
  }
  const route = new Map<string, string>()
  const fanIn = computeFanIn(modules, sourcesOf(root, modules), {
    requireImport: () => true,
    label: (m, l) => {
      const r = l.match(ROUTE_LINE_RE)
      if (r) route.set(m.path, `${r[1] === "all" ? "*" : r[1]!.toUpperCase()} ${joinPath(firstPrefix.get(m.path) ?? "", cleanPath(r[2]!))}`)
      const cur = route.get(m.path)
      return m.kind !== "lib" && cur ? `${m.path}#${cur}` : m.path
    },
  })
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
