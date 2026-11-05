import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GhFn } from "../lib/triage-pr"
import type { LeadAction } from "../lib/lead-loop"
import type { ExecFn } from "../lib/turso"

// The lead loop on a real temp git repo: GitHub and the reviews are fakes at the
// gh boundary, the merge goes through the real bin/pr-merge gate.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-lead-")), "test.db")
const { createBrainLead } = await import("./brain-lead")
const { mergeAgentPr } = await import("./brain-pr-merge")

const REPO = "claude-companion"
const SLUG = "jaubut/claude-companion"
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()

interface Pr { number: number; headRefName: string; headRefOid: string; state: string; comments: Array<{ body: string; author: { login: string } }> }

function world() {
  const cwd = mkdtempSync(join(tmpdir(), "cc-lead-repo-"))
  git(cwd, "init", "-q", "-b", "main")
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base")
  const prs: Pr[] = []
  const gh: GhFn = async (args) => {
    if (args[1] === "list") return { code: 0, stdout: JSON.stringify(prs.filter((p) => p.state === "OPEN")), stderr: "" }
    const pr = prs.find((p) => p.number === Number(/\d+$/.exec(args[2] ?? "")?.[0]))
    if (!pr) return { code: 1, stdout: "", stderr: "no pr" }
    if (args[1] === "merge") { pr.state = "MERGED"; return { code: 0, stdout: "", stderr: "" } }
    return {
      code: 0, stderr: "",
      stdout: JSON.stringify({
        ...pr, isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", title: "t", labels: [],
        url: `https://github.com/${SLUG}/pull/${pr.number}`, author: { login: "bot" },
        statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    }
  }
  const exec: ExecFn = async (sql) => ({ rows: /COUNT/.test(sql) ? [{ n: 0 }] : [], affected: 0 })
  const lines: string[] = []
  const spawned: string[] = []
  const lead = createBrainLead({
    dir: mkdtempSync(join(tmpdir(), "cc-lead-q-")), gh, now: () => 1_000, line: (_r, t) => lines.push(t),
    running: async () => false, spawn: async (_r, n) => (spawned.push(n), { ok: true }),
    sessions: () => [], idle: async () => true, inject: async () => true,
  })
  /** A builder: a commit on dispatch/<task>, and a PR. */
  function build(taskId: string, number: number): Pr {
    git(cwd, "checkout", "-q", "-b", `dispatch/${taskId}`, "main")
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", taskId)
    const pr = { number, headRefName: `dispatch/${taskId}`, headRefOid: git(cwd, "rev-parse", "HEAD"), state: "OPEN", comments: [] }
    prs.push(pr)
    return pr
  }
  const approve = (pr: Pr) => {
    const stamp = `VERDICT: APPROVE\n<!-- reviewed-sha: ${pr.headRefOid} -->`
    pr.comments = [{ body: `🤖 **Auto-review**\n${stamp}`, author: { login: "bot" } }, { body: `🧠 **Codex review**\n${stamp}`, author: { login: "bot" } }]
  }
  return { cwd, lead, gh, exec, prs, lines, spawned, build, approve }
}

const kind = (a: LeadAction) => a.kind

describe("repo lead loop", () => {
  test("task → builder → PR → finding → fix → merge gate → one line each", async () => {
    const w = world()
    const { taskId, state } = await w.lead.send(REPO, "Fix it", "brief", "turn-1")
    expect(state).toBe("started")
    expect(w.spawned).toEqual(["lead-claude-companion"])

    expect(kind(await w.lead.next(REPO))).toBe("build")
    w.lead.event(REPO, { type: "started", taskId })
    const pr = w.build(taskId, 11)
    w.lead.event(REPO, { type: "pr", taskId, pr: pr.number })

    w.lead.event(REPO, { type: "findings", taskId, findings: ["missing test"] })
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "fix", pr: 11, findings: ["missing test"], fresh: false })
    w.lead.event(REPO, { type: "fix_started", taskId })
    git(w.cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "fix")
    pr.headRefOid = git(w.cwd, "rev-parse", "HEAD")
    w.lead.event(REPO, { type: "fix_pushed", taskId })

    w.approve(pr)
    w.lead.event(REPO, { type: "approved", taskId })
    const a = await w.lead.next(REPO)
    expect(a).toMatchObject({ kind: "merge", pr: 11 })
    const events: string[] = []
    const out = await mergeAgentPr({ repo: SLUG, pr: 11, reason: "routine" }, { gh: w.gh, exec: w.exec, event: (t) => events.push(t) })
    expect(out.status).toBe(200)
    w.lead.event(REPO, { type: "merged", taskId })

    expect(pr.state).toBe("MERGED")
    expect(w.lines).toEqual(["Started: Fix it", "PR ready: Fix it (#11)"])
    expect(events).toHaveLength(1)
    expect(await w.lead.next(REPO)).toEqual({ kind: "idle", held: 0 })
  })

  test("the fourth PR waits in the lead's queue, and goes once a slot frees", async () => {
    const w = world()
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push((await w.lead.send(REPO, `T${i}`, `brief ${i}`, "turn-2")).taskId)
    for (let i = 0; i < 3; i++) {
      expect(await w.lead.next(REPO)).toMatchObject({ kind: "build", taskId: ids[i] })
      w.lead.event(REPO, { type: "started", taskId: ids[i]! })
      w.lead.event(REPO, { type: "pr", taskId: ids[i]!, pr: w.build(ids[i]!, 20 + i).number })
    }
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "wait" })

    w.prs[0]!.state = "MERGED"
    w.lead.event(REPO, { type: "merged", taskId: ids[0]! })
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "build", taskId: ids[3] })
  })

  test("2 failed fixes, one fresh builder, then close and refile, with no line to the brain", async () => {
    const w = world()
    const { taskId } = await w.lead.send(REPO, "Hard", "brief", "turn-3")
    w.lead.event(REPO, { type: "started", taskId })
    w.lead.event(REPO, { type: "pr", taskId, pr: w.build(taskId, 31).number })
    w.lines.length = 0
    for (const fresh of [false, false, true]) {
      w.lead.event(REPO, { type: "findings", taskId, findings: ["still wrong"] })
      expect(await w.lead.next(REPO)).toMatchObject({ kind: "fix", fresh })
      w.lead.event(REPO, { type: "fix_started", taskId })
      w.lead.event(REPO, { type: "fix_pushed", taskId })
    }
    w.lead.event(REPO, { type: "findings", taskId, findings: ["still wrong"] })
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "close_refile", pr: 31 })
    w.prs[0]!.state = "CLOSED"
    w.lead.event(REPO, { type: "closed", taskId, refile: [{ title: "Smaller", prompt: "smaller brief" }] })
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "build", title: "Smaller" })
    expect(w.lines).toEqual([])
  })
})
