import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { clearStaleGitConfigLock } from "./git-config-lock"
import type { ShFn } from "./live-repo"
import { REPO_NAME_RE } from "./worker-invocation"

// Where a worker task runs: the repo checkout on this host, and the task's own dispatch/<id> worktree of it.

export function defaultResolveRepoDir(repo: string, home = homedir()): string | null {
  if (!REPO_NAME_RE.test(repo)) return null
  const candidates = [repo === "claude-companion-ios" ? join(home, "apps", "claude companion") : "", join(home, repo), join(home, "lanes", repo), join(home, "Developer", repo), join(home, "apps", repo), join(home, ".cache", "dispatch-repos", repo)].filter(Boolean)
  for (const c of candidates) if (existsSync(join(c, ".git"))) return c
  return null
}

// No checkout on this host: a full clone of jaubut/<repo> into ~/apps/<repo>, where the resolver finds it next time.
// Never ~/leads/<repo>: a lead's clone is shallow, lead-writable and wiped on every lead respawn.
export async function cloneRepo(sh: ShFn, home: string, repo: string): Promise<string | null> {
  const dir = join(home, "apps", repo)
  if (existsSync(dir)) return null
  mkdirSync(dirname(dir), { recursive: true })
  const r = await sh("git", ["clone", "-q", `https://github.com/jaubut/${repo}.git`, dir], { cwd: home, timeoutMs: 300_000 })
  return r.ok && existsSync(join(dir, ".git")) ? dir : null
}

function sameRealPath(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b) } catch { return a === b }
}

/** The task's worktree at ~/apps/wt/<repo>/<taskId> on dispatch/<taskId>: reused when it is this repo's, else created. */
export async function ensureWorktree(
  sh: ShFn, home: string, others: Iterable<{ taskId: string; repo: string; worktree: string }>,
  repoDir: string, repo: string, taskId: string, ownedByTask: boolean,
): Promise<{ ok: true; worktree: string; branch: string } | { ok: false; error: string }> {
  clearStaleGitConfigLock(repoDir)
  const wtRoot = join(home, "apps", "wt", repo)
  const worktree = join(wtRoot, taskId)
  const branch = `dispatch/${taskId}`
  for (const other of others) {
    if ((other.taskId !== taskId || other.repo !== repo) && other.worktree.toLowerCase() === worktree.toLowerCase()) {
      return { ok: false, error: `worktree collision with ${other.repo}/${other.taskId}` }
    }
  }
  if (existsSync(worktree)) {
    if (!ownedByTask && !existsSync(join(worktree, ".git"))) return { ok: false, error: "worktree path already exists and is not a git worktree" }
    const common = await sh("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, timeoutMs: 10_000 })
    if (!common.ok) return { ok: false, error: "existing worktree is not a valid git repository" }
    const commonOut = common.out.trim()
    if (commonOut.startsWith("/") && !sameRealPath(commonOut, join(repoDir, ".git"))) return { ok: false, error: "existing worktree belongs to a different repository" }
    const curBranch = await sh("git", ["-C", worktree, "symbolic-ref", "-q", "--short", "HEAD"], { cwd: worktree, timeoutMs: 10_000 })
    if (!curBranch.ok) return { ok: false, error: "existing worktree is not on a branch" }
    const bOut = curBranch.out.trim()
    if (bOut && bOut !== "origin/main" && bOut !== branch) return { ok: false, error: `existing worktree branch mismatch: ${bOut}` }
    return { ok: true, worktree, branch }
  }
  mkdirSync(wtRoot, { recursive: true })
  const sym = await sh("git", ["-C", repoDir, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: repoDir, timeoutMs: 15_000 })
  const baseRef = sym.ok && sym.out.trim() ? sym.out.trim() : "origin/main"
  const baseBranch = baseRef.replace(/^origin\//, "")
  await sh("git", ["-C", repoDir, "fetch", "-q", "origin", baseBranch], { cwd: repoDir, timeoutMs: 30_000 })
  const hasBranch = (await sh("git", ["-C", repoDir, "show-ref", "-q", "--verify", `refs/heads/${branch}`], { cwd: repoDir, timeoutMs: 10_000 })).ok
  const wtRes = hasBranch
    ? await sh("git", ["-C", repoDir, "worktree", "add", "-q", worktree, branch], { cwd: repoDir, timeoutMs: 30_000 })
    : await sh("git", ["-C", repoDir, "worktree", "add", "-q", "-b", branch, worktree, baseRef], { cwd: repoDir, timeoutMs: 30_000 })
  if (!wtRes.ok) return { ok: false, error: `worktree add failed: ${(wtRes.err || wtRes.out).trim().slice(0, 200)}` }
  return { ok: true, worktree, branch }
}
