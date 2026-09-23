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
// An absolute path: `/` not preceded by a path/URL char (so the tail of
// `https://host/x.png` or `a/b.md` never matches), no whitespace or quoting
// chars inside, a known extension, then a boundary.
const FILE_PATH =
  /(?<![\w:/.~-])\/[^\s'"`<>()[\]{}|*]+?\.(?:png|jpe?g|gif|webp|pdf|md|xml|fcpxml|mov|mp4)(?![\w/-]|\.\w)/gi

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
  return `art:${a.kind}:${a.url ?? a.ref ?? a.path ?? a.title}`
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
  for (const m of text.matchAll(FILE_PATH)) {
    const path = m[0]
    let ok = checked.get(path)
    if (ok === undefined) {
      try { ok = exists(path) } catch { ok = false }
      checked.set(path, ok)
    }
    if (!ok) continue
    out.push({ index: m.index ?? 0, key: `file:${path}`, artifact: { kind: "file", title: basename(path), path } })
  }
  return out
}
