import { emptyModule, uniq, type Endpoint, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, scanTsBasics, computeFanIn, sourcesOf, scanExternals } from "./shared"

// Bun.serve server: one or more route hosts (fetch handlers switching on
// url.pathname) plus lib modules. Contracts recorded per module: exports,
// module-level state, WS frames emitted, endpoints, imports, top-level
// listener registrations. Fan-in is computed across the target: for every
// export, which other modules use it (and import its owner).

const ENDPOINT_RE = /url\.pathname(?:\s*===\s*|\.startsWith\()"([^"]+)"\)?(?:\s*&&\s*req\.method\s*===\s*"([A-Z]+)")?/g
const ROUTE_RE = /url\.pathname(?:\s*===\s*|\.startsWith\()"([^"]+)"\)?(?:\s*&&\s*req\.method\s*===\s*"([A-Z]+)")?/
const FRAME_RE = /type:\s*"([a-z_]+)"/g

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

function endpoints(text: string): Endpoint[] {
  const out: Endpoint[] = []
  for (const m of text.matchAll(ENDPOINT_RE)) {
    out.push({ method: m[2] ?? "*", path: m[1]!, prefix: m[0].includes("startsWith") })
  }
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
    const eps = endpoints(text)
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
      const cur = route.get(m.path)
      return m.kind === "route-host" && cur ? `${m.path}#${cur}` : m.path
    },
  })
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
