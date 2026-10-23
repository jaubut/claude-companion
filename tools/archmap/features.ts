import { existsSync } from "node:fs"
import { basename, join, relative } from "node:path"
import type { ArchMap, Endpoint, Target, TargetConfig } from "./types"
import type { FeatureMap } from "./adapters/featuremap"
import { resolveRoot } from "./adapters/shared"
import { pathMatches } from "./render"

// Feature index — feature → UI routes → API endpoints → files, joined from the
// nav map (routes, the page each renders) and the code map (client imports and
// calls, server endpoints and imports). Written as featuremap.json (for scripts:
// "the invoice page won't save" → keyword `invoice` → routes, endpoints, files
// to `git log` since the ticket) and as a section of FEATUREMAP.md.
//
// Grouping is deterministic, no LLM:
//   UI   a route joins the feature named by its first static segment
//        (`/invoice/:number` → `invoice`; no static segment → the page's file name).
//   API  every module serving endpoints has a home feature named by its file
//        (`routes/invoices.ts` → `invoice`), the UI feature of that name when
//        there is one, else an API-only feature. A UI feature also lists every
//        endpoint its own (unshared) files call, `via: "call"`.
//   Keys are lowercase with each hyphen token singularised, so invoices/invoice
//   and notes/note meet.
// Files: the import closure of the feature's pages and of the handler modules
// it owns, plus the handler file of each endpoint it only calls. A module that
// HUB_MIN or more modules import (ui kit, data barrel, format hooks) is a hub:
// listed under `shared` and not walked through, so a fix there does not flag
// every feature and the barrel does not pull the whole lib into each one. A
// host (the module mounting every router) is never walked either.
// Endpoints `via: "call"` come only from the pages and from UI files fewer than
// SHARED_MIN features reach — a session hook's /api/auth/check is not a feature.

export const HUB_MIN = 20
export const SHARED_MIN = 3
export const GENERATOR = "archmap featuremap"

export interface FeatureUi {
  path: string       // "/invoice/:number"
  page: string       // repo-relative page file
  reach: string[]    // nav click-paths from FEATUREMAP.md ("App sidebar › Finance › Invoices")
  selector: string   // CDP selector or ""
}

export interface FeatureApi {
  method: string     // GET | POST | PUT | DELETE | PATCH | * (Hono .all)
  path: string       // effective path, mount prefix included ("/api/invoice/:number"); a trailing "…" never appears — see prefix
  prefix: boolean    // true: the handler serves every path under `path`
  handler: string    // repo-relative module declaring the route
  via: "handler" | "call" | "both"   // handler: this feature owns the module; call: this feature's UI calls it
  calledFrom: string[]  // repo-relative UI files of this feature that call the path ([] = joined by handler name only)
}

export interface FeatureEntry {
  id: string          // "invoice"
  keywords: string[]  // lowercase tokens, singular and as written
  ui: FeatureUi[]
  api: FeatureApi[]
  files: string[]     // repo-relative: pages + owned handlers and their import closure (hubs excluded), + handlers of called endpoints
  shared: string[]    // repo-relative hubs (imported by HUB_MIN+ modules) the closure touches
}

export interface FeatureIndex {
  generator: typeof GENERATOR
  generatedAt: string
  repo: string
  hubMin: number
  sharedMin: number
  features: FeatureEntry[]   // sorted by id
}

export function singular(tok: string): string {
  if (tok.length > 4 && tok.endsWith("ies")) return tok.slice(0, -3) + "y"
  if (/(?:ch|sh|x|ss|z)es$/.test(tok)) return tok.slice(0, -2)
  if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss")) return tok.slice(0, -1)
  return tok
}

export function featureKey(name: string): string {
  return name.toLowerCase().split(/[-_\s]+/).filter(Boolean).map(singular).join("-")
}

const stem = (p: string) => basename(p).replace(/\.[jt]sx?$/, "")
const staticSegments = (route: string) => route.split("/").filter((s) => s && !s.startsWith(":") && s !== "*")

export function routeKey(route: string, page: string): string {
  return featureKey(staticSegments(route)[0] ?? (page ? stem(page) : "home"))
}

interface Draft {
  id: string
  ui: FeatureUi[]
  pages: Set<string>        // repo-relative
  homes: Set<string>        // repo-relative handler modules this feature owns
  tokens: Set<string>
}

export function buildFeatureIndex(map: ArchMap, nav: { cfg: TargetConfig; fm: FeatureMap }[], repoRoot: string): FeatureIndex {
  const rootOf = (t: { root: string }) => resolveRoot(repoRoot, t.root)
  const repoRel = (t: Target, p: string) => relative(repoRoot, join(rootOf(t), p))
  const owner = new Map<string, { t: Target; path: string }>()   // repo-relative → module
  for (const t of map.targets) for (const m of t.modules) owner.set(repoRel(t, m.path), { t, path: m.path })

  const drafts = new Map<string, Draft>()
  const draft = (id: string): Draft => drafts.get(id) ?? drafts.set(id, { id, ui: [], pages: new Set(), homes: new Set(), tokens: new Set() }).get(id)!
  const prefixId = nav.length > 1
  for (const { cfg, fm } of nav) for (const f of fm.pages) {
    const d = draft(`${prefixId ? `${cfg.name}:` : ""}${routeKey(f.route, f.page)}`)
    d.ui.push({ path: f.route, page: f.page, reach: f.reach, selector: f.selector })
    if (f.page) { d.pages.add(f.page); d.tokens.add(stem(f.page)) }
    for (const s of staticSegments(f.route)) d.tokens.add(s)
  }

  interface Ep extends Endpoint { handler: string; callers: string[] }
  const calls: { path: string; from: string }[] = []
  for (const t of map.targets) for (const m of t.modules) for (const c of m.apiCalls) calls.push({ path: c, from: repoRel(t, m.path) })
  const all = map.targets.flatMap((t) => t.modules.flatMap((m) => m.endpoints)).filter((e) => e.method !== "PAGE")
  // A call joins the routes that serve it most specifically: exact/param routes
  // first, else the longest prefix — a host's `* /api/` 404 fallback is never
  // the endpoint a page "calls" while a real route matches.
  const serves = (e: Endpoint, call: string): boolean => {
    if (!pathMatches(e, call)) return false
    const hits = all.filter((x) => pathMatches(x, call))
    if (hits.some((x) => !x.prefix)) return !e.prefix
    return e.path.length === Math.max(...hits.map((x) => x.path.length))
  }
  const endpoints: Ep[] = []
  for (const t of map.targets) for (const m of t.modules) for (const e of m.endpoints) {
    if (e.method === "PAGE") continue
    const handler = repoRel(t, m.path)
    // a host's catch-all (`* /api/` → 404) only collects calls no route serves — misparsed literals, not a feature
    const catchAll = m.kind === "host" && e.prefix
    endpoints.push({ ...e, handler, callers: catchAll ? [] : [...new Set(calls.filter((c) => serves(e, c.path)).map((c) => c.from))].sort() })
    const id = featureKey(stem(m.path))
    const home = [...drafts.values()].find((d) => d.id.replace(/^[^:]*:/, "") === id) ?? draft(id)
    home.homes.add(handler)
    home.tokens.add(stem(m.path))
  }

  const importers = new Map<string, number>()
  for (const t of map.targets) for (const m of t.modules) for (const i of new Set(m.imports)) {
    const r = repoRel(t, i)
    importers.set(r, (importers.get(r) ?? 0) + 1)
  }
  // Import closure, repo-relative. Hubs are recorded, not entered; an import
  // outside every target (`shared/…` types) is kept when it exists on disk.
  const closure = (starts: Set<string>): { files: Set<string>; hubs: Set<string> } => {
    const files = new Set<string>(), hubs = new Set<string>()
    const queue = [...starts]
    while (queue.length) {
      const p = queue.pop()!
      if (files.has(p) || hubs.has(p)) continue
      if (!starts.has(p) && (importers.get(p) ?? 0) >= HUB_MIN) { hubs.add(p); continue }
      const o = owner.get(p)
      if (!o) { if (starts.has(p) || existsSync(join(repoRoot, p))) files.add(p); continue }
      files.add(p)
      const m = o.t.modules.find((x) => x.path === o.path)!
      if (m.kind === "host") continue
      for (const i of m.imports) queue.push(repoRel(o.t, i))
    }
    return { files, hubs }
  }
  const ordered = [...drafts.values()].sort((a, b) => a.id.localeCompare(b.id))
  const count = (sets: Set<string>[]) => {
    const n = new Map<string, number>()
    for (const s of sets) for (const p of s) n.set(p, (n.get(p) ?? 0) + 1)
    return n
  }
  // UI first: the feature's unshared UI files decide which endpoints it calls.
  const uiReach = ordered.map((d) => closure(d.pages))
  const uiCount = count(uiReach.map((r) => r.files))
  const uiOwned = ordered.map((d, i) => new Set([...uiReach[i]!.files].filter((p) => d.pages.has(p) || (uiCount.get(p) ?? 0) < SHARED_MIN)))
  const apis = ordered.map((d, i) => {
    const out: FeatureApi[] = []
    for (const e of endpoints) {
      const home = d.homes.has(e.handler)
      const calledFrom = e.callers.filter((c) => uiOwned[i]!.has(c))
      if (!home && !calledFrom.length) continue
      out.push({ method: e.method, path: e.path, prefix: e.prefix, handler: e.handler, via: home && calledFrom.length ? "both" : home ? "handler" : "call", calledFrom })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  })
  // Server side: the closure of the modules the feature owns; a module it only
  // calls into contributes its own file, not its imports.
  const srvReach = ordered.map((d) => closure(d.homes))

  const features: FeatureEntry[] = ordered.map((d, i) => {
    const files = new Set([...uiReach[i]!.files, ...srvReach[i]!.files, ...apis[i]!.map((e) => e.handler)])
    const shared = new Set([...uiReach[i]!.hubs, ...srvReach[i]!.hubs].filter((p) => !files.has(p)))
    const tokens = new Set<string>()
    for (const raw of [d.id.replace(/^[^:]*:/, ""), ...d.tokens]) for (const tok of raw.toLowerCase().split(/[-_\s]+/)) {
      if (tok.length < 2) continue
      tokens.add(tok)
      tokens.add(singular(tok))
    }
    return {
      id: d.id,
      keywords: [...tokens].sort(),
      ui: d.ui,
      api: apis[i]!,
      files: [...files].sort(),
      shared: [...shared].sort(),
    }
  })
  return { generator: GENERATOR, generatedAt: map.generatedAt, repo: map.repo, hubMin: HUB_MIN, sharedMin: SHARED_MIN, features }
}

export function stripFeatureIndex(json: string): string {
  try { return JSON.stringify({ ...(JSON.parse(json) as FeatureIndex), generatedAt: "" }) } catch { return "" }
}

export function isGeneratedFeatureIndex(json: string): boolean {
  try { return (JSON.parse(json) as { generator?: string }).generator === GENERATOR } catch { return false }
}

// --- Render (appended to FEATUREMAP.md) --------------------------------------

const cell = (s: string) => s.replace(/\|/g, "\\|")

export function renderFeatureIndex(idx: FeatureIndex): string {
  const out: string[] = [
    "## Features — UI routes → API → files",
    "",
    `Grouped by a route's first path segment and a handler module's file name (plural/singular folded). \`featuremap.json\` beside this file holds the same data for scripts. **via** \`handler\`: the feature owns the module; \`call\`: the feature's own UI calls it. **Files** is the import closure of the pages and of the handler modules the feature owns, plus the handler of each endpoint it only calls; hubs (modules ${idx.hubMin}+ others import: ui kit, data barrel) are not walked and are listed under \`shared\` in the JSON.`,
  ]
  for (const f of idx.features) {
    out.push("", `### ${f.id}`, "", `Keywords: ${f.keywords.map((k) => `\`${k}\``).join(" ")}`, "")
    out.push(f.ui.length ? `**UI:** ${f.ui.map((u) => `\`${u.path}\` (${u.page ? `\`${u.page}\`` : "?"})`).join(" · ")}` : "**UI:** — (API only)")
    if (f.api.length) {
      out.push("", "| method | path | handler | via |", "|---|---|---|---|")
      for (const e of f.api) out.push(`| ${e.method} | \`${cell(e.path)}${e.prefix ? "…" : ""}\` | \`${e.handler}\` | ${e.via} |`)
    }
    out.push("", `**Files (${f.files.length}):** ${f.files.map((p) => `\`${p}\``).join(" ") || "—"}${f.shared.length ? ` · +${f.shared.length} shared` : ""}`)
  }
  return out.join("\n")
}
