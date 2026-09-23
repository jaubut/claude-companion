import { existsSync } from "node:fs"
import { basename } from "node:path"

// Artifact detection (Phase 19 step 3, RES-B9CL) — pure scan of one text
// (an assistant text block or a tool_result's text) for things worth a card in
// the feed: GitHub PRs, TLS note refs, and existing files of known types.
// Plain https URLs are deliberately NOT artifacts: far too noisy. The only
// side effect is the injectable existence check for file paths.

export type ArtifactKind = "pr" | "note" | "file" | "url"

export interface Artifact {
  kind: ArtifactKind
  title: string
  url?: string
  path?: string
  ref?: string
}

export const ARTIFACTS_PER_BLOCK = 5

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g
const NOTE_REF = /\b(?:RES|PRJ|IDE|TIK|MTG)-[A-Z0-9]{4}\b/g
// File paths are found by a LINEAR scan, not a regex over the whole text: a
// lazy `[^…]+?` before the extension backtracks quadratically on inputs like
// "/".repeat(30000) (8 s on Bun, blocking hooks and sockets). Candidates are
// (a) quoted / backticked segments starting with `/` — spaces allowed — and
// (b) bare tokens starting with `/` at a non-path boundary. Each candidate is
// bounded, then checked against the extension list anchored at its end.
const FILE_EXT = /\.(?:png|jpe?g|gif|webp|pdf|md|xml|fcpxml|mov|mp4)$/i
const MAX_PATH_CANDIDATES = 200
const BARE_STOP = new Set([" ", "\t", "\n", "\r", "'", '"', "`", "<", ">", "(", ")", "[", "]", "{", "}", "|", "*"])
const TRAILING_PUNCT = /[.,;:!?)\]}]+$/

// True when `text[i]` is a `/` that can start a path: not the tail of a URL
// (`https://host/x.png`) or of a relative path (`a/b.md`).
function pathStart(text: string, i: number): boolean {
  if (text[i] !== "/") return false
  if (i === 0) return true
  const c = text[i - 1]!
  return !(/[\w:/.~-]/.test(c))
}

function stripTrailing(tok: string): string {
  return tok.replace(TRAILING_PUNCT, "")
}

// Yields candidate paths in text order with their start index.
function pathCandidates(text: string): Array<{ index: number; path: string }> {
  const out: Array<{ index: number; path: string }> = []
  const n = text.length
  let i = 0
  while (i < n && out.length < MAX_PATH_CANDIDATES) {
    const c = text[i]!
    if (c === '"' || c === "'" || c === "`") {
      // Quoted segment: take it whole if it is an absolute path.
      const close = text.indexOf(c, i + 1)
      if (close > i + 1 && text[i + 1] === "/" && close - i <= 4096 && !text.slice(i + 1, close).includes("\n")) {
        const path = text.slice(i + 1, close)
        if (FILE_EXT.test(path)) out.push({ index: i + 1, path })
        i = close + 1
        continue
      }
      i++
      continue
    }
    if (pathStart(text, i)) {
      let j = i + 1
      while (j < n && !BARE_STOP.has(text[j]!) && j - i <= 4096) j++
      const path = stripTrailing(text.slice(i, j))
      if (path.length > 1 && FILE_EXT.test(path)) out.push({ index: i, path })
      i = Math.max(j, i + 1)
      continue
    }
    i++
  }
  return out
}

interface Hit {
  index: number
  key: string
  artifact: Artifact
}

// Returns at most ARTIFACTS_PER_BLOCK artifacts in text order, one per
// distinct PR url / note ref / file path.
export function detectArtifacts(
  text: string,
  exists: (path: string) => boolean = existsSync,
): Artifact[] {
  if (!text) return []
  const hits = [...prHits(text), ...noteHits(text), ...fileHits(text, exists)]
  hits.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const out: Artifact[] = []
  for (const hit of hits) {
    if (seen.has(hit.key)) continue
    seen.add(hit.key)
    out.push(hit.artifact)
    if (out.length >= ARTIFACTS_PER_BLOCK) break
  }
  return out
}

// Stable identity for dedupe across reads: the url, ref or path.
export function artifactKey(a: Artifact): string {
  // GitHub owner/repo are case-insensitive: one identity for Owner/Repo and
  // owner/repo, matching the within-block dedupe.
  const id = a.kind === "pr" ? (a.url ?? "").toLowerCase() : (a.url ?? a.ref ?? a.path ?? a.title)
  return `art:${a.kind}:${id}`
}

function prHits(text: string): Hit[] {
  const out: Hit[] = []
  for (const m of text.matchAll(PR_URL)) {
    const [, owner, repo, num] = m
    const url = `https://github.com/${owner}/${repo}/pull/${num}`
    out.push({
      index: m.index ?? 0,
      key: `pr:${url.toLowerCase()}`,
      artifact: { kind: "pr", title: `PR #${num} · ${repo}`, url },
    })
  }
  return out
}

function noteHits(text: string): Hit[] {
  const out: Hit[] = []
  for (const m of text.matchAll(NOTE_REF)) {
    const ref = m[0]
    out.push({ index: m.index ?? 0, key: `note:${ref}`, artifact: { kind: "note", title: ref, ref } })
  }
  return out
}

function fileHits(text: string, exists: (path: string) => boolean): Hit[] {
  const out: Hit[] = []
  const checked = new Map<string, boolean>()
  for (const { index, path } of pathCandidates(text)) {
    let ok = checked.get(path)
    if (ok === undefined) {
      try { ok = exists(path) } catch { ok = false }
      checked.set(path, ok)
    }
    if (!ok) continue
    out.push({ index, key: `file:${path}`, artifact: { kind: "file", title: basename(path), path } })
  }
  return out
}
