import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { join, sep } from "node:path"
import { workerFooter } from "./worker-invocation"

// FIELD_GUIDE.md: a short, line-capped list of operational traps injected into a worker's first prompt
// (AGENTS.md style), kept apart from long historical logs like STATE.md. Never reloaded on --resume.

export const FIELD_GUIDE_MAX_LINES = 100
export const FIELD_GUIDE_MAX_CHARS = 6_000
const FIELD_GUIDE_HEADER = "## Repo Field Guide (FIELD_GUIDE.md - operational traps)"

/** The worktree's FIELD_GUIDE.md, wrapped for a prompt; null when absent, not a regular file inside the worktree, or empty. */
export function readFieldGuide(worktreeDir: string): string | null {
  try {
    const file = join(worktreeDir, "FIELD_GUIDE.md")
    if (!lstatSync(file).isFile()) return null // a symlink, FIFO or directory is never read
    const root = realpathSync(worktreeDir)
    if (!realpathSync(file).startsWith(root + sep)) return null
    const text = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim()
    const body = text.split("\n").slice(0, FIELD_GUIDE_MAX_LINES).join("\n").slice(0, FIELD_GUIDE_MAX_CHARS).trim()
    return body ? `${FIELD_GUIDE_HEADER}\n${body}` : null
  } catch {
    return null
  }
}

/** The headless worker's prompt: slash commands pass through; else branch note + brief + (turn 1 only) field guide + design context + footer.
 *  A task on an existing PR's head (`targetBranch`) gets that PR's footer and no field guide: its worktree is the PR author's
 *  tree, so the PR's own FIELD_GUIDE.md is never injected into a worker that can push. */
export function composeWorkerPrompt(o: {
  prompt: string; resume: boolean; worktree: string; branchNote: string; designContext: string; maxChars: number; targetBranch?: string | null
}): string {
  if (o.prompt.startsWith("/")) return o.prompt
  const guide = o.resume || o.targetBranch ? null : readFieldGuide(o.worktree)
  const footer = workerFooter(o.targetBranch)
  const body = [o.prompt, guide, o.designContext].filter(Boolean).join("\n\n")
  return `${o.branchNote}${body.slice(0, o.maxChars - footer.length - 2)}\n\n${footer}`
}
