import { emptyModule, uniq, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, resolveImport, computeFanIn, sourcesOf, normalizeCall } from "./shared"

// React/Vite client: frames consumed (case "x" literals — the renderer keeps
// only those a server emits), HTTP paths called, local imports, exports.
// Fan-in: exports (components, hooks, helpers) reached from 2+ modules —
// a call `name(` or a JSX site `<Name`.

const EXPORT_RE = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/
const CASE_RE = /case\s+"([a-z_]+)"\s*:/g
const TYPE_EQ_RE = /\.type\s*===\s*"([a-z_]+)"/g
const FETCH_RE = /\bfetch\(\s*[`"']([^`"'?]+)/g
const IMPORT_RE = /from\s+"(\.{1,2}\/[^"]+|@\/[^"]+)"/

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
    m.consumes = uniq([...text.matchAll(CASE_RE), ...text.matchAll(TYPE_EQ_RE)].map((x) => x[1]!))
    m.apiCalls = uniq([...text.matchAll(FETCH_RE)].map((x) => normalizeCall(x[1]!)).filter((p) => p.startsWith("/")))
    m.imports = uniq(m.imports)
    m.exports = uniq(m.exports)
    modules.push(m)
  }
  const fanIn = computeFanIn(modules, sourcesOf(root, modules), {
    callRe: (n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, "\\$")}\\s*\\(|<${n}[\\s/>]`),
  })
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
