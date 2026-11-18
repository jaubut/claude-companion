import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realSh } from "./live-repo"
import { closeTaskWorktree, ensureWorktree } from "./worker-worktree"

// Real git: the auto-close must never delete an ignored render, and a closed task's follow-up resumes its pushed branch.
test("a worktree holding an ignored file (out/v8.mp4) is kept; a closed one is recreated from origin/dispatch/<id> (PR #332 review)", async () => {
  const home = mkdtempSync(join(tmpdir(), "worker-wt-"))
  const git = async (cwd: string, ...args: string[]) => {
    const r = await realSh("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, timeoutMs: 20_000 })
    if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.err}`)
    return r.out.trim()
  }
  try {
    const origin = join(home, "origin.git")
    const repoDir = join(home, "repo")
    await git(home, "init", "-q", "--bare", "-b", "main", origin)
    await git(home, "clone", "-q", origin, repoDir)
    writeFileSync(join(repoDir, ".gitignore"), "out/\n")
    await git(repoDir, "add", ".gitignore")
    await git(repoDir, "commit", "-q", "-m", "init")
    await git(repoDir, "push", "-q", "origin", "HEAD:main")

    const wt = await ensureWorktree(realSh, home, [], repoDir, "repo", "t1", false)
    if (!wt.ok) throw new Error(wt.error)
    writeFileSync(join(wt.worktree, "fix.txt"), "work\n")
    await git(wt.worktree, "add", "fix.txt")
    await git(wt.worktree, "commit", "-q", "-m", "work")
    await git(wt.worktree, "push", "-q", "origin", wt.branch)
    mkdirSync(join(wt.worktree, "out"))
    writeFileSync(join(wt.worktree, "out", "v8.mp4"), "render")

    // Clean and pushed, but the ignored render is there: kept.
    const t = { worktree: wt.worktree, repoDir, branch: wt.branch }
    expect(await closeTaskWorktree(realSh, t)).toEqual({ removed: false, note: `worktree kept: 1 uncommitted or ignored file(s) in ${wt.worktree}` })
    expect(existsSync(join(wt.worktree, "out", "v8.mp4"))).toBe(true)

    rmSync(join(wt.worktree, "out"), { recursive: true })
    expect(await closeTaskWorktree(realSh, t)).toEqual({ removed: true })
    expect(existsSync(wt.worktree)).toBe(false)

    // The follow-up turn starts on its own pushed commit, not main.
    const again = await ensureWorktree(realSh, home, [], repoDir, "repo", "t1", true)
    if (!again.ok) throw new Error(again.error)
    expect(existsSync(join(again.worktree, "fix.txt"))).toBe(true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
