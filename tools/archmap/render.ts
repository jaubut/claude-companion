import type { ArchMap, Target, ModuleInfo, Endpoint } from "./types"

// Markdown view of the map. Per target: modules (cap flagged), then the
// cross-target contracts — every WS frame with who emits and who consumes it,
// every endpoint with its handler and callers, hook endpoints, and fan-in
// (exports called from more than one module), which is where fan-in bugs live.
// Referenced maps (sibling repos joined by reference) take part in the contract
// tables only.

export interface RefTarget extends Target {
  ref: string        // ref name
  repo: string       // resolved repo path
  generatedAt: string
}

function flag(m: ModuleInfo, cap: number): string {
  return m.lines > cap ? ` ⚠ ${m.lines} > cap ${cap}` : ""
}

function moduleTable(t: Target): string {
  const rows = t.modules
    .slice()
    .sort((a, b) => b.lines - a.lines)
    .map((m) => {
      const bits: string[] = []
      if (m.state.length) bits.push(`state: ${m.state.join(", ")}`)
      if (m.emits.length) bits.push(`emits: ${m.emits.join(", ")}`)
      if (m.endpoints.length) bits.push(m.endpoints.length === 1 ? `route: ${m.endpoints[0]!.method} ${m.endpoints[0]!.path}` : `routes: ${m.endpoints.length}`)
      if (m.apiCalls.length) bits.push(`calls: ${m.apiCalls.join(", ")}`)
      if (m.listeners.length) bits.push(`listens: ${m.listeners.join(", ")}`)
      if (m.sheets) bits.push(`sheets: ${m.sheets}`)
      return `| \`${m.path}\` | ${m.lines}${flag(m, t.cap)} | ${m.kind} | ${m.exports.length} | ${bits.join(" · ").replace(/\|/g, "\\|")} |`
    })
  return ["| module | lines | kind | exports | contracts |", "|---|---|---|---|---|", ...rows].join("\n")
}

// One row per external package across the repo's targets: pinned version(s),
// how many modules import it, which targets. Sorted by module count — the top
// of this table is what a dependency change hits first.
export function externalsTable(map: ArchMap): string {
  const acc = new Map<string, { versions: Set<string>; modules: number; targets: Set<string> }>()
  for (const t of map.targets) for (const [pkg, use] of Object.entries(t.packages ?? {})) {
    const e = acc.get(pkg) ?? acc.set(pkg, { versions: new Set(), modules: 0, targets: new Set() }).get(pkg)!
    e.versions.add(use.version ?? "—")
    e.modules += use.modules.length
    e.targets.add(t.name)
  }
  if (!acc.size) return ""
  const rows = [...acc.entries()].sort((a, b) => b[1].modules - a[1].modules || a[0].localeCompare(b[0]))
    .map(([pkg, e]) => `| \`${pkg}\` | ${[...e.versions].join(", ")} | ${e.modules} | ${[...e.targets].join(", ")} |`)
  return ["## External packages", "", "| package | version | modules | targets |", "|---|---|---|---|", ...rows].join("\n")
}

// `/api/note/:id` matches `/api/note/:p` and `/api/note/abc`; prefix routes match by startsWith.
export function pathMatches(e: Endpoint, call: string): boolean {
  if (e.prefix) return call.startsWith(e.path)
  const a = e.path.split("/"), b = call.split("/")
  if (a.length !== b.length) return false
  return a.every((seg, i) => seg.startsWith(":") || seg === "*" || b[i]!.startsWith(":") || seg === b[i])
}

function allTargets(map: ArchMap, refs: RefTarget[]): Target[] {
  return [...map.targets, ...refs.map((r) => ({ ...r, name: `${r.ref}:${r.name}` }))]
}

export function frameIndex(map: ArchMap, refs: RefTarget[] = []): Record<string, { emitters: string[]; consumers: string[] }> {
  const idx: Record<string, { emitters: string[]; consumers: string[] }> = {}
  const targets = allTargets(map, refs)
  for (const t of targets) for (const m of t.modules) for (const f of m.emits) {
    if (f.startsWith(".")) continue
    ;(idx[f] ??= { emitters: [], consumers: [] }).emitters.push(`${t.name}/${m.path}`)
  }
  for (const t of targets) for (const m of t.modules) for (const f of m.consumes) {
    if (idx[f]) idx[f]!.consumers.push(`${t.name}/${m.path}`)
  }
  return idx
}

export function endpointIndex(map: ArchMap, refs: RefTarget[] = []): { key: string; handler: string; callers: string[]; hook: boolean; page: boolean }[] {
  const out: { key: string; handler: string; callers: string[]; hook: boolean; page: boolean }[] = []
  const callers: { path: string; from: string }[] = []
  const targets = allTargets(map, refs)
  for (const t of targets) for (const m of t.modules) for (const p of m.apiCalls) callers.push({ path: p, from: `${t.name}/${m.path}` })
  for (const t of targets) for (const m of t.modules) for (const e of m.endpoints) {
    const matches = callers.filter((c) => pathMatches(e, c.path)).map((c) => c.from)
    out.push({ key: `${e.method} ${e.path}${e.prefix ? "…" : ""}`, handler: `${t.name}/${m.path}`, callers: [...new Set(matches)], hook: e.path.startsWith("/hooks/"), page: e.method === "PAGE" })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

export function renderMarkdown(map: ArchMap, refs: RefTarget[] = [], unresolved: string[] = []): string {
  const out: string[] = []
  out.push(`# Architecture — ${map.repo}`, "", `Generated by archmap on ${map.generatedAt}. Do not edit; regenerate with \`bun run ~/.claude/tools/archmap/cli.ts .\` (or \`tools/archmap/cli.ts .\` where vendored).`, "")
  if (map.intent) out.push("## Intent", "", map.intent, "")
  for (const t of map.targets) {
    const over = t.modules.filter((m) => m.lines > t.cap)
    out.push(`## ${t.name} (${t.adapter}, \`${t.root}/\`, ${t.modules.length} modules, cap ${t.cap})`, "")
    if (over.length) out.push(`⚠ over cap: ${over.map((m) => `\`${m.path}\` (${m.lines})`).join(", ")}`, "")
    out.push(moduleTable(t), "")
  }
  const ext = externalsTable(map)
  if (ext) out.push(ext, "")
  if (refs.length || unresolved.length) {
    out.push("## Referenced maps (joined by reference — regenerate the sibling to refresh)", "")
    for (const r of refs) out.push(`- \`${r.ref}:${r.name}\` — \`${r.repo}/architecture.json\` generated ${r.generatedAt}, ${r.modules.length} modules`)
    for (const u of unresolved) out.push(`- ⚠ ${u} — not found on this machine; its consumers are missing below`)
    out.push("")
  }
  const frames = frameIndex(map, refs)
  const fkeys = Object.keys(frames).sort()
  if (fkeys.length) {
    out.push("## Contracts — WS frames", "", "| frame | emitted by | consumed by |", "|---|---|---|")
    for (const f of fkeys) {
      const v = frames[f]!
      out.push(`| \`${f}\` | ${v.emitters.join(", ")} | ${v.consumers.length ? v.consumers.join(", ") : "— (no consumer found)"} |`)
    }
    out.push("")
  }
  const eps = endpointIndex(map, refs)
  const api = eps.filter((x) => !x.hook && !x.page)
  if (api.length) {
    out.push("## Contracts — endpoints", "", "| route | handler | called by |", "|---|---|---|")
    for (const e of api) out.push(`| \`${e.key}\` | ${e.handler} | ${e.callers.join(", ") || "—"} |`)
    out.push("")
  }
  const hooks = eps.filter((x) => x.hook)
  if (hooks.length) {
    out.push("## Contracts — hook endpoints (Claude Code → server)", "", "| route | handler |", "|---|---|")
    for (const e of hooks) out.push(`| \`${e.key}\` | ${e.handler} |`)
    out.push("")
  }
  const pages = eps.filter((x) => x.page)
  if (pages.length) {
    out.push("## Pages", "", "| route | page |", "|---|---|")
    for (const e of pages) out.push(`| \`${e.key.replace(/^PAGE /, "")}\` | ${e.handler} |`)
    out.push("")
  }
  for (const t of map.targets) {
    const multi = Object.entries(t.fanIn).filter(([, v]) => v.callers.length >= 2).sort((a, b) => b[1].callers.length - a[1].callers.length)
    if (!multi.length) continue
    out.push(`## Fan-in — ${t.name} (exports reached from 2+ modules)`, "", "| export | owner | callers |", "|---|---|---|")
    for (const [name, v] of multi) out.push(`| \`${name}${name.includes(":") ? "" : "()"}\` | \`${v.module}\` | ${v.callers.map((c) => `\`${c}\``).join(", ")} |`)
    out.push("")
  }
  return out.join("\n")
}
