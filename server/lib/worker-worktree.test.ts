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

// Real git: a resume reuses a worktree checked out on another branch (a PR's branch, a stacked -c branch) untouched.
test("a worktree on another branch is reused as-is on resume: its branch is returned, dirty work and HEAD survive; a non-git path is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "worker-wt-other-"))
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
    writeFileSync(join(repoDir, "a.txt"), "a\n")
    await git(repoDir, "add", "a.txt")
    await git(repoDir, "commit", "-q", "-m", "init")
    await git(repoDir, "push", "-q", "origin", "HEAD:main")

    const wt = await ensureWorktree(realSh, home, [], repoDir, "repo", "t2", false)
    if (!wt.ok) throw new Error(wt.error)
    expect(wt.branch).toBe("dispatch/t2")

    for (const other of ["feature/other-pr", "dispatch/t2-c"]) {
      await git(wt.worktree, "checkout", "-q", "-B", other)
      writeFileSync(join(wt.worktree, "wip.txt"), `uncommitted on ${other}\n`)
      const head = await git(wt.worktree, "rev-parse", "HEAD")
      const status = await git(wt.worktree, "status", "--porcelain")

      const again = await ensureWorktree(realSh, home, [], repoDir, "repo", "t2", true)
      expect(again).toEqual({ ok: true, worktree: wt.worktree, branch: other })
      expect(await git(wt.worktree, "symbolic-ref", "--short", "HEAD")).toBe(other)
      expect(await git(wt.worktree, "rev-parse", "HEAD")).toBe(head)
      expect(await git(wt.worktree, "status", "--porcelain")).toBe(status)
      expect(await git(repoDir, "stash", "list")).toBe("")
    }

    mkdirSync(join(home, "apps", "wt", "repo", "plain"), { recursive: true })
    const plain = await ensureWorktree(realSh, home, [], repoDir, "repo", "plain", true)
    expect(plain.ok).toBe(false)

    // The task's record is gone (no ownedByTask): its own path is still its worktree, resumed on the branch the worker switched to.
    expect(await ensureWorktree(realSh, home, [], repoDir, "repo", "t2", false)).toEqual({ ok: true, worktree: wt.worktree, branch: "dispatch/t2-c" })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// Real git: closing a worktree the worker had switched off dispatch/<id> records that branch, and the resume recreates it there.
test("a closed worktree on a stacked branch resumes on it; the stale dispatch/<id> is dropped; a non-dispatch branch is never deleted", async () => {
  const home = mkdtempSync(join(tmpdir(), "worker-wt-close-"))
  const git = async (cwd: string, ...args: string[]) => {
    const r = await realSh("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, timeoutMs: 20_000 })
    if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.err}`)
    return r.out.trim()
  }
  const commitPush = async (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`)
    await git(cwd, "add", file)
    await git(cwd, "commit", "-q", "-m", file)
    await git(cwd, "push", "-q", "origin", "HEAD")
  }
  try {
    const origin = join(home, "origin.git")
    const repoDir = join(home, "repo")
    await git(home, "init", "-q", "--bare", "-b", "main", origin)
    await git(home, "clone", "-q", origin, repoDir)
    await commitPush(repoDir, "a.txt")

    const wt = await ensureWorktree(realSh, home, [], repoDir, "repo", "t3", false)
    if (!wt.ok) throw new Error(wt.error)
    await git(wt.worktree, "push", "-q", "origin", wt.branch)
    await git(wt.worktree, "checkout", "-q", "-b", "dispatch/t3-c")
    await commitPush(wt.worktree, "stacked.txt")

    const t = { worktree: wt.worktree, repoDir, branch: wt.branch }
    expect(await closeTaskWorktree(realSh, t)).toEqual({ removed: true })
    expect(t.branch).toBe("dispatch/t3-c")
    expect(await git(repoDir, "branch", "--list", "dispatch/*")).toBe("")

    const again = await ensureWorktree(realSh, home, [], repoDir, "repo", "t3", true, t.branch)
    if (!again.ok) throw new Error(again.error)
    expect(again.branch).toBe("dispatch/t3-c")
    expect(existsSync(join(again.worktree, "stacked.txt"))).toBe(true)

    await git(again.worktree, "checkout", "-q", "-b", "feature/pr-branch")
    await commitPush(again.worktree, "pr.txt")
    expect(await closeTaskWorktree(realSh, t)).toEqual({ removed: true })
    expect(t.branch).toBe("feature/pr-branch")
    expect(await git(repoDir, "branch", "--list", "feature/pr-branch")).toContain("feature/pr-branch")

    const third = await ensureWorktree(realSh, home, [], repoDir, "repo", "t3", true, t.branch)
    expect(third).toEqual({ ok: true, worktree: again.worktree, branch: "feature/pr-branch" })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("targetBranch: a fresh task gets its own dispatch/<taskId> at an origin/dispatch/* head, even while the builder's worktree holds it; anything else is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "worker-wt-target-"))
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
    writeFileSync(join(repoDir, "a.txt"), "base\n")
    await git(repoDir, "add", "a.txt")
    await git(repoDir, "commit", "-q", "-m", "init")
    await git(repoDir, "push", "-q", "origin", "HEAD:main")
    await git(repoDir, "push", "-q", "origin", "HEAD:refs/heads/dispatch/builder1")
    const tip = await git(repoDir, "rev-parse", "HEAD")
    // The builder's worktree is still open on the PR's branch (kept while its PR is OPEN).
    await git(repoDir, "worktree", "add", "-q", "-b", "dispatch/builder1", join(home, "apps", "wt", "repo", "builder1"), "origin/dispatch/builder1")

    const wt = await ensureWorktree(realSh, home, [], repoDir, "repo", "conflict-repo-pr7-abcd1234", false, undefined, "dispatch/builder1")
    if (!wt.ok) throw new Error(wt.error)
    expect(wt.branch).toBe("dispatch/conflict-repo-pr7-abcd1234")
    expect(wt.worktree).toBe(join(home, "apps", "wt", "repo", "conflict-repo-pr7-abcd1234"))
    expect(await git(wt.worktree, "rev-parse", "HEAD")).toBe(tip)
    expect(await git(wt.worktree, "symbolic-ref", "--short", "HEAD")).toBe("dispatch/conflict-repo-pr7-abcd1234")
    // Never reused: a leftover (half-merged) resolver worktree is refused.
    expect(await ensureWorktree(realSh, home, [], repoDir, "repo", "conflict-repo-pr7-abcd1234", true, undefined, "dispatch/builder1"))
      .toEqual({ ok: false, error: "target worktree already exists" })

    for (const bad of ["main", "master", "feature/x", "dispatch/../main"]) {
      const r = await ensureWorktree(realSh, home, [], repoDir, "repo", "conflict-bad", false, undefined, bad)
      expect(r).toEqual({ ok: false, error: "invalid_target_branch" })
    }
    const missing = await ensureWorktree(realSh, home, [], repoDir, "repo", "conflict-gone", false, undefined, "dispatch/nope")
    expect(missing).toEqual({ ok: false, error: "target branch not on origin: dispatch/nope" })
    expect(existsSync(join(home, "apps", "wt", "repo", "conflict-gone"))).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
