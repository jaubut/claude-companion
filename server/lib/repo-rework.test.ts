import { describe, expect, test } from "bun:test"
import { type ReworkMember, type ReworkOutput, parseRework, reworkPolicy, reworkPrompt, reworkSummary } from "./repo-rework"

// No (rework): one Opus call per No re-plans the repo's pending work. Pure:
// the prompt, parsing, and the policy that decides which of Opus's steps run.

const members: ReworkMember[] = [
  { id: "proposal:p1", source: "proposal", title: "Add CSV export", problem: "Proposed by the brain", recommended: "Approve and start it", held: false, blocked: false },
  { id: "task:t1", source: "task", title: "Invoice totals", problem: "Round per line or total?", recommended: "Answer it", held: false, blocked: true },
  { id: "task:t2", source: "task", title: "Flaky export", problem: "claude exited 1", recommended: "Retry it", held: false, blocked: false },
  { id: "pr:jaubut/dash#4", source: "pr", title: "Old PR", problem: "superseded by #9", recommended: "Close", held: false, blocked: false },
  { id: "pr:jaubut/dash#5", source: "pr", title: "Auth PR", problem: "touches auth — needs your review", recommended: "Merge", held: true, blocked: false },
]

const out = (steps: ReworkOutput["steps"], consent = false): ReworkOutput => ({ summary: "Smaller scope first.", consent, steps })

describe("prompt + parsing", () => {
  test("the prompt carries the repo, the note and every item (held ones marked)", () => {
    const p = reworkPrompt("dash", "Too big, do the export later", members)
    expect(p).toContain("dash")
    expect(p).toContain("Too big, do the export later")
    for (const m of members) expect(p).toContain(m.id)
    expect(p).toContain("HELD")
  })

  test("fenced JSON parses; malformed steps are dropped; garbage → null", () => {
    const text = "```json\n" + JSON.stringify({
      summary: "Rescoped the export", consent: true,
      steps: [
        { id: "proposal:p1", kind: "revise", title: "CSV only", prompt: "Add a CSV-only export", why: "smaller" },
        { id: "task:t1", kind: "answer", text: "Per line.", why: "STATE.md" },
        { id: "task:t2", kind: "answer", why: "no text" },
        { id: "task:t2", kind: "explode", why: "?" },
        { id: "pr:jaubut/dash#4", kind: "ask_opus", instruction: "close it if superseded", why: "x" },
      ],
    }) + "\n```"
    const o = parseRework(text)!
    expect(o.summary).toBe("Rescoped the export")
    expect(o.consent).toBe(true)
    expect(o.steps.map((s) => `${s.id}:${s.kind}`)).toEqual(["proposal:p1:revise", "task:t1:answer", "pr:jaubut/dash#4:ask_opus"])
    expect(parseRework("no json here")).toBeNull()
  })
})

describe("policy", () => {
  test("reject / revise on proposals, answer on blocked tasks, ask_opus on any non-held item", () => {
    const { run, refused } = reworkPolicy(out([
      { id: "proposal:p1", kind: "reject", why: "later" },
      { id: "task:t1", kind: "answer", text: "Per line.", why: "STATE.md" },
      { id: "task:t2", kind: "answer", text: "x", why: "not blocked" },
      { id: "task:t2", kind: "reject", why: "wrong source" },
      { id: "pr:jaubut/dash#4", kind: "ask_opus", instruction: "close if superseded", why: "x" },
    ]), members, "too big")
    expect(run.map((s) => `${s.id}:${s.kind}`)).toEqual(["proposal:p1:reject", "task:t1:answer", "pr:jaubut/dash#4:ask_opus"])
    expect(refused.map((r) => r.id)).toEqual(["task:t2", "task:t2"])
  })

  test("cancel / close_pr only with consent words in the note (and Opus's flag for a longer order)", () => {
    const steps: ReworkOutput["steps"] = [
      { id: "task:t2", kind: "cancel", why: "obsolete" },
      { id: "pr:jaubut/dash#4", kind: "close_pr", why: "superseded" },
    ]
    expect(reworkPolicy(out(steps), members, "rethink the scope, it's too big").run).toEqual([])
    expect(reworkPolicy(out(steps, true), members, "rethink the scope, it's too big").run).toEqual([])
    expect(reworkPolicy(out(steps), members, "vas-y").run.map((s) => s.kind)).toEqual(["cancel", "close_pr"])
    expect(reworkPolicy(out(steps, true), members, "drop the old stuff and close the superseded PR").run.map((s) => s.kind)).toEqual(["cancel", "close_pr"])
    expect(reworkPolicy(out(steps, false), members, "drop the old stuff and close the superseded PR").run).toEqual([])
  })

  test("never on held PRs, unknown ids, or a second step on the same item", () => {
    const { run, refused } = reworkPolicy(out([
      { id: "pr:jaubut/dash#5", kind: "ask_opus", instruction: "merge", why: "x" },
      { id: "pr:jaubut/dash#5", kind: "close_pr", why: "x" },
      { id: "task:nope", kind: "ask_opus", instruction: "x", why: "x" },
      { id: "task:t1", kind: "answer", text: "A", why: "x" },
      { id: "task:t1", kind: "answer", text: "B", why: "x" },
    ], true), members, "vas-y")
    expect(run.map((s) => `${s.id}:${s.kind}`)).toEqual(["task:t1:answer"])
    expect(refused.map((r) => r.reason)).toEqual(["stays with Jeremie", "stays with Jeremie", "not on the card", "one step per item"])
  })

  test("summary: what Opus changed", () => {
    expect(reworkSummary({ rejected: 2, rescoped: 1, kept: 1 })).toBe("Opus re-planned after your No: rejected 2, rescoped 1, kept 1")
    expect(reworkSummary({ answered: 1, failed: 1 })).toBe("Opus re-planned after your No: answered 1, failed 1")
    expect(reworkSummary({})).toBe("Opus re-planned after your No: kept everything")
  })
})
