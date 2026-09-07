import type { ArchMap, RepoConfig, ImportRule } from "./types"

// Boundary lint: file caps + import rules from archmap.json. Pure — the CLI
// prints and sets the exit code.
//
// Caps ratchet: a module over cap FAILS only if it is new or grew past the
// size recorded in the baseline map (the base branch's architecture.json).
// Pre-existing debt is reported as `legacy` and never blocks — so the lint
// can go into CI of a brownfield repo on day one and only stops files from
// getting worse. Import rules always fail.

export interface LintIssue {
  target: string
  module: string
  rule: string       // "cap" | "cap-legacy" | the rule's `why`
  detail: string
  blocking: boolean
}

// Target-relative path glob → regex. `**` spans directories, `*` one segment, `?` one char.
export function globToRegex(glob: string): RegExp {
  const src = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*\*$|\*\*\/|\*\*|\*|\?/g, (tok) =>
      tok === "/**" ? "(?:/.*)?" : tok === "**/" ? "(?:.*/)?" : tok === "**" ? ".*" : tok === "*" ? "[^/]*" : "[^/]")
  return new RegExp(`^${src}$`)
}

function matchesAny(path: string, globs: string[]): string | null {
  for (const g of globs) if (globToRegex(g).test(path)) return g
  return null
}

export function lint(map: ArchMap, cfg: RepoConfig, baseline?: ArchMap | null): LintIssue[] {
  const issues: LintIssue[] = []
  const baseLines = new Map<string, number>()
  for (const t of baseline?.targets ?? []) for (const m of t.modules) baseLines.set(`${t.name}/${m.path}`, m.lines)
  for (const t of map.targets) for (const m of t.modules) {
    if (m.lines <= t.cap) continue
    const prev = baseLines.get(`${t.name}/${m.path}`)
    const legacy = prev !== undefined && prev > t.cap && m.lines <= prev
    issues.push({
      target: t.name, module: m.path, rule: legacy ? "cap-legacy" : "cap", blocking: !legacy,
      detail: legacy ? `${m.lines} lines > cap ${t.cap} (legacy, ${prev} in baseline)` : prev !== undefined && prev > t.cap ? `${m.lines} lines > cap ${t.cap}, grew from ${prev}` : `${m.lines} lines > cap ${t.cap}`,
    })
  }
  for (const rule of cfg.rules ?? []) {
    const t = map.targets.find((x) => x.name === rule.target)
    if (!t) { issues.push({ target: rule.target, module: "-", rule: rule.why, detail: `rule targets unknown target "${rule.target}"`, blocking: true }); continue }
    const froms = Array.isArray(rule.from) ? rule.from : [rule.from]
    for (const m of t.modules) {
      if (!matchesAny(m.path, froms)) continue
      for (const imp of m.imports) {
        const hit = matchesAny(imp, rule.deny)
        if (hit) issues.push({ target: t.name, module: m.path, rule: rule.why, detail: `imports ${imp} (denied by ${hit})`, blocking: true })
      }
    }
  }
  return issues
}

export function formatIssues(issues: LintIssue[]): string {
  return issues.map((i) => `  ${i.blocking ? "FAIL" : "warn"} ${i.target}/${i.module}: ${i.detail} -- ${i.rule}`).join("\n")
}

export type { ImportRule }
