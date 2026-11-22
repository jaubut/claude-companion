// The neutral conflict resolver (bin/pr-resolve-conflicts): a fresh, minimal-context worker on a conflicting agent
// PR's head. It never resumes the feature author's session, so it reads both sides of the merge without that
// transcript's bias. Dispatch workers cannot create merge commits through GitHub; this one does it locally.

export const CONFLICT_RESOLVER_MODEL = "claude-sonnet-5-5"

export interface ConflictResolverPr {
  repo: string; pr: number; url: string; title: string
  headRefName: string; baseRefName: string; headRefOid: string; reason: string
}

/** `conflict-<repo>-pr<n>-<head8>`: one resolver per PR head, so a pushed resolution (new head) may get a new one. */
export function conflictTaskId(repo: string, pr: number, headRefOid: string): string {
  const slug = (repo.split("/").pop() ?? repo).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 30)
  return `conflict-${slug}-pr${pr}-${headRefOid.slice(0, 8)}`
}

export function buildConflictResolverPrompt(p: ConflictResolverPr): string {
  const base = `origin/${p.baseRefName}`
  return [
    `You are a neutral third-party merge-conflict resolver for ${p.repo}#${p.pr} ("${p.title.slice(0, 120)}", ${p.url}).`,
    `You did not write this PR and have no transcript of its author: judge both sides only by what the code and the commit logs say.`,
    `Why you were called: ${p.reason}`,
    `Your worktree is on a fresh local branch at the tip of \`origin/${p.headRefName}\` (${p.headRefOid.slice(0, 12)}), the PR's head. The PR already exists: never open a second one.`,
    "",
    "Steps:",
    `1. \`git fetch origin ${p.baseRefName} ${p.headRefName}\`. Inspect both sides: \`git log --oneline ${base}..HEAD\` (what the PR adds) and \`git log --oneline HEAD..${base}\` (what the base gained).`,
    `2. \`git merge --no-ff --no-commit ${base}\`. List the conflicts with \`git diff --name-only --diff-filter=U\`.`,
    "3. Resolve each conflicted file by its class:",
    "   - lockfiles (bun.lock, package-lock.json, ...): regenerate with the package manager, never hand-edit.",
    "   - generated files (architecture.json, architecture.md, FEATUREMAP.md): take either side, then regenerate with the repo's generator (see FIELD_GUIDE.md / CI).",
    "   - STATE.md: keep both sides' entries, in chronological order.",
    "   - source and tests: merge hunk by hunk, preserving both sides' intent. Never drop a file diff the PR adds, never weaken or delete an assertion to make it pass.",
    "4. Verify: `git diff --check` is clean, `grep -rn '^<<<<<<<\\|^>>>>>>>' .` finds no conflict marker in tracked files, and the repo's typecheck and tests pass (find the commands in package.json / CI).",
    "5. Commit the merge (`git add -A && git commit --no-edit`).",
    `6. Push exactly \`git push origin HEAD:refs/heads/${p.headRefName}\`. Never force-push, never push another branch, never merge the PR.`,
    "",
    "If a conflict cannot be resolved without a product decision, or checks fail for a reason outside the merge, do not push: abort (`git merge --abort`) and report precisely what blocks.",
    `Final report: the PR link (${p.url}), the files you resolved by class, the checks you ran with their result, and the new head sha.`,
  ].join("\n")
}
