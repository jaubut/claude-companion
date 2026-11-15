import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ArchMap, RepoConfig, ImportRule } from "./types"
import { walk, rel, resolveRoot } from "./adapters/shared"

// Boundary lint: file caps + import rules from archmap.json. Pure — the CLI
// prints and sets the exit code.
//
// Only import rules block. Line counts never decide the exit status: every
// cap finding is a warning with the count, and the growth vs the baseline map
// (the base branch's architecture.json) when the file was already over —
// `cap` for a new crossing or growth, `cap-legacy` for pre-existing debt that
// did not grow — so reviewers judge the split. `test` modules (sized in the
// map for drift checks) are out of both caps and rules.
// Split rule (baseline only, warns): a new numbered/part/misc file beside a
// stem — the detail says whether the stem shrank or vanished since the baseline.

export interface LintIssue {
  target: string
  module: string
  rule: string       // "cap" | "cap-legacy" | "split" | the rule's `why`
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

export const SPLIT_HINT = "split by responsibility into modules named for their concern; do not compact, reformat, strip comments or chunk into numbered/part/misc files"

// foo-2.ts, foo_part.ts, foo-misc.ts ... → "foo". Separator required so http2/oauth2/sha256 never match.
// rest/utils can name a real concern (client-rest.ts), so they only ever warn.
const GRAB_BAG = /^(.+?)[-_](\d+|part\d*|misc|extra|more|rest|utils)$/i
const AMBIGUOUS = /^(?:rest|utils)$/i

function grabBagStem(path: string): { stem: string; ambiguous: boolean } | null {
  const m = /^(.*\/)?([^/]+?)(\.[^./]+)$/.exec(path)
  const hit = m && GRAB_BAG.exec(m[2]!)
  return hit ? { stem: `${m![1] ?? ""}${hit[1]}${m![3]}`, ambiguous: AMBIGUOUS.test(hit[2]!) } : null
}

export function lint(map: ArchMap, cfg: RepoConfig, baseline?: ArchMap | null): LintIssue[] {
  const issues: LintIssue[] = []
  const baseLines = new Map<string, number>()
  for (const t of baseline?.targets ?? []) for (const m of t.modules) baseLines.set(`${t.name}/${m.path}`, m.lines)
  // Grab-bag splits need a baseline to know what is new; without one, skip.
  // Evidence of a split (the stem existed in the baseline and shrank or was
  // removed) and a name-only match (client-rest.ts beside an untouched
  // client.ts) both warn; the detail tells them apart.
  if (baseline) for (const t of map.targets) {
    const now = new Map(t.modules.map((m) => [m.path, m.lines]))
    for (const m of t.modules) {
      if (m.kind === "test" || baseLines.has(`${t.name}/${m.path}`)) continue
      const hit = grabBagStem(m.path)
      if (!hit) continue
      const { stem, ambiguous } = hit
      const before = baseLines.get(`${t.name}/${stem}`)
      const after = now.get(stem)
      if (before === undefined && after === undefined) continue
      const shrank = before !== undefined && (after === undefined || after < before)
      const split = shrank && !ambiguous
      issues.push({
        target: t.name, module: m.path, rule: "split", blocking: false,
        detail: split ? `new grab-bag split of ${stem}: ${SPLIT_HINT}`
          : shrank ? `possible grab-bag split of ${stem} (ambiguous suffix): ${SPLIT_HINT}`
          : `possible grab-bag split of ${stem} (name only; ${stem} did not shrink): ${SPLIT_HINT}`,
      })
    }
  }
  for (const t of map.targets) for (const m of t.modules) {
    if (m.lines <= t.cap || m.kind === "test") continue
    const prev = baseLines.get(`${t.name}/${m.path}`)
    const legacy = prev !== undefined && prev > t.cap && m.lines <= prev
    issues.push({
      target: t.name, module: m.path, rule: legacy ? "cap-legacy" : "cap", blocking: false,
      detail: legacy ? `${m.lines} lines > cap ${t.cap} (legacy, ${prev} in baseline)` : prev !== undefined && prev > t.cap ? `${m.lines} lines > cap ${t.cap}, grew from ${prev}; ${SPLIT_HINT}` : `${m.lines} lines > cap ${t.cap}; ${SPLIT_HINT}`,
    })
  }
  for (const rule of cfg.rules ?? []) {
    const t = map.targets.find((x) => x.name === rule.target)
    if (!t) { issues.push({ target: rule.target, module: "-", rule: rule.why, detail: `rule targets unknown target "${rule.target}"`, blocking: true }); continue }
    const froms = Array.isArray(rule.from) ? rule.from : [rule.from]
    for (const m of t.modules) {
      if (m.kind === "test" || !matchesAny(m.path, froms)) continue
      for (const imp of m.imports) {
        const hit = matchesAny(imp, rule.deny)
        if (hit) issues.push({ target: t.name, module: m.path, rule: rule.why, detail: `imports ${imp} (denied by ${hit})`, blocking: true })
      }
    }
  }
  return issues
}

// Vendored-copy drift (`mirrors[]` in archmap.json): every target file
// (its `glob`, else the adapter default: `**/*.sh` for shell-hooks, all files otherwise) must be byte-identical to the same relative path
// under the mirror. Reads the disk, unlike lint(). A mirror directory absent on
// this host (CI) is skipped; a file missing from a present mirror is drift.
export const SHELL_GLOB = "**/*.sh"

export function mirrorDrift(cfg: RepoConfig, repoRoot: string): LintIssue[] {
  const issues: LintIssue[] = []
  for (const mr of cfg.mirrors ?? []) {
    const why = `vendored copy drifted from ${mr.mirror}`
    const t = cfg.targets.find((x) => x.name === mr.target)
    if (!t) { issues.push({ target: mr.target, module: "-", rule: why, detail: `mirror targets unknown target "${mr.target}"`, blocking: true }); continue }
    const mirror = resolveRoot(repoRoot, mr.mirror)
    if (!existsSync(mirror)) continue
    const root = resolveRoot(repoRoot, t.root)
    const re = globToRegex(t.glob ?? (t.adapter === "shell-hooks" ? SHELL_GLOB : "**"))
    for (const f of walk(root, [""], t.ignore)) {
      const p = rel(root, f)
      if (!re.test(p) || matchesAny(p, mr.exclude ?? [])) continue
      const other = join(mirror, p)
      if (!existsSync(other)) issues.push({ target: t.name, module: p, rule: why, detail: `missing from ${mr.mirror}`, blocking: true })
      else if (!readFileSync(f).equals(readFileSync(other))) issues.push({ target: t.name, module: p, rule: why, detail: `differs from ${join(mr.mirror, p)}`, blocking: true })
    }
  }
  return issues
}

export function formatIssues(issues: LintIssue[]): string {
  return issues.map((i) => `  ${i.blocking ? "FAIL" : "warn"} ${i.target}/${i.module}: ${i.detail} -- ${i.rule}`).join("\n")
}

export type { ImportRule }
