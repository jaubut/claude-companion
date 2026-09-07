import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import { emptyModule, uniq, type Endpoint, type ModuleInfo, type Target, type TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, computeFanIn, sourcesOf, normalizeCall, scanTsBasics } from "./shared"

// Nuxt 3/4 site. Contracts come from the file system, which IS the router:
// pages/ → PAGE routes, server/api + server/routes → HTTP endpoints
// (`name.post.ts` → POST /api/name, `[id]` → :id, `[...slug]` → prefix),
// components/ → auto-imported by PascalCase name (fan-in = template tags),
// composables/ + utils/ → auto-imported exports (fan-in = calls).
// Nuxt 4 keeps app code under app/; server/ stays at the root. Both layouts
// are detected from the root.

const SCRIPT_DIRS = ["composables", "utils", "stores", "plugins", "middleware"]
const APP_DIRS = ["pages", "components", "layouts", ...SCRIPT_DIRS]
const CALL_RE = /(?:\$fetch|useFetch|useLazyFetch|fetch)\(\s*[`"']([^`"'?]+)/g
const STATE_RE = /(?:useState|defineStore)\(\s*["'`]([^"'`]+)/g
const LAYOUT_RE = /layout:\s*["'`]([^"'`]+)/g

function pascal(s: string): string {
  return s.split(/[-_./ ]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("")
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()
}

// components/foo/Bar.vue → FooBar; components/foo/FooBar.vue → FooBar (Nuxt dedupes the prefix)
function componentName(relPath: string): string {
  const parts = relPath.replace(/\.vue$/, "").split("/")
  const file = pascal(parts.pop()!)
  const prefix = pascal(parts.join("/"))
  return file.startsWith(prefix) ? file : prefix + file
}

function pageRoute(relPath: string): string {
  const p = relPath.replace(/\.vue$/, "").split("/").map((seg) => seg.replace(/^\[\.\.\.(\w+)\]$/, "*").replace(/^\[(\w+)\]$/, ":$1")).filter((s) => s !== "index")
  return "/" + p.join("/")
}

function serverEndpoint(relPath: string, base: string): Endpoint {
  const noExt = relPath.replace(/\.(ts|js|mjs)$/, "")
  const parts = noExt.split("/")
  let last = parts.pop()!
  let method = "*"
  const mm = last.match(/^(.+)\.(get|post|put|delete|patch|head|options)$/)
  if (mm) { last = mm[1]!; method = mm[2]!.toUpperCase() }
  const segs = [...parts, last].map((seg) => seg.replace(/^\[\.\.\.(\w+)\]$/, "*").replace(/^\[(\w+)\]$/, ":$1")).filter((s) => s !== "index")
  const path = (base + "/" + segs.join("/")).replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/"
  return path.endsWith("*") ? { method, path: path.replace(/\*$/, ""), prefix: true } : { method, path, prefix: false }
}

export function scanNuxt(cfg: TargetConfig, repoRoot: string): Target {
  const root = resolveRoot(repoRoot, cfg.root)
  const cap = cfg.cap ?? 600
  const appDir = APP_DIRS.some((d) => existsSync(join(root, "app", d))) && !existsSync(join(root, "pages")) ? join(root, "app") : root
  const modules: ModuleInfo[] = []
  const byName = new Map<string, string>()   // component name → module path
  const files: string[] = []
  for (const d of APP_DIRS) if (existsSync(join(appDir, d))) files.push(...walk(join(appDir, d), [".vue", ".ts", ".js"], cfg.ignore))
  if (existsSync(join(root, "server"))) files.push(...walk(join(root, "server"), [".ts", ".js"], cfg.ignore))
  for (const f of ["app.vue", "app/app.vue", "error.vue", "app/error.vue", "nuxt.config.ts"]) if (existsSync(join(root, f))) files.push(join(root, f))
  for (const file of uniq(files).sort()) {
    if (isTest(file) || file.endsWith(".d.ts")) continue
    const { text, lines } = read(file)
    const path = rel(root, file)
    const inApp = rel(appDir, file)
    const top = inApp.split("/")[0]!
    const m = emptyModule(path, lines.length, "lib")
    scanTsBasics(m, file, lines, root, appDir)
    if (top === "pages") { m.kind = "page"; m.endpoints.push({ method: "PAGE", path: pageRoute(inApp.slice("pages/".length)), prefix: false }) }
    else if (top === "components") { m.kind = "component"; const n = componentName(inApp.slice("components/".length)); m.exports.push(n); byName.set(n, path) }
    else if (top === "layouts") { m.kind = "layout"; m.exports.push(`layout:${basename(file).replace(/\.vue$/, "")}`) }
    else if (SCRIPT_DIRS.includes(top)) m.kind = top.replace(/s$/, "")
    else if (path.startsWith("server/api/")) { m.kind = "server-api"; m.endpoints.push(serverEndpoint(path.slice("server/api/".length), "/api")) }
    else if (path.startsWith("server/routes/")) { m.kind = "server-route"; m.endpoints.push(serverEndpoint(path.slice("server/routes/".length), "")) }
    else if (path.startsWith("server/middleware/")) { m.kind = "server-middleware"; m.listeners.push("middleware") }
    else if (path.startsWith("server/")) m.kind = "server-lib"
    else if (/(^|\/)app\.vue$/.test(path)) m.kind = "app"
    else if (path === "nuxt.config.ts") m.kind = "config"
    m.apiCalls = uniq([...text.matchAll(CALL_RE)].map((x) => normalizeCall(x[1]!)).filter((p) => p.startsWith("/")))
    m.state = uniq([...m.state, ...[...text.matchAll(STATE_RE)].map((x) => `useState ${x[1]}`)])
    for (const l of text.matchAll(LAYOUT_RE)) m.listeners.push(`layout:${l[1]}`)
    m.imports = uniq(m.imports)
    m.exports = uniq(m.exports)
    m.listeners = uniq(m.listeners)
    modules.push(m)
  }
  // Template tags resolve a component whether written <TlsHeader>, <tlsHeader>
  // or <tls-header>; layouts are reached through `layout:` meta or <NuxtLayout name>.
  const fanIn = computeFanIn(modules, sourcesOf(root, modules), {
    minLen: 3,
    callRe: (n) => {
      if (n.startsWith("layout:")) { const l = n.slice(7); return new RegExp(`layout:\\s*["'\`]${l}["'\`]|name=["']${l}["']`) }
      if (byName.has(n)) return new RegExp(`<(?:${n}|${n[0]!.toLowerCase()}${n.slice(1)}|${kebab(n)})[\\s/>]`)
      return new RegExp(`(?<![\\w$.])${n.replace(/\$/g, "\\$")}\\s*\\(`)
    },
  })
  return { name: cfg.name, adapter: cfg.adapter, root: cfg.root, cap, modules, fanIn }
}
