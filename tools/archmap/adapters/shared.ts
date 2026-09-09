import { readdirSync, statSync, readFileSync, existsSync } from "node:fs"
import { dirname, join, normalize, relative, isAbsolute } from "node:path"
import { homedir } from "node:os"
import { uniq, type ModuleInfo, type Target } from "../types"

export function walk(root: string, exts: string[], ignore: string[] = []): string[] {
  const out: string[] = []
  const skip = new Set(["node_modules", ".git", "dist", "build", ".build", ".nuxt", ".output", "DerivedData", ...ignore])
  function rec(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) rec(full)
      else if (exts.some((e) => name.endsWith(e))) out.push(full)
    }
  }
  rec(root)
  return out.sort()
}

export function read(path: string): { text: string; lines: string[] } {
  const text = readFileSync(path, "utf-8")
  return { text, lines: text.split("\n") }
}

// Roots may be relative to the repo, absolute, or ~-prefixed.
export function resolveRoot(repoRoot: string, root: string): string {
  if (root.startsWith("~/")) return join(homedir(), root.slice(2))
  return isAbsolute(root) ? root : join(repoRoot, root)
}

export function rel(root: string, path: string): string {
  return relative(root, path)
}

export function isTest(path: string): boolean {
  return /\.test\.[tj]sx?$|\.spec\.[tj]sx?$|Tests?\//.test(path)
}

// `/api/expense/${id}` → `/api/expense/:p` so template calls join param routes.
export function normalizeCall(path: string): string {
  return path.replace(/\$\{[^}]*\}/g, ":p").replace(/\?.*$/, "")
}

// --- TypeScript module basics shared by the server adapters -----------------

export const TS_EXPORT_RE = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/
const STATE_RE = /^(?:const|let)\s+([A-Za-z_$][\w$]*)(?::\s*[^=]+)?\s*=\s*new\s+(Map|Set|WeakMap|Database)\b/
const LET_RE = /^let\s+([A-Za-z_$][\w$]*)/
const IMPORT_RE = /from\s+["'](\.{1,2}\/[^"']+|[~@]\/[^"']+)["']/
const LISTENER_RE = /^(on[A-Z]\w*|setInterval|[a-zA-Z_]\w*\.start)\(/

// `~/x` and `@/x` resolve against `alias`; relative specs against the file.
export function resolveImport(fromFile: string, spec: string, root: string, alias: string = root): string {
  const base = /^[~@]\//.test(spec) ? join(alias, spec.slice(2)) : normalize(join(dirname(fromFile), spec))
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.vue`, `${base}.js`, join(base, "index.ts"), join(base, "index.vue")]) {
    if (existsSync(cand)) return rel(root, cand)
  }
  return rel(root, `${base}.ts`)
}

export function scanTsBasics(m: ModuleInfo, file: string, lines: string[], root: string, alias: string = root): void {
  for (const l of lines) {
    const ex = l.match(TS_EXPORT_RE); if (ex) m.exports.push(ex[1]!)
    const st = l.match(STATE_RE); if (st) m.state.push(`${st[1]}: ${st[2]}`)
    else { const lt = l.match(LET_RE); if (lt) m.state.push(`let ${lt[1]}`) }
    const im = l.match(IMPORT_RE); if (im) m.imports.push(resolveImport(file, im[1]!, root, alias))
    const ls = l.match(LISTENER_RE); if (ls) m.listeners.push(ls[1]!)
  }
}

// --- External packages -------------------------------------------------------
// Bare specifiers only: `hono/cors`, `@libsql/client`, `react`. Relative,
// alias (`~/`, `@/`) and runtime builtins are dropped; type-only imports count
// (they still pin the package). The full specifier is kept so a consumer can
// tell `hono/cors` from `hono/jsx`; `packageOf` folds it to the package name.

const NODE_BUILTINS = new Set(["assert", "async_hooks", "buffer", "child_process", "cluster", "constants", "crypto", "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2", "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process", "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys", "test", "timers", "tls", "trace_events", "tty", "url", "util", "v8", "vm", "wasi", "worker_threads", "zlib"])
// `from "x"`, `import "x"`, `require("x")`, `import("x")`; both quote styles
const EXTERNAL_RE = /(?:\bfrom\s+|^\s*import\s+|\brequire\(\s*|\bimport\(\s*)["']([^"'\s]+)["']/

export function isBuiltinSpec(spec: string): boolean {
  if (spec === "bun" || spec.startsWith("bun:") || spec.startsWith("node:")) return true
  return NODE_BUILTINS.has(spec.split("/")[0]!)
}

export function packageOf(spec: string): string {
  const parts = spec.split("/")
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

export function scanExternals(m: ModuleInfo, lines: string[]): void {
  const out: string[] = []
  for (const l of lines) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(l)) continue          // comment-only line
    const x = l.replace(/\s\/\/.*$/, "").match(EXTERNAL_RE)   // trailing comment stripped: a quoted import in prose is not an import
    if (!x) continue
    const spec = x[1]!
    if (/^[.\/~]|^@\//.test(spec) || isBuiltinSpec(spec)) continue
    out.push(spec)
  }
  m.externals = uniq([...(m.externals ?? []), ...out]).sort()
}

// --- Fan-in ------------------------------------------------------------------
// For every export unique across the target, which OTHER modules call it.
// `label(module, line)` runs on every line and names the caller for that line —
// a plain module path, or a finer site (route inside a host) when the adapter
// can tell.

export interface FanInOpts {
  minLen?: number
  label?: (m: ModuleInfo, line: string) => string
  // how a use looks: default a bare identifier (`name(`, `name,`, `: Name`);
  // JSX/Swift/Nuxt adapters narrow or widen it (`<Name`, `Name.`, kebab tags)
  callRe?: (name: string) => RegExp
  // when true for an owner, a module counts as a caller only if it imports the
  // owner — kills same-name false positives in TS targets. Swift (one module)
  // and Nuxt auto-imports (components, composables, utils) say false.
  requireImport?: (owner: ModuleInfo) => boolean
  // drop "…" string literals and // comments from each line before matching
  stripLiterals?: boolean
}

export function stripLiterals(line: string): string {
  return line.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, "")
}

// bare identifier: not part of a longer name, not a property (`x.name`), not an object key (`name:`)
export function identRe(name: string): RegExp {
  return new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])(?!\\s*:)`)
}

const IMPORT_LINE_RE = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b)/

export function computeFanIn(modules: ModuleInfo[], sources: Map<string, string[]>, opts: FanInOpts = {}): Target["fanIn"] {
  const minLen = opts.minLen ?? 3
  const owners = new Map<string, string>()
  const byPath = new Map(modules.map((m) => [m.path, m]))
  const dup = new Set<string>()
  for (const m of modules) for (const raw of m.exports) {
    const name = raw.replace(/\(\)$/, "")
    if (name.length < minLen) continue
    if (owners.has(name) && owners.get(name) !== m.path) dup.add(name)
    else owners.set(name, m.path)
  }
  for (const d of dup) owners.delete(d)
  const mk = opts.callRe ?? identRe
  const res = new Map([...owners.keys()].map((n) => [n, mk(n)]))
  // the regex is the slow path; `includes` (or the kebab/lowercase forms a
  // template tag may use) gates it
  const needles = new Map([...owners.keys()].map((n) => [n, uniq([n, n[0]!.toLowerCase() + n.slice(1), n.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()])]))
  const fanIn: Target["fanIn"] = {}
  for (const m of modules) {
    const lines = sources.get(m.path) ?? []
    for (const raw of lines) {
      const caller = opts.label ? opts.label(m, raw) : m.path
      if (IMPORT_LINE_RE.test(raw)) continue
      const l = opts.stripLiterals ? stripLiterals(raw) : raw
      for (const [name, re] of res) {
        const owner = owners.get(name)!
        if (owner === m.path) continue
        if (opts.requireImport?.(byPath.get(owner)!) && !m.imports.includes(owner)) continue
        if (!needles.get(name)!.some((n) => l.includes(n)) || !re.test(l)) continue
        const entry = (fanIn[name] ??= { module: owner, callers: [] })
        if (!entry.callers.includes(caller)) entry.callers.push(caller)
      }
    }
  }
  return fanIn
}

export function sourcesOf(root: string, modules: ModuleInfo[]): Map<string, string[]> {
  return new Map(modules.map((m) => [m.path, read(join(root, m.path)).lines]))
}
