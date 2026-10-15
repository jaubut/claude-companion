import { describe, expect, test } from "bun:test"
import { type ResolvingItem, type SourceItem, type TriageItem, buildItem, fallbackPhrase } from "./triage"
import {
  type CardInput, type RepoRun, REPO_OTHER, buildRepoCards, heldReason, memberDoes, overviewLines, repoKeyOf, runSummary, yesPlan,
} from "./triage-repos"

// Repo cards (needs-you-repo-yes-no, 2026-10-15): one card per repo derived
// from the per-item cards; Yes acts only on the client's member snapshot;
// held PRs (sensitive / client / stale / dep auto-merge off / safety net)
// never become members.

function task(id: string, repo: string | null, version = "blocked|1", status: "blocked" | "failed" = "blocked"): SourceItem {
  return {
    source: "task", refId: id, version, title: `Task ${id}`, project: "Dash", repo, createdAt: 10, updatedAt: 10,
    facts: { blocker: "Which currency?" }, url: null, ref: { source: "task", taskId: id, status, channel: "general" },
  }
}

function proposal(id: string, repo: string | null, version = "1"): SourceItem {
  return {
    source: "proposal", refId: id, version, title: `Proposal ${id}`, project: "Dash", repo, createdAt: 5, updatedAt: 20,
    facts: { prompt: "Do it" }, url: null, ref: { source: "proposal", taskId: id, macFix: false },
  }
}

function pr(n: number, repo: string, parked: string | undefined, safetyNet = false): SourceItem {
  const url = `https://github.com/jaubut/${repo}/pull/${n}`
  return {
    source: "pr", refId: `jaubut/${repo}#${n}`, version: `v|${n}`, title: `PR ${n}`, project: repo, repo, createdAt: 30, updatedAt: 30,
    facts: { reason: parked ?? "" }, url, hints: { safetyNet, ...(parked !== undefined ? { parked } : {}) },
    ref: { source: "pr", taskId: `t${n}`, prUrl: url, repo: `jaubut/${repo}`, number: n },
  }
}

function body(): SourceItem {
  return {
    source: "body", refId: "zettlab:svc:x", version: "inv", title: "x is dead", project: "Body", createdAt: 1, updatedAt: 1,
    facts: {}, url: null, ref: { source: "body", componentId: "zettlab:svc:x", investigationId: "inv" },
  }
}

const input = (src: SourceItem): CardInput => ({ item: buildItem(src, fallbackPhrase(src), "normal") as TriageItem, src })
const cards = (srcs: SourceItem[], resolving: ResolvingItem[] = [], runs = new Map<string, RepoRun>()) => buildRepoCards(srcs.map(input), resolving, runs)

describe("repo keys and membership", () => {
  test("task / proposal / PR fold by repo, null repo → _other; body and mytask are never members", () => {
    expect(repoKeyOf({ source: "task", repo: "dash" })).toBe("dash")
    expect(repoKeyOf({ source: "proposal", repo: null })).toBe(REPO_OTHER)
    expect(repoKeyOf({ source: "body", repo: null })).toBeNull()
    expect(repoKeyOf({ source: "mytask", repo: null })).toBeNull()
    const out = cards([task("a", "dash"), proposal("p", null), body()])
    expect(out.map((c) => [c.id, c.repo, c.name])).toEqual([["repo:dash", "dash", "dash"], [`repo:${REPO_OTHER}`, null, "Other work"]])
  })

  test("what Yes does per member: approve proposals, Opus on tasks, hand back parked PRs, Opus on superseded / task-already parks", () => {
    expect(memberDoes(proposal("p", "dash"))).toBe("approve")
    expect(memberDoes(task("a", "dash"))).toBe("ask_opus")
    expect(memberDoes(task("f", "dash", "failed|1", "failed"))).toBe("ask_opus")
    expect(memberDoes(pr(1, "dash", "CI still failing after 2 fixes: test"))).toBe("hand_back")
    expect(memberDoes(pr(2, "dash", "merge conflict unresolved after 2 attempts"))).toBe("hand_back")
    expect(memberDoes(pr(3, "dash", "superseded by #9 — close this one"))).toBe("ask_opus")
    expect(memberDoes(pr(4, "dash", "task already done but PR still open"))).toBe("ask_opus")
  })

  test("held: sensitive, client, needs-your-review, stale, dep auto-merge off parks and the never-parked safety net", () => {
    const held = [
      "touches src/lib/auth.ts — needs your review",
      "dep lane: touches package.json",
      "sensitive path .github/workflows/ci.yml",
      "dep lane: sensitive path migrations/1.sql",
      "client PR: ticket 12 — needs your review",
      "client-origin PR — human review required",
      "stale (no activity for 9 days)",
      "dep auto-merge off (~/.claude/.dispatch-automerge-deps absent)",
    ]
    for (const reason of held) {
      expect(heldReason(pr(5, "dash", reason))).not.toBeNull()
      expect(memberDoes(pr(5, "dash", reason))).toBeNull()
    }
    expect(heldReason(pr(6, "dash", undefined, true))).toBe("not reviewed yet")
    expect(heldReason(pr(7, "dash", "CI still failing after 2 fixes"))).toBeNull()
    expect(heldReason(task("a", "dash"))).toBeNull()
  })

  test("a held PR is listed in held[], not in members[]; it stays an individual card", () => {
    const [c] = cards([pr(1, "dash", "touches src/auth.ts — needs your review"), pr(2, "dash", "CI still failing after 2 fixes")])
    expect(c!.members.map((m) => m.id)).toEqual(["pr:jaubut/dash#2"])
    expect(c!.held).toEqual(["pr:jaubut/dash#1"])
    expect(c!.counts).toMatchObject({ members: 1, held: 1, prs: 2 })
  })
})

describe("card version", () => {
  test("changes on a member value edit with equal counts; stable otherwise", () => {
    const [a] = cards([task("a", "dash", "blocked|1"), proposal("p", "dash")])
    const [same] = cards([task("a", "dash", "blocked|1"), proposal("p", "dash")])
    const [edited] = cards([task("a", "dash", "blocked|2"), proposal("p", "dash")])
    expect(same!.version).toBe(a!.version)
    expect(edited!.counts).toEqual(a!.counts)
    expect(edited!.version).not.toBe(a!.version)
  })

  test("a run's status moves the version (running → done)", () => {
    const run = (status: RepoRun["status"]): Map<string, RepoRun> => new Map([["dash", {
      id: 3, repoKey: "dash", cardVersion: "x", decision: "yes", note: null, idemKey: "k", status, results: [], summary: null, createdAt: 40, finishedAt: null,
    }]])
    const [running] = cards([task("a", "dash")], [], run("running"))
    const [done] = cards([task("a", "dash")], [], run("done"))
    expect(running!.run).toMatchObject({ id: 3, status: "running", decision: "yes" })
    expect(done!.version).not.toBe(running!.version)
  })

  test("a repo with only a running run keeps its card; a finished run alone does not", () => {
    const r = (status: RepoRun["status"]): Map<string, RepoRun> => new Map([["dash", {
      id: 1, repoKey: "dash", cardVersion: "x", decision: "no", note: "smaller", idemKey: "k", status, results: [], summary: null, createdAt: 1, finishedAt: null,
    }]])
    expect(cards([], [], r("running")).map((c) => c.id)).toEqual(["repo:dash"])
    expect(cards([], [], r("done"))).toEqual([])
  })
})

describe("yesPlan: the posted snapshot only", () => {
  const card = () => cards([task("a", "dash"), proposal("p", "dash"), pr(1, "dash", "touches auth — needs your review")])[0]!

  test("intersection: same version acts; a changed version is skipped; held and unknown ids are skipped", () => {
    const c = card()
    const plan = yesPlan(c, [
      { id: "task:a", version: "blocked|1" },
      { id: "proposal:p", version: "0" },
      { id: "pr:jaubut/dash#1", version: "v|1" },
      { id: "task:zzz", version: "1" },
    ])
    expect(plan.act.map((m) => [m.id, m.does])).toEqual([["task:a", "ask_opus"]])
    expect(plan.skipped).toEqual([
      { id: "proposal:p", reason: "changed" },
      { id: "pr:jaubut/dash#1", reason: "held" },
      { id: "task:zzz", reason: "gone" },
    ])
  })

  test("an item that arrived after the snapshot is untouched (neither acted on nor skipped)", () => {
    const before = card()
    const after = cards([task("a", "dash"), proposal("p", "dash"), task("late", "dash")])[0]!
    const plan = yesPlan(after, before.members.map((m) => ({ id: m.id, version: m.version })))
    expect(plan.act.map((m) => m.id).sort()).toEqual(["proposal:p", "task:a"])
    expect(plan.skipped).toEqual([])
  })
})

describe("overview + run summary", () => {
  test("plain lines per member, held and Opus's work, capped", () => {
    const resolving: ResolvingItem[] = [{ id: "task:r", source: "task", title: "R", project: null, repo: "dash", resolver: { status: "resolving", summary: "s", model: "m", finishedAt: null } }]
    const [c] = cards([task("a", "dash"), proposal("p", "dash"), pr(1, "dash", "touches auth — needs your review")], resolving)
    expect(c!.overview).toEqual(["Opus answers: Task a", "Start: Proposal p", "Stays with you: PR 1", "Opus is on 1 more"])
    expect(c!.counts.resolving).toBe(1)
    const many = overviewLines(Array.from({ length: 9 }, (_, i) => `Start: P${i}`))
    expect(many).toHaveLength(6)
    expect(many.at(-1)).toBe("+4 more")
  })

  test("run summary: counts per outcome with failure reasons", () => {
    expect(runSummary([
      { id: "a", result: "done" }, { id: "b", result: "done" }, { id: "c", result: "with_opus" },
      { id: "d", result: "handed_back" }, { id: "e", result: "failed", reason: "live cap" }, { id: "f", result: "skipped", reason: "changed" },
    ])).toBe("2 started · 1 with Opus · 1 handed back · 1 failed (live cap) · 1 skipped (changed)")
  })
})
