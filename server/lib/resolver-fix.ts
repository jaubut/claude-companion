import { mkdtempSync, rmSync, symlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseCliResult } from "./cli-json"
import { resolveClaudeBin } from "./receipt-sonnet"
import { type GitFn, guardFixRange } from "./resolver-fix-guard"
import { conflictPolicyLines, fixDisallowed } from "./resolver-fix-policy"

// An Opus fix run on a PR branch — the PR shepherd's fix approach
// (claude-config tools/pr-shepherd.ts doFix), driven by the resolver's
// review: a disposable worktree on the PR head, `claude -p --agent builder`
// edits (blanket conflict strategies denied: lib/resolver-fix-policy.ts), the
// server commits, re-fetches the branch and rebases the fix commits if it moved,
// checks the PR's changes survived (lib/resolver-fix-guard.ts) and pushes to the
// SAME branch (never forced, never main/master/base), then deletes the
// worktree. No git argv on this path carries a force flag. Every external call
// is a seam.

export interface ShResult { ok: boolean; code: number; out: string; err: string }
export type ShFn = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }) => Promise<ShResult>

export interface FixInput {
  prUrl: string
  number: number
  title: string
  /** Local checkout of the PR's repo. */
  repo: string
  head: string
  base: string
  instructions: string
  taskText: string
  model: string
  timeoutMs: number
}

export type FixOutcome =
  | { kind: "pushed"; sha: string; summary: string }
  | { kind: "no_changes"; summary: string }
  | { kind: "blocked"; reason: string }
  /** transient: the run never happened for a passing reason (the Mac unreachable) — not a loop-guard failure. */
  | { kind: "failed"; error: string; transient?: boolean }

export interface FixDeps {
  sh: ShFn
  claudeBin?: () => string | null
  mkTemp?: () => string
  linkModules?: (from: string, to: string) => void
  cleanup?: (dir: string) => void
}

const PROTECTED = new Set(["main", "master", "develop", "production", "prod"])
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/
export const GIT_TIMEOUT_MS = 120_000

/** A branch Opus may push to: a normal PR head, never a protected or base branch. */
export function pushableBranch(head: string, base: string): boolean {
  return BRANCH_RE.test(head) && !head.includes("..") && head !== base && !PROTECTED.has(head.toLowerCase())
}

export function fixPrompt(f: FixInput, dir: string): string {
  return [
    `You are the \`builder\` agent fixing an open pull request for the Opus resolver: ${f.prUrl} ("${f.title}").`,
    `You are in a disposable git worktree at ${dir}, checked out on the PR head (branch ${f.head}). Edit only under that path.`,
    ...(f.taskText ? [`Original task: ${f.taskText.slice(0, 2000)}`] : []),
    "",
    "Opus reviewed the PR and asks for these changes:",
    f.instructions,
    "",
    "Rules: minimal change inside the PR's scope; never weaken, skip or delete tests or CI config to get green; never commit secrets or env files.",
    ...conflictPolicyLines(f.head),
    `Do NOT commit, push, open PRs or merge — the server commits your changes and pushes them to the same branch (${f.head}), which re-runs CI.`,
    'If it cannot be done (infra, secrets, needs a product decision), make NO changes and reply with a line starting "RESOLVER_STATUS: blocked" + why.',
    'Otherwise reply "RESOLVER_STATUS: fixed" + a two-line summary of what you changed.',
  ].join("\n")
}

/** The server env minus every token a builder has no use for (Max OAuth, never API billing). */
export function fixEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (/^ANTHROPIC_API_KEY$|TURSO|COMPANION_|APNS|TELEGRAM|DASHBOARD|STRIPE|BROKER|SECRET|PASSWORD/i.test(k)) continue
    out[k] = v
  }
  return out
}

function parseFixReply(stdout: string): { blocked: string | null; text: string } | null {
  const text = parseCliResult(stdout)
  if (text === null) return null
  const b = /RESOLVER_STATUS:\s*blocked[^\n]*\n?([\s\S]*)/i.exec(text)
  const firstLine = /RESOLVER_STATUS:\s*blocked:?\s*([^\n]*)/i.exec(text)?.[1]?.trim()
  return { blocked: b ? (firstLine || b[1]!.trim().split("\n")[0] || "the fix agent could not do it").slice(0, 200) : null, text: text.replace(/RESOLVER_STATUS:\s*\w+:?/i, "").trim() }
}

/** A push the remote refused because the branch moved under it (retry after fetch + rebase). */
export function nonFastForward(r: ShResult): boolean {
  return /non-fast-forward|fetch first|\[rejected\]|stale info|updates were rejected/i.test(`${r.err}\n${r.out}`)
}

const tail = (r: ShResult): string => (r.err || r.out).trim().slice(0, 160)

/**
 * Publish the fix commits (prHead..HEAD) to the PR branch, never forced:
 * fetch the branch; if it moved, rebase ONLY the fix commits onto the new head
 * (a conflict aborts the rebase → blocked); run the post-run guards; push.
 * A non-fast-forward rejection (it moved again) → one more fetch + rebase + push.
 */
export async function publishFix(git: GitFn, dir: string, f: Pick<FixInput, "head" | "base">, prHead: string, summary: string): Promise<FixOutcome> {
  let onto = prHead
  for (let round = 0; round < 2; round++) {
    const fetched = await git(dir, "fetch", "-q", "origin", `+refs/heads/${f.head}:refs/remotes/origin/${f.head}`)
    if (!fetched.ok) return { kind: "failed", error: `git fetch before push failed: ${tail(fetched)}` }
    const remote = (await git(dir, "rev-parse", "--verify", "-q", `refs/remotes/origin/${f.head}`)).out.trim()
    if (!remote) return { kind: "failed", error: `branch ${f.head} is gone from the remote` }
    if (remote !== onto) {
      const rb = await git(dir, "rebase", "--onto", remote, onto)
      if (!rb.ok) {
        const files = (await git(dir, "diff", "--name-only", "--diff-filter=U")).out.trim().split("\n").filter(Boolean)
        await git(dir, "rebase", "--abort")
        return { kind: "blocked", reason: `branch moved and conflicts with Opus's fix${files.length ? ` (${files.slice(0, 6).join(", ")})` : ""}` }
      }
      onto = remote
    }
    const verdict = await guardFixRange(git, dir, onto, `refs/remotes/origin/${f.base}`)
    if (!verdict.ok) return { kind: "blocked", reason: verdict.reason }
    const sha = (await git(dir, "rev-parse", "HEAD")).out.trim()
    const pushed = await git(dir, "push", "origin", `HEAD:refs/heads/${f.head}`)
    if (pushed.ok) return { kind: "pushed", sha, summary: summary.slice(0, 600) }
    if (round === 1 || !nonFastForward(pushed)) return { kind: "failed", error: `push failed: ${tail(pushed)}` }
  }
  return { kind: "failed", error: "push failed" }
}

export async function runPrFix(f: FixInput, deps: FixDeps): Promise<FixOutcome> {
  if (!pushableBranch(f.head, f.base)) return { kind: "failed", error: `refusing to push to branch "${f.head}"` }
  if (!BRANCH_RE.test(f.base) || f.base.includes("..")) return { kind: "failed", error: `bad base branch "${f.base}"` }
  const bin = (deps.claudeBin ?? resolveClaudeBin)()
  if (!bin) return { kind: "failed", error: "claude binary not found" }
  const git: GitFn = (cwd, ...args) => deps.sh("git", ["-C", cwd, ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })
  const fetched = await git(f.repo, "fetch", "-q", "origin", `+refs/heads/${f.head}:refs/remotes/origin/${f.head}`, `+refs/heads/${f.base}:refs/remotes/origin/${f.base}`)
  if (!fetched.ok) return { kind: "failed", error: `git fetch failed: ${tail(fetched)}` }
  const tmp = (deps.mkTemp ?? (() => mkdtempSync(join(tmpdir(), "opus-resolver-"))))()
  const dir = join(tmp, "wt")
  const cleanup = deps.cleanup ?? ((d: string) => rmSync(d, { recursive: true, force: true }))
  const added = await git(f.repo, "worktree", "add", "--detach", dir, `refs/remotes/origin/${f.head}`)
  if (!added.ok) {
    cleanup(tmp)
    return { kind: "failed", error: `git worktree add failed: ${tail(added)}` }
  }
  try {
    const modules = join(f.repo, "node_modules")
    if (existsSync(modules)) (deps.linkModules ?? ((a, b) => symlinkSync(a, b)))(modules, join(dir, "node_modules"))
    const start = (await git(dir, "rev-parse", "HEAD")).out.trim()
    const run = await deps.sh(bin, fixArgs(f, dir), { cwd: dir, timeoutMs: f.timeoutMs, env: fixEnv() })
    if (!run.ok) return { kind: "failed", error: `fix run failed (exit ${run.code}) ${run.err.slice(0, 160)}` }
    const reply = parseFixReply(run.out)
    if (!reply) return { kind: "failed", error: "unparseable fix-run output" }
    if (reply.blocked) return { kind: "blocked", reason: reply.blocked }
    if ((await git(dir, "status", "--porcelain", "--", ".", ":!node_modules")).out.trim()) {
      await git(dir, "add", "-A", "--", ".", ":!node_modules", ":!**/node_modules")
      await git(dir, "commit", "-m", `fix(resolver): Opus review changes for PR #${f.number}`)
    }
    const sha = (await git(dir, "rev-parse", "HEAD")).out.trim()
    if (!sha || sha === start) return { kind: "no_changes", summary: reply.text.slice(0, 300) }
    return await publishFix(git, dir, f, start, reply.text)
  } finally {
    // No `worktree remove --force`: delete the directory, then let git forget it.
    cleanup(tmp)
    await git(f.repo, "worktree", "prune").catch(() => null)
  }
}

/** The fix run's argv: the builder agent, the prompt, and the git deny rules (lib/resolver-fix-policy.ts). */
export function fixArgs(f: FixInput, dir: string): string[] {
  return ["-p", fixPrompt(f, dir), "--agent", "builder", "--model", f.model, "--output-format", "json", "--permission-mode", "acceptEdits",
    "--disallowedTools", ...fixDisallowed(f.base)]
}

/** The real shell: Bun.spawn with a timeout; never throws. */
export const realSh: ShFn = async (cmd, args, opts) => {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([cmd, ...args], { cwd: opts.cwd, env: opts.env ?? (process.env as Record<string, string>), stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (err) {
    return { ok: false, code: -1, out: "", err: (err as Error)?.message ?? "spawn failed" }
  }
  const timer = setTimeout(() => { try { proc.kill() } catch { /* gone */ } }, opts.timeoutMs)
  try {
    const [out, err] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()])
    const code = await proc.exited
    return { ok: code === 0, code, out, err }
  } finally {
    clearTimeout(timer)
  }
}
