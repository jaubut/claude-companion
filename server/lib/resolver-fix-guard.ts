import type { ShResult } from "./resolver-fix"

// The post-run guard of an Opus fix run (lib/resolver-fix.ts), before any push:
//   1. the pre-fix PR head must still be an ancestor of the fix head (no reset
//      to main, no history rewrite);
//   2. no "PR change dropped": a file the PR changed (merge-base → PR head)
//      that the fix touched and left byte-identical to the base branch's (or
//      the merge-base's) version, i.e. the PR's side was fully reverted — what
//      a blanket `-X theirs` merge or a whole-tree `checkout --theirs` does.
// Blob ids via `git ls-tree`, so the comparison is exact (missing = deleted).

export type GitFn = (cwd: string, ...args: string[]) => Promise<ShResult>

export type GuardVerdict = { ok: true } | { ok: false; reason: string; files: string[] }

const nameList = (out: string): string[] => out.split("\0").map((s) => s.trim()).filter(Boolean)

/** path → blob id at `rev` for the given paths (absent = not in the tree). */
async function blobs(git: GitFn, dir: string, rev: string, paths: string[]): Promise<Map<string, string>> {
  const m = new Map<string, string>()
  if (!paths.length) return m
  const r = await git(dir, "ls-tree", "-z", "--full-tree", rev, "--", ...paths)
  if (!r.ok) throw new Error(`ls-tree ${rev} failed: ${(r.err || r.out).slice(0, 120)}`)
  for (const entry of r.out.split("\0")) {
    const tab = entry.indexOf("\t")
    if (tab < 0) continue
    const [, , sha] = entry.slice(0, tab).split(" ")
    if (sha) m.set(entry.slice(tab + 1), sha)
  }
  return m
}

/** Files the PR changed whose PR-side change the fix range (prHead..fixHead) fully reverted to the base's version. */
export async function droppedPrChanges(git: GitFn, dir: string, prHead: string, baseRef: string, fixHead = "HEAD"): Promise<string[]> {
  const mb = await git(dir, "merge-base", prHead, baseRef)
  if (!mb.ok) throw new Error(`merge-base failed: ${(mb.err || mb.out).slice(0, 120)}`)
  const base = mb.out.trim()
  const prFiles = await git(dir, "diff", "--no-renames", "--name-only", "-z", base, prHead)
  const fixFiles = await git(dir, "diff", "--no-renames", "--name-only", "-z", prHead, fixHead)
  if (!prFiles.ok || !fixFiles.ok) throw new Error("git diff failed")
  const touched = new Set(nameList(fixFiles.out))
  const both = nameList(prFiles.out).filter((f) => touched.has(f))
  if (!both.length) return []
  const [atPr, atFix, atBase, atMb] = await Promise.all([prHead, fixHead, baseRef, base].map((rev) => blobs(git, dir, rev, both)))
  return both.filter((f) => {
    const fix = atFix!.get(f) ?? null
    const pr = atPr!.get(f) ?? null
    if (fix === pr) return false
    // Reverted to main's current version or to the version the PR started from.
    return fix === (atBase!.get(f) ?? null) || fix === (atMb!.get(f) ?? null)
  })
}

/** Both guards; never throws (a git error is a refusal to push). */
export async function guardFixRange(git: GitFn, dir: string, prHead: string, baseRef: string): Promise<GuardVerdict> {
  try {
    const anc = await git(dir, "merge-base", "--is-ancestor", prHead, "HEAD")
    if (!anc.ok) return { ok: false, reason: "the fix rewrote the PR's history (the PR head is no longer an ancestor)", files: [] }
    const dropped = await droppedPrChanges(git, dir, prHead, baseRef)
    if (dropped.length) {
      const list = dropped.slice(0, 8).join(", ") + (dropped.length > 8 ? ` (+${dropped.length - 8} more)` : "")
      return { ok: false, reason: `fix would drop the PR's changes in ${list}`, files: dropped }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: `could not verify the fix against the PR (${(err as Error)?.message ?? "git error"})`, files: [] }
  }
}
