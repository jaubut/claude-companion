import { existsSync } from "node:fs"
import { basename, join } from "node:path"
import type { TargetConfig } from "../types"
import { walk, read, rel, isTest, resolveRoot, resolveImport } from "./shared"
import { pathMatches } from "../render"

// featuremap — the user-facing sibling of the code map: how a HUMAN reaches
// each feature (route, click-path, shortcut) and a selector an agent can wait
// on over CDP. Nav only; exports, fan-in and contracts stay in architecture.md.
// Seeds from a react-router `createBrowserRouter([...])` object tree, the page
// directory, and the shell the layout route renders (sidebar, palette, tabs).

export interface Feature {
  name: string
  route: string            // "/notes/:folder"; "" for shell features
  reach: string[]          // "App sidebar › Finance › P&L by person", "⌘K › Tasks"
  shortcuts: string[]      // "⌘K" (⌘ = Cmd on macOS, Ctrl elsewhere)
  selector: string         // `[data-testid="x"]`, `[aria-label="x"]`, or "" (none found)
  sections: string[]       // shell only: group labels inside the component
  source: string[]         // repo-relative files / dirs that own the feature
  page: string             // repo-relative file the route renders; "" for shell features or an unresolved element
  inShell: boolean
}

export interface FeatureMap {
  target: string
  shell: Feature[]
  pages: Feature[]
  unrouted: string[]       // repo-relative page files no route renders
}

// A page's selector comes from `pageSelector` only. Its first testid / aria-label
// anywhere sits on whatever control comes first (often conditional — "Dismiss").
// Shell components may fall back to `aria`, which there labels the persistent root.
interface Facts { testid: string; aria: string; shortcuts: string[]; sections: string[]; imports: string[] }
const NO_FACTS: Facts = { testid: "", aria: "", shortcuts: [], sections: [], imports: [] }

const ROUTER_RE = /create(?:Browser|Hash|Memory)Router\(/
const LAZY_RE = /const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)\s*\)/g
const DEFAULT_IMPORT_RE = /^import\s+(\w+)\s+from\s+["']([^"']+)["']/gm
const NAMED_IMPORT_RE = /^import\s+\{([^}]+)\}\s+from\s+["'](\.{1,2}\/[^"']+|@\/[^"']+)["']/gm
const TESTID_RE = /data-testid=["']([^"']+)["']/
const PAGE_TESTID_RE = /data-testid=["'](page-[^"']+)["']/
const ROOT_TESTID_RE = /return\s*\(?\s*<[\w.]+\s(?:[^>]*?\s)?data-testid=["']([^"']+)["']/
const ARIA_RE = /aria-label=["']([^"']+)["']/
const HOTKEY_RE = /useHotkey\(\s*["'](\w)["']/g
const META_KEY_RE = /(?:metaKey|ctrlKey)[^\n]*?\.key\s*===\s*["'](\w)["']/g
const SECTION_RE = /GroupLabel>([^<{]+)</g
// Nav items: an object literal with a path and a label on one line…
const ITEM_RE = /\b(?:to|href|path):\s*["'](\/[^"'$]*)["'][^}\n]*?\b(?:label|title):\s*["']([^"']+)["']|\b(?:label|title):\s*["']([^"']+)["'][^}\n]*?\b(?:to|href|path):\s*["'](\/[^"'$]*)["']/
const ARRAY_RE = /^\s*(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*\[/
// …or a literal navigation followed (within a few lines) by its visible label.
const GO_RE = /\b(?:go|navigate)\(\s*["'](\/[^"'$]*)["']\s*\)|\b(?:to|href)=["'](\/[^"']*)["']/
const LABEL_RE = /tooltip=["']([^"']+)["']|<span>([^<{]+)<\/span>/

export function scanFeatureMap(cfg: TargetConfig, repoRoot: string): FeatureMap {
  const root = resolveRoot(repoRoot, cfg.root)
  const repoRel = (p: string) => rel(repoRoot, join(root, p))
  const files = walk(root, [".tsx", ".ts", ".jsx", ".js"], cfg.ignore).filter((f) => !isTest(f) && !f.endsWith(".d.ts"))
  const routerFile = cfg.router ? join(root, cfg.router) : files.find((f) => ROUTER_RE.test(maskStrings(read(f).text)))
  if (!routerFile || !existsSync(routerFile)) throw new Error(`archmap: featuremap target ${cfg.name} found no router under ${cfg.root}`)
  const { text } = read(routerFile)
  const componentFile = componentFiles(text, routerFile, root)
  const routes = parseRoutes(text)
  // Component name, or a route-level lazy() import spec.
  const fileOf = (ref: string) => /^[A-Z]/.test(ref) ? componentFile.get(ref) ?? ""
    : /^(\.{1,2}|@)\//.test(ref) ? resolveImport(routerFile, ref, root) : ""
  const facts = new Map<string, Facts>()
  const factsOf = (p: string): Facts => {
    if (!facts.has(p)) facts.set(p, readFacts(join(root, p), root))
    return facts.get(p)!
  }

  // Shell: the layout route's element and the local components it renders.
  const shellFiles: string[] = []
  for (const layout of new Set(routes.flatMap((r) => r.shells))) {
    const lf = fileOf(layout)
    if (!lf || !existsSync(join(root, lf))) continue
    const lt = read(join(root, lf)).text
    for (const [comp, p] of componentFiles(lt, join(root, lf), root)) {
      if (isUi(p) || !existsSync(join(root, p)) || !new RegExp(`<${comp.replace(/\$/g, "\\$")}[\\s/>]`).test(lt)) continue
      if (!shellFiles.includes(p)) shellFiles.push(p)
    }
  }
  const navItems = shellFiles.flatMap((p) => navItemsOf(p, read(join(root, p)).lines, factsOf(p)))

  const pages: Feature[] = routes.map((r) => {
    const page = fileOf(r.element)
    const f = page ? factsOf(page) : NO_FACTS
    const selector = page ? pageSelector(join(root, page), /^[A-Z]/.test(r.element) ? r.element : "") : ""
    const exact = navItems.filter((n) => n.path === r.path)
    const reach = (exact.length ? exact : navItems.filter((n) => !routes.some((o) => o.path === n.path) && routeMatches(r.path, n.path))).map((n) => n.reach)
    const owned = f.imports.filter((p) => p.includes("components/") && !isUi(p) && !p.includes("/layout/"))
      .map((p) => /^(.*components\/[^/]+)\//.exec(p)?.[1] ?? p)
    return {
      name: exact[0]?.label ?? humanize(basename(r.element).replace(/\.[jt]sx?$/, "").replace(/Page$/, "")),
      route: r.path, reach: [...new Set(reach)], shortcuts: f.shortcuts, selector, sections: [],
      source: [...new Set([page, ...owned].filter(Boolean))].map(repoRel), page: page ? repoRel(page) : "", inShell: r.shells.length > 0,
    }
  })

  const shell: Feature[] = shellFiles.map((p) => {
    const f = factsOf(p)
    return { name: humanize(basename(p).replace(/\.[jt]sx?$/, "")), route: "", reach: [], shortcuts: f.shortcuts, selector: f.testid || f.aria, sections: f.sections, source: [repoRel(p)], page: "", inShell: true }
  })

  const routed = new Set(routes.map((r) => fileOf(r.element)))
  const pagesDir = join(root, cfg.pages ?? "pages")
  const unrouted = existsSync(pagesDir)
    ? walk(pagesDir, [".tsx", ".ts", ".jsx", ".js"]).filter((f) => !isTest(f) && !routed.has(rel(root, f))).map((f) => rel(repoRoot, f))
    : []
  return { target: cfg.name, shell, pages, unrouted }
}

// `element` is a component name (`element: <X />`, `Component: X`) or, for a
// route-level `lazy: () => import(<spec>)`, the import spec itself.
interface Route { path: string; element: string; shells: string[] }
interface Frame { path?: string; index?: boolean; element?: string; children: Frame[]; route: boolean }

const ROUTE_TOKEN_RE = /\{|\}|(?<![\w$])path\s*:\s*(["'`])?|(?<![\w$])index\s*:\s*true|(?<![\w$])element\s*:\s*(?:\(\s*)?(?:<([A-Z]\w*))?|(?<![\w$])Component\s*:\s*([A-Z]\w*)?|(?<![\w$])lazy\s*:\s*(?:(?:async\s*)?\(\s*\)\s*=>\s*import\(\s*(["'`]))?/g
// `"path": …` → ` path : …` (same length, so offsets stay aligned) before masking would blank the key.
const QUOTED_KEY_RE = /(["'])(path|index|element|Component|lazy|children)\1(?=\s*:)/g

// Parse the whole router literal into a tree first, then resolve paths, so a
// `children` array listed before its parent's `path` / `element` still nests.
// Strings and comments are masked so braces inside them don't open frames.
// Each `{` opens a frame (JSX expression braces open throwaway ones).
export function parseRoutes(source: string): Route[] {
  const text = source.replace(QUOTED_KEY_RE, (_, _q: string, k: string) => ` ${k} `)
  const masked = maskStrings(text)
  const call = masked.search(ROUTER_RE)
  if (call < 0) return []
  const open = masked.indexOf("(", call)
  const body = masked.slice(open, matchingParen(masked, open))
  if (!/^\(\s*\[/.test(body)) throw new Error(`archmap: featuremap needs an inline route array, got ${JSON.stringify(text.slice(call, call + 60).split("\n")[0])}`)
  // `children: someVar` pulls routes from elsewhere; mapping without them would drop routes silently.
  const external = /(?<![\w$])children\s*:\s*(?!\[)[\w$]/.exec(body)
  if (external) throw new Error(`archmap: featuremap can't follow ${JSON.stringify(text.slice(open + external.index, open + external.index + 40).split("\n")[0])} — inline those routes in the router array`)
  // Route arrays (the router's and every `children: [`) hold object literals only.
  const arrays = [body.indexOf("["), ...[...body.matchAll(/(?<![\w$])children\s*:\s*\[/g)].map((m) => m.index! + m[0].length - 1)]
  const routeObjs = new Set<number>()
  for (const a of arrays) {
    let depth = 0
    for (let i = a; i < body.length; i++) {
      const c = body[i]!
      if ("([{".includes(c)) depth++
      else if (")]}".includes(c) && --depth === 0) break
      if (depth !== 1 || (c !== "[" && c !== ",")) continue
      const j = i + 1 + body.slice(i + 1).search(/\S|$/)
      if (body[j] !== "{" && body[j] !== "]") throw new Error(`archmap: featuremap can't follow ${JSON.stringify(text.slice(open + j, open + j + 40).split("\n")[0])} — inline those routes in the router array`)
      if (body[j] === "{") routeObjs.add(j)
    }
  }
  // A spread property in a route object (`{ ...base, path }`) can carry path / element / children.
  // Spreads elsewhere (`<A {...props} />`, `loader: () => ({ ...data })`) sit deeper and don't matter.
  const SPREAD_RE = /\s*\.\.\./y
  for (const o of routeObjs) {
    let depth = 0
    for (let i = o; i < body.length; i++) {
      const c = body[i]!
      if ("([{".includes(c)) depth++
      else if (")]}".includes(c) && --depth === 0) break
      if (depth !== 1 || (c !== "{" && c !== ",")) continue
      SPREAD_RE.lastIndex = i + 1
      if (SPREAD_RE.test(body)) throw new Error(`archmap: featuremap can't follow ${JSON.stringify(text.slice(open + i, open + i + 40).split("\n")[0])} — inline those routes in the router array`)
    }
  }
  const snippet = (i: number) => JSON.stringify(text.slice(open + i, open + i + 40).split("\n")[0])
  const root: Frame = { children: [], route: true }
  const stack: Frame[] = [root]
  for (const m of body.matchAll(ROUTE_TOKEN_RE)) {
    const top = stack[stack.length - 1]!
    const at = m.index! + m[0].length - 1
    // Only objects sitting directly in a route array are routes; `handle: {…}`, JSX braces and
    // loader data open throwaway frames whose keys are ignored.
    if (m[0] === "{") {
      const f: Frame = { children: [], route: top.route && routeObjs.has(m.index!) }
      if (f.route) top.children.push(f)
      stack.push(f)
    }
    else if (m[0] === "}") { if (stack.length > 1) stack.pop() }
    else if (!top.route) continue
    else if (m[0].startsWith("path")) {
      const end = m[1] === undefined ? -1 : body.indexOf(m[1], at + 1)
      const path = end < 0 || !/^\s*[,}]/.test(body.slice(end + 1)) ? undefined : text.slice(open + at + 1, open + end)
      if (path === undefined || path.includes("${")) throw new Error(`archmap: featuremap can't read route ${snippet(m.index!)} — use a string-literal path`)
      top.path = path
    }
    else if (m[0].startsWith("index")) top.index = true
    else if (m[0].startsWith("element") || m[0].startsWith("Component")) {
      const name = m[2] ?? m[3]
      // Dotted (`Pages.Settings`) or wrapping (`<Suspense><X /></Suspense>`) elements would map to the wrong component.
      if (!name || body[at + 1] === "." || (m[2] && !selfClosing(body, at + 1))) throw new Error(`archmap: featuremap can't read route ${snippet(m.index!)} — use element: <Component /> or Component: Name`)
      top.element = name
    } else {
      if (m[4] === undefined) throw new Error(`archmap: featuremap can't read route ${snippet(m.index!)} — use lazy: () => import(<spec>)`)
      top.element = text.slice(open + at + 1, open + body.indexOf(m[4], at + 1))
    }
  }
  const out: Route[] = []
  const visit = (f: Frame, prefix: string, shells: string[]) => {
    let full = prefix
    if (f.path) full = f.path.startsWith("/") ? f.path : `${prefix}/${f.path}`
    if (f.element && (f.path !== undefined || f.index)) out.push({ path: full.replace(/\/+$/, "") || "/", element: f.element, shells })
    for (const c of f.children) visit(c, full.replace(/\/+$/, ""), f.element ? [...shells, f.element] : shells)
  }
  visit(root, "", [])
  return out
}

// The JSX tag starting at `from` closes itself (`<X ... />`): first `>` outside `{…}` follows a `/`.
function selfClosing(masked: string, from: number): boolean {
  let depth = 0
  for (let i = from; i < masked.length; i++) {
    const c = masked[i]
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === ">" && depth === 0) return masked[i - 1] === "/"
  }
  return false
}

// Blank out string / comment contents (quotes kept) so offsets stay aligned.
// Single-line strings end at a newline, bounding damage from a stray JSX apostrophe.
function maskStrings(text: string): string {
  const out = text.split("")
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const end = text[i + 1] === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2) + 1
      const stop = end <= 0 ? text.length : end
      for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " "
      i = stop
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1
      for (; j < text.length && text[j] !== c && (c === "`" || text[j] !== "\n"); j++) {
        if (text[j] === "\\") { out[j] = " "; j++ }
        if (j < text.length && text[j] !== "\n") out[j] = " "
      }
      i = j
    }
  }
  return out.join("")
}

function matchingParen(masked: string, open: number): number {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++
    else if (masked[i] === ")" && --depth === 0) return i + 1
  }
  return masked.length
}

// Component name → target-relative file, from lazy() and static imports.
function componentFiles(text: string, file: string, root: string): Map<string, string> {
  const out = new Map<string, string>()
  const add = (name: string, spec: string) => {
    if (!/^(\.{1,2}|@)\//.test(spec)) return
    out.set(name, resolveImport(file, spec, root))
  }
  for (const m of text.matchAll(LAZY_RE)) add(m[1]!, m[2]!)
  for (const m of text.matchAll(DEFAULT_IMPORT_RE)) add(m[1]!, m[2]!)
  for (const m of text.matchAll(NAMED_IMPORT_RE)) {
    for (const n of m[1]!.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").split(",")) {
      const name = n.trim().split(/\s+as\s+/).pop()!.replace(/^type\s+/, "")
      if (/^[A-Za-z_$][\w$]*$/.test(name)) add(name, m[2]!)
    }
  }
  return out
}

function readFacts(file: string, root: string): Facts {
  if (!existsSync(file)) return NO_FACTS
  const { text } = read(file)
  const tid = TESTID_RE.exec(text)?.[1]
  const aria = ARIA_RE.exec(text)?.[1]
  const shortcuts = [...new Set([...text.matchAll(HOTKEY_RE), ...text.matchAll(META_KEY_RE)].map((m) => `⌘${m[1]!.toUpperCase()}`))]
  const sections = [...new Set([...text.matchAll(SECTION_RE)].map((m) => m[1]!.trim()).filter(Boolean))]
  const imports = [...componentFiles(text, file, root).values()]
  return { testid: tid ? `[data-testid="${tid}"]` : "", aria: aria ? `[aria-label="${aria}"]` : "", shortcuts, sections, imports }
}

// The routed component's `data-testid="page-*"`, else the testid on its returned
// root element. Scoped to that component so a helper's testid in the same file
// never becomes the page selector; no component found → no selector.
function pageSelector(file: string, component: string): string {
  if (!existsSync(file)) return ""
  const body = componentSlice(read(file).text, component)
  const tid = PAGE_TESTID_RE.exec(body)?.[1] ?? ROOT_TESTID_RE.exec(body)?.[1]
  return tid ? `[data-testid="${tid}"]` : ""
}

const DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|class)\s/m

// Source of `component` (by name, else the default export) up to the next top-level declaration.
function componentSlice(text: string, component: string): string {
  const declOf = (name: string) => new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\s+|(?:const|let)\\s+)${name.replace(/\$/g, "\\$")}(?![\\w$])`, "m").exec(text)
  const named = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m.exec(text)?.[1]
  const start = (component ? declOf(component) : null)
    ?? /^export\s+default\s+(?:async\s+)?(?:function|class)\b/m.exec(text)
    ?? (named ? declOf(named) : null)
  if (!start) return ""
  const from = start.index + start[0].length
  const next = DECL_RE.exec(text.slice(from))
  return text.slice(start.index, next ? from + next.index : text.length)
}

interface NavItem { path: string; label: string; reach: string }

function navItemsOf(file: string, lines: string[], facts: Facts): NavItem[] {
  const hotkey = facts.shortcuts[0]
  const surface = hotkey ? `${hotkey} (${humanize(basename(file).replace(/\.[jt]sx?$/, ""))})` : humanize(basename(file).replace(/\.[jt]sx?$/, ""))
  const out: NavItem[] = []
  let group = ""
  lines.forEach((l, i) => {
    const arr = ARRAY_RE.exec(l)
    if (arr) {
      // `toolItems` → the rendered section label ("Tools") when one starts with it.
      const g = humanize(arr[1]!.replace(/_?items$/i, ""))
      group = facts.sections.find((x) => g && x.toLowerCase().startsWith(g.toLowerCase())) ?? g
    }
    const item = ITEM_RE.exec(l)
    if (item) {
      const path = item[1] ?? item[4]!, label = item[2] ?? item[3]!
      out.push({ path, label, reach: [surface, group, label].filter(Boolean).join(" › ") })
      return
    }
    const go = GO_RE.exec(l)
    if (!go) return
    for (const next of lines.slice(i, i + 8)) {
      const lab = LABEL_RE.exec(next)
      if (lab) {
        const label = (lab[1] ?? lab[2]!).trim()
        out.push({ path: go[1] ?? go[2]!, label, reach: `${surface} › ${label}` })
        return
      }
    }
  })
  return out
}

function routeMatches(route: string, path: string): boolean {
  if (route.endsWith("/*")) return path.startsWith(route.slice(0, -1))
  return pathMatches({ method: "PAGE", path: route, prefix: false }, path)
}

function isUi(p: string): boolean {
  return /(^|\/)ui\//.test(p)
}

// "financeItems" → "Finance", "app-sidebar" → "App sidebar", "NAV" → "".
function humanize(s: string): string {
  if (/^[A-Z_]+$/.test(s) && /^(NAV|ITEMS?)?$/.test(s.replace(/_/g, ""))) return ""
  const words = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// --- Render ------------------------------------------------------------------

const cell = (s: string) => s.replace(/\|/g, "\\|")
const code = (s: string) => (s ? `\`${s}\`` : "—")

export function renderFeatureMap(repo: string, maps: FeatureMap[], generatedAt: string): string {
  const out: string[] = [
    `# Feature map — ${repo}`,
    "",
    `_Generated by archmap (featuremap target) on ${generatedAt}. Nav only — code structure lives in architecture.md._`,
    "",
    "How to reach a feature from a report: find it below by name, section or route; open `<origin><route>` (fill `:params` with a real value) or follow **Reach** from app launch; wait for **Selector** over CDP; start reading at **Source**. ⌘ = Cmd on macOS, Ctrl elsewhere. A missing selector (—) means the feature's file carries no root `data-testid` yet — add `data-testid=\"page-<name>\"` to a page's root element.",
  ]
  for (const m of maps) {
    if (maps.length > 1) out.push("", `## ${m.target}`)
    out.push("", "### App shell — on every page inside the layout", "",
      "| Feature | Sections | Shortcut | Selector | Source |", "|---|---|---|---|---|")
    for (const f of m.shell) out.push(`| ${cell(f.name)} | ${cell(f.sections.join(", ") || "—")} | ${f.shortcuts.join(" ") || "—"} | ${cell(code(f.selector))} | ${f.source.map(code).join(" ")} |`)
    out.push("", "### Pages", "", "| Feature | Route | Reach | Shortcut | Selector | Source |", "|---|---|---|---|---|---|")
    for (const f of m.pages) {
      const reach = f.reach.length ? f.reach.join(" · ") : f.inShell ? "direct URL (no nav entry)" : "direct URL (outside the app shell)"
      out.push(`| ${cell(f.name)} | \`${f.route}\` | ${cell(reach)} | ${f.shortcuts.join(" ") || "—"} | ${cell(code(f.selector))} | ${f.source.map(code).join(" ")} |`)
    }
    if (m.unrouted.length) out.push("", "### Unrouted pages — no route renders these", "", ...m.unrouted.map((p) => `- \`${p}\``))
  }
  return out.join("\n")
}

// A FEATUREMAP.md this tool wrote (vs a hand-written one it must not touch).
export function isGeneratedFeatureMap(md: string): boolean {
  return /^_Generated by archmap \(featuremap target\)/m.test(md)
}

// Line that changes every regeneration; staleness checks ignore it.
export function stripGenerated(md: string): string {
  return md.replace(/^_Generated by archmap.*$/m, "")
}
