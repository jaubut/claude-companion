import { basename } from "node:path"
import { type RepoEntry, isDir as realIsDir, parseRepoMap } from "./live-repo"

// Everything the front door can resolve a message to: every project note (any
// status — an archived or done project is still a valid "is X on latest nuxt?"
// target) plus the REPO_MAP repos, each with the aliases a human would type
// ("chantalmasse.com" → the chantal-masse-website note). Pure; the wiring passes
// the notes (Turso) and the dispatch-run.ts source text.

export interface ProjectNote { noteId: string; ref: string | null; title: string; status: string | null }

export interface Candidate {
  /** Jev option key: a readable slug, unique within the catalog. */
  key: string
  kind: "note" | "repo"
  noteId: string | null
  ref: string | null
  title: string
  status: string | null
  /** Local checkout, when one exists on this host. */
  repo: string | null
  /** Mapped in REPO_MAP (the checkout may live on the other host). */
  repoKnown: boolean
  aliases: string[]
}

export interface Catalog { candidates: Candidate[]; byKey: Map<string, Candidate> }

/** Max Jev Choice options is 255; one is "none". */
export const MAX_CANDIDATES = 250
export const NONE_KEY = "none"
const MIN_ALIAS = 6
const GENERIC_TAIL = new Set(["website", "site", "web", "app", "ios"])

/** Lowercase, accents and punctuation stripped: "Chantal Massé — Website" → "chantalmassewebsite". */
export function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** "projects/2026-03-26-chantal-masse-website" → "chantal-masse-website". */
export function noteSlug(noteId: string): string {
  return noteId.replace(/^.*\//, "").replace(/^\d{4}-\d{2}-\d{2}-/, "")
}

/** Literal alternatives of a REPO_MAP regex: /chantal-masse-website|review\.cherrypik/ → both. */
export function regexAliases(re: RegExp): string[] {
  return re.source.split("|").map((a) => a.replace(/\\\./g, ".")).filter((a) => a && !/[\\()[\]{}*+?^$]/.test(a))
}

function slugTail(slug: string): string | null {
  const parts = slug.split("-")
  while (parts.length > 1 && GENERIC_TAIL.has(parts[parts.length - 1]!)) parts.pop()
  const out = parts.join("-")
  return out !== slug ? out : null
}

interface RepoGroup { re: RegExp; paths: string[]; local: string | null }

function groupRepoMap(entries: RepoEntry[], isDir: (p: string) => boolean): RepoGroup[] {
  const groups = new Map<string, RepoGroup>()
  for (const e of entries) {
    const id = `${e.match.source}/${e.match.flags}`
    const g = groups.get(id) ?? { re: e.match, paths: [], local: null }
    g.paths.push(e.path)
    if (!g.local && isDir(e.path)) g.local = e.path
    groups.set(id, g)
  }
  return [...groups.values()]
}

const repoName = (path: string): string => basename(path).replace(/^\./, "").toLowerCase().replace(/\s+/g, "-") || "repo"

function uniqueKey(base: string, used: Set<string>): string {
  let key = base || "project"
  for (let i = 2; used.has(key) || key === NONE_KEY; i++) key = `${base}-${i}`
  used.add(key)
  return key
}

const dedupe = (xs: (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x && !!x.trim()))]

export function buildCatalog(
  notes: ProjectNote[], repoSource: string | null, opts: { home?: string; isDir?: (p: string) => boolean } = {},
): Catalog {
  const isDir = opts.isDir ?? realIsDir
  const groups = repoSource ? groupRepoMap(parseRepoMap(repoSource, opts.home), isDir) : []
  const used = new Set<string>()
  const matched = new Set<RepoGroup>()
  // Active first: when the 250 cap bites, old done/archived notes go first.
  const ordered = [...notes].sort((a, b) => Number(b.status === "active") - Number(a.status === "active"))
  const candidates: Candidate[] = []
  for (const n of ordered) {
    const hay = `${n.noteId} ${n.title}`
    const hits = groups.filter((g) => g.re.test(hay))
    for (const g of hits) matched.add(g)
    const local = hits.find((g) => g.local)?.local ?? null
    const slug = noteSlug(n.noteId)
    candidates.push({
      key: uniqueKey(slug, used), kind: "note", noteId: n.noteId, ref: n.ref, title: n.title, status: n.status,
      repo: local, repoKnown: hits.length > 0,
      aliases: dedupe([slug, slugTail(slug), n.ref, n.title, ...hits.flatMap((g) => regexAliases(g.re)), ...(local ? [repoName(local)] : [])]),
    })
  }
  for (const g of groups) {
    if (matched.has(g)) continue
    const name = repoName(g.local ?? g.paths[0]!)
    candidates.push({
      key: uniqueKey(`repo-${name}`, used), kind: "repo", noteId: null, ref: null, title: `${name} (code repo)`, status: null,
      repo: g.local, repoKnown: true, aliases: dedupe([name, ...regexAliases(g.re)]),
    })
  }
  const capped = candidates.slice(0, MAX_CANDIDATES)
  return { candidates: capped, byKey: new Map(capped.map((c) => [c.key, c])) }
}

/** Code-side resolution: the longest alias (≥ 6 normalized chars) found in the text. */
export function matchAlias(text: string, catalog: Catalog): Candidate | null {
  const hay = normalize(text)
  let best: { c: Candidate; len: number } | null = null
  for (const c of catalog.candidates) {
    for (const a of c.aliases) {
      const n = normalize(a)
      if (n.length < MIN_ALIAS || !hay.includes(n)) continue
      const better = !best || n.length > best.len || (n.length === best.len && rank(c) > rank(best.c))
      if (better) best = { c, len: n.length }
    }
  }
  return best?.c ?? null
}

// Tie-break: a note with a local repo, then any note, then active.
const rank = (c: Candidate): number => (c.repo ? 4 : 0) + (c.kind === "note" ? 2 : 0) + (c.status === "active" ? 1 : 0)

/** Jev Choice criteria: one description per candidate + "none". */
export function jevCriteria(catalog: Catalog): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of catalog.candidates) {
    const status = c.status && c.status !== "active" ? ` [${c.status}]` : ""
    const aka = c.aliases.filter((a) => a !== c.title).slice(0, 6).join(", ")
    const repo = c.repo ? `. Code repo: ${basename(c.repo)}` : c.repoKnown ? ". Has a code repo" : ""
    out[c.key] = `${c.title}${status}${aka ? `. Also called: ${aka}` : ""}${repo}`.slice(0, 220)
  }
  out[NONE_KEY] = "The message names no specific project, client website or code repository, or one that is not in this list."
  return out
}

/** Brain prompt lines: every project (status, repo) and every repo-only entry. */
export function catalogLines(catalog: Catalog, max = 160): string[] {
  return catalog.candidates.slice(0, max).map((c) => {
    if (c.kind === "repo") return `  - repo ${c.key.replace(/^repo-/, "")}: ${c.repo ?? "(checkout on the other host)"}`
    const status = c.status && c.status !== "active" ? ` [${c.status}]` : ""
    const repo = c.repo ? ` → repo ${c.repo}` : c.repoKnown ? " → repo on the other host" : ""
    return `  - ${c.noteId}${c.ref ? ` (${c.ref})` : ""}: ${c.title}${status}${repo}`
  })
}
