import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { GhFn } from "../lib/triage-pr"
import type { LeadDeps } from "./brain-lead"
import type { LeadAction } from "../lib/lead-loop"
import type { ExecFn } from "../lib/turso"

// The lead loop on a real temp git repo: GitHub and the reviews are fakes at the
// gh boundary, the merge goes through the real bin/pr-merge gate.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-lead-")), "test.db")
const { createBrainLead, leadArgs } = await import("./brain-lead")
const { fakeHerdr } = await import("../lib/herdr-fake.test-util")
const { spawnInHerdr } = await import("../lib/spawn-session")
const { mergeAgentPr } = await import("./brain-pr-merge")

const REPO = "claude-companion"
const SLUG = "jaubut/claude-companion"
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim()

interface Pr { number: number; headRefName: string; headRefOid: string; state: string; comments: Array<{ body: string; author: { login: string } }> }

function world(over: Partial<LeadDeps> = {}) {
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
  const events: string[] = []
  const lead = createBrainLead({
    dir: mkdtempSync(join(tmpdir(), "cc-lead-q-")), gh, exec, now: () => 1_000, line: (_r, t) => lines.push(t), event: (t) => events.push(t),
    running: async () => false, spawn: async (_r, n) => (spawned.push(n), { ok: true }), stop: async () => {},
    sessions: () => [], agentPane: async () => "", envOf: async () => null, tag: () => false, idle: async () => true, inject: async () => true,
    ...over,
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
  return { cwd, lead, gh, exec, prs, lines, events, spawned, build, approve }
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

  test("what the lead cannot resolve reaches the brain in one line", async () => {
    const w = world()
    const { taskId } = await w.lead.send(REPO, "Stuck", "brief", "turn-4")
    w.lead.event(REPO, { type: "blocked", taskId, kind: "stuck", line: "conflict unresolved on #41" })
    expect(w.lines).toEqual(["Blocked (stuck): Stuck: conflict unresolved on #41"])
    expect(() => w.lead.event(REPO, { type: "blocked", taskId, kind: "bored", line: "x" })).toThrow("not_a_decision")
  })
})

describe("repo lead: failure paths", () => {
  async function onPr(w: ReturnType<typeof world>, n: number, seed = "turn-9") {
    const { taskId } = await w.lead.send(REPO, "T", `brief ${n}`, seed)
    w.lead.event(REPO, { type: "started", taskId })
    w.lead.event(REPO, { type: "pr", taskId, pr: w.build(taskId, n).number })
    w.lines.length = 0
    return taskId
  }
  const spend = async (w: ReturnType<typeof world>, taskId: string) => {
    for (let i = 0; i < 3; i++) {
      w.lead.event(REPO, { type: "findings", taskId, findings: ["wrong"] })
      w.lead.event(REPO, { type: "fix_started", taskId })
      w.lead.event(REPO, { type: "fix_pushed", taskId })
    }
    w.lead.event(REPO, { type: "findings", taskId, findings: ["wrong"] })
  }

  test("blocked stops the loop on one line, until the brain resumes it", async () => {
    const w = world()
    const taskId = await onPr(w, 51)
    w.lead.event(REPO, { type: "approved", taskId })
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "merge" })
    w.lead.event(REPO, { type: "blocked", taskId, kind: "stuck", line: "merge refused" })
    w.lead.event(REPO, { type: "blocked", taskId, kind: "stuck", line: "merge refused" })
    expect(await w.lead.next(REPO)).toEqual({ kind: "idle", held: 0 })
    expect(w.lines).toHaveLength(1)
    w.lead.event(REPO, { type: "resume", taskId })
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "merge" })
  })

  test("a blocked task leaves the rest of the queue running", async () => {
    const w = world()
    const stuck = await onPr(w, 52)
    w.lead.event(REPO, { type: "behind", taskId: stuck })
    w.lead.event(REPO, { type: "blocked", taskId: stuck, kind: "stuck", line: "conflict" })
    const { taskId } = await w.lead.send(REPO, "Next", "next brief", "turn-9")
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "build", taskId })
  })

  test("a PR merged or closed by anyone else comes back as gone, blocked or not", async () => {
    const w = world()
    const taskId = await onPr(w, 53)
    w.lead.event(REPO, { type: "blocked", taskId, kind: "stuck", line: "x" })
    w.prs[0]!.state = "MERGED"
    expect(await w.lead.next(REPO)).toEqual({ kind: "gone", taskId, pr: 53 })
    w.lead.event(REPO, { type: "merged", taskId })
    expect(await w.lead.next(REPO)).toEqual({ kind: "idle", held: 0 })
  })

  test("a close retry refiles nothing twice, even after the first refile merged", async () => {
    const w = world()
    const taskId = await onPr(w, 54)
    const refile = [{ title: "Part", prompt: "part brief" }]
    w.lead.event(REPO, { type: "close_refused", taskId, refile })
    const a = await w.lead.next(REPO)
    expect(a).toMatchObject({ kind: "build", title: "Part" })
    if (a.kind !== "build") throw new Error("build")
    w.lead.event(REPO, { type: "started", taskId: a.taskId })
    w.lead.event(REPO, { type: "merged", taskId: a.taskId })
    w.prs[0]!.state = "CLOSED"
    w.lead.event(REPO, { type: "closed", taskId, refile })
    expect(await w.lead.next(REPO)).toEqual({ kind: "idle", held: 0 })
  })

  test("a second refused close stops retrying and reaches the brain", async () => {
    const w = world()
    const taskId = await onPr(w, 55)
    w.lead.event(REPO, { type: "close_refused", taskId, refile: [] })
    expect(w.lines).toEqual([])
    w.lead.event(REPO, { type: "close_refused", taskId, refile: [] })
    expect(w.lines).toEqual(["Blocked (stuck): T: close of #55 refused twice"])
    expect(await w.lead.next(REPO)).toEqual({ kind: "idle", held: 0 })
  })

  test("a refused merge clears the approval, so next stops answering merge", async () => {
    const w = world()
    const taskId = await onPr(w, 59)
    w.lead.event(REPO, { type: "approved", taskId })
    w.lead.event(REPO, { type: "merge_refused", taskId })
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "wait" })
  })

  test("a builder dead before the budget's end gets a replacement on the next fix", async () => {
    const w = world()
    const taskId = await onPr(w, 63)
    w.lead.event(REPO, { type: "findings", taskId, findings: ["wrong"] })
    w.lead.event(REPO, { type: "fix_started", taskId })
    w.lead.event(REPO, { type: "builder_died", taskId })
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "fix", fresh: true })
    w.lead.event(REPO, { type: "fix_started", taskId })
    w.lead.event(REPO, { type: "fix_pushed", taskId })
    w.lead.event(REPO, { type: "findings", taskId, findings: ["wrong"] })
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "fix", fresh: true })
  })

  test("a line to the brain is redacted", async () => {
    const w = world()
    const taskId = await onPr(w, 58)
    w.lead.event(REPO, { type: "blocked", taskId, kind: "stuck", line: `log says ghp_${"a".repeat(36)}` })
    expect(w.lines[0]).not.toContain("ghp_")
  })

  test("the heads a lead may close are its task's, and only for a PR in the queue", async () => {
    const w = world()
    const taskId = await onPr(w, 56)
    expect(w.lead.spent(REPO, 56)).toEqual([])
    await spend(w, taskId)
    expect(w.lead.spent(REPO, 56)).toEqual([`dispatch/${taskId}`, `builder/${taskId}`])
    expect(w.lead.spent(REPO, 57)).toEqual([])
  })

  test("a queue PR on builder/* counts against the cap; a stranger's builder/* PR does not", async () => {
    const w = world()
    for (const n of [60, 61]) await onPr(w, n)
    const stranger = w.build("stranger", 62)
    stranger.headRefName = "builder/stranger"
    const q = await w.lead.send(REPO, "Third", "third", "turn-9")
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "build", taskId: q.taskId })
    w.lead.event(REPO, { type: "started", taskId: q.taskId })
    w.lead.event(REPO, { type: "pr", taskId: q.taskId, pr: 62 })
    const fourth = await w.lead.send(REPO, "Fourth", "fourth", "turn-9")
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "wait" })
    expect(fourth.ok).toBe(true)
  })
})

describe("repo lead: tick", () => {
  const herdr = { key: "herdr:p9", taskId: "", sessionId: "sid", herdrPane: "p9", pid: "99" }
  function ticking(over: Partial<LeadDeps> = {}) {
    const injected: string[] = []
    const tagged: string[] = []
    const w = world({
      running: async () => true, agentPane: async () => "p9", sessions: () => [herdr],
      envOf: async () => ["COMPANION_TASK_ID=lead-claude-companion", "HERDR_PANE_ID=p9"], tag: (k) => (tagged.push(k), true),
      inject: async (k) => (injected.push(k), true), ...over,
    })
    return { w, injected, tagged }
  }

  test("after a restart the untagged lead is recovered from its herdr pane and woken", async () => {
    const { w, injected, tagged } = ticking()
    await w.lead.send(REPO, "T", "brief", "turn-20")
    await w.lead.tick()
    expect(tagged).toEqual(["herdr:p9"])
    expect(injected).toEqual(["herdr:p9"])
  })

  test("a session in that pane without the lead's env is never tagged", async () => {
    const { w, injected, tagged } = ticking({ envOf: async () => ["COMPANION_TASK_ID=brain"] })
    await w.lead.send(REPO, "T", "brief", "turn-21")
    await w.lead.tick()
    expect([tagged, injected]).toEqual([[], []])
  })

  test("a process is the lead only with its env and herdr's pane agreeing", async () => {
    const { w } = ticking()
    expect(await w.lead.verified("lead-claude-companion", "99")).toBe(true)
    expect(await ticking({ agentPane: async () => "p1" }).w.lead.verified("lead-claude-companion", "99")).toBe(false)
    expect(await ticking({ agentPane: async () => "" }).w.lead.verified("lead-claude-companion", "99")).toBe(false)
    expect(await ticking({ envOf: async () => ["COMPANION_TASK_ID=x", "HERDR_PANE_ID=p9"] }).w.lead.verified("lead-claude-companion", "99")).toBe(false)
    expect(await ticking({ envOf: async () => null }).w.lead.verified("lead-claude-companion", "99")).toBe(false)
  })

  test("a slow tick is not overlapped: the cursor never runs back, a line posts once", async () => {
    const rows: Array<Record<string, string | number | null>> = [{ id: 6, action: "pr:brain-event", summary: "one", meta: "{}" }]
    let release = () => {}
    const gate = new Promise<void>((r) => { release = r })
    let held = false
    const { w } = ticking({ exec: async (sql, args) => {
      if (/MAX\(id\)/.test(sql)) return { rows: [{ n: 0 }], affected: 0 }
      if (!held) { held = true; await gate }
      return { rows: rows.filter((r) => Number(r.id) > Number(args[2])), affected: 0 }
    } })
    await w.lead.tick()
    const slow = w.lead.tick()
    await w.lead.tick()
    release()
    await slow
    await w.lead.tick()
    expect(w.events).toEqual(["one"])
  })

  test("a dead lead's stale herdr record is cleared, and the next tick respawns it", async () => {
    const stopped: string[] = []
    let taken = true
    const { w } = ticking({
      running: async () => false, stop: async (n) => { stopped.push(n); taken = false },
      spawn: async () => taken ? { ok: false, error: "name_taken: lead-claude-companion" } : { ok: true },
    })
    await w.lead.send(REPO, "T", "brief", "turn-23")
    expect(stopped).toEqual(["lead-claude-companion"])
    expect(await w.lead.ensure(REPO)).toMatchObject({ ok: true, state: "started" })
  })

  test("only blocked work wakes nobody", async () => {
    const { w, injected } = ticking()
    const { taskId } = await w.lead.send(REPO, "T", "brief", "turn-22")
    w.lead.event(REPO, { type: "blocked", taskId, kind: "stuck", line: "x" })
    await w.lead.tick()
    expect(injected).toEqual([])
  })
})

describe("repo lead: shepherd rows", () => {
  const URL = `https://github.com/${SLUG}/pull/70`
  const handoff = (id: number, meta: Record<string, unknown>) => ({ id, action: "pr:handoff", summary: "s", meta: JSON.stringify({ url: URL, repo: REPO, pr: 70, reason: "CI still failing after 3 fixes", to: "manager", findings: ["a.ts:1 — bad"], ...meta }) })
  function fed(rows: Array<Record<string, string | number | null>>) {
    let cursor = 0
    const exec: ExecFn = async (sql, args) => {
      if (/MAX\(id\)/.test(sql)) return { rows: [{ n: cursor }], affected: 0 }
      const after = Number(args[2])
      return { rows: rows.filter((r) => Number(r.id) > after), affected: 0 }
    }
    return { exec, seek: (n: number) => { cursor = n } }
  }

  test("the first read starts at the newest row: history is not replayed", async () => {
    const f = fed([handoff(5, {})])
    f.seek(5)
    const w = world({ exec: f.exec })
    await w.lead.tick()
    expect(await w.lead.next(REPO)).toEqual({ kind: "idle", held: 0 })
  })

  test("a manager handoff lands in the lead's queue once, on a fresh builder", async () => {
    const rows: Array<Record<string, string | number | null>> = []
    const f = fed(rows)
    const w = world({ exec: f.exec })
    await w.lead.tick()
    w.build("task", 70)
    rows.push(handoff(6, {}), handoff(7, { to: "jeremie", pr: 71 }), handoff(8, { repo: "other", pr: 72 }), { id: 9, action: "pr:handoff", summary: "s", meta: "{broken" })
    await w.lead.tick()
    await w.lead.tick()
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "fix", pr: 70, findings: ["a.ts:1 — bad"], fresh: true })
    w.lead.event(REPO, { type: "fix_started", taskId: (await w.lead.next(REPO) as { taskId: string }).taskId })
    expect(w.lead.spent(REPO, 70)).toEqual(["dispatch/task"])
  })

  test("a handoff on a PR the lead tracks refreshes it, no second task", async () => {
    const rows: Array<Record<string, string | number | null>> = []
    const w = world({ exec: fed(rows).exec })
    await w.lead.tick()
    const { taskId } = await w.lead.send(REPO, "T", "brief", "turn-30")
    w.lead.event(REPO, { type: "started", taskId })
    w.lead.event(REPO, { type: "pr", taskId, pr: w.build(taskId, 70).number })
    w.lead.event(REPO, { type: "approved", taskId })
    rows.push(handoff(6, {}))
    await w.lead.tick()
    expect(await w.lead.next(REPO)).toMatchObject({ kind: "fix", taskId, fresh: false })
  })

  test("a brain event is one line in the brain thread, redacted, once", async () => {
    const rows: Array<Record<string, string | number | null>> = []
    const w = world({ exec: fed(rows).exec })
    await w.lead.tick()
    rows.push({ id: 6, action: "pr:brain-event", summary: "client PR r#1\nsecond line", meta: "{}" })
    await w.lead.tick()
    await w.lead.tick()
    expect(w.events).toEqual(["client PR r#1"])
  })
})

test("a lead cannot enter plan mode, and its args pass the real spawn", async () => {
  const name = "lead-claude-companion"
  expect(leadArgs(name).slice(-3)).toEqual(["--disallowedTools", "EnterPlanMode", "ExitPlanMode"])
  const out = await spawnInHerdr("/srv/repo", "claude", { COMPANION_TASK_ID: name }, fakeHerdr().h, { name, args: leadArgs(name) })
  expect(out).toMatchObject({ ok: true })
})
