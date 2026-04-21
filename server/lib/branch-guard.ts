/**
 * Branch-aware wrapper around autoJudge.
 *
 * Before routing a Bash command to the auto-judge, detect the git branch at
 * `cwd`. If the command is a non-force `git push` and the current branch is
 * NOT main/master, auto-allow — feature-branch pushes are low-risk. Any push
 * on main/master still falls through to autoJudge (which usually returns "ask"
 * or "deny" depending on the command shape).
 *
 * If the branch check fails (not a repo, timeout, error), fall through to the
 * default autoJudge verdict — no false allows.
 */

import { spawn } from "bun"
import { autoJudge } from "./auto-judge"

type Verdict = "allow" | "deny" | "ask"

const PROTECTED_BRANCHES = new Set(["main", "master"])

async function currentBranch(cwd: string): Promise<string | null> {
  if (!cwd) return null
  try {
    const proc = spawn({
      cmd: ["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"],
      stdout: "pipe",
      stderr: "ignore",
    })
    // Abort after 1s — git should always be instant on a local repo
    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* already gone */ }
    }, 1000)
    const out = await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timer)
    if (proc.exitCode !== 0) return null
    const branch = out.trim()
    if (!branch || branch === "HEAD") return null
    return branch
  } catch {
    return null
  }
}

function isNonForcePush(cmd: string): boolean {
  // Match `git push` (word-boundary), reject if --force / -f is present.
  if (!/^\s*git\s+push(\s|$)/.test(cmd)) return false
  if (/\s--force\b/.test(cmd)) return false
  if (/\s-f\b/.test(cmd)) return false
  return true
}

export async function judgeWithBranchContext(
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<Verdict> {
  if (tool === "Bash") {
    const cmd = ((input.command as string) ?? "").trim()
    if (isNonForcePush(cmd)) {
      const branch = await currentBranch(cwd)
      if (branch && !PROTECTED_BRANCHES.has(branch)) {
        // Feature branch — auto-allow regular pushes.
        return "allow"
      }
      // Protected branch OR unknown — fall through to autoJudge.
      // autoJudge will typically return "ask" (unlisted git write), or "deny"
      // if the command explicitly mentions main/master.
    }
  }
  return autoJudge(tool, input)
}
