import { beforeEach, describe, expect, test } from "bun:test"
import type { InvestigationResult } from "./body-investigate"
import type { Autonomy } from "./resolver"
import type { Job } from "./resolver-engine"
import type { FixOutcome } from "./resolver-fix"
import type { ResolverContext } from "./resolver-prompt"
import { type PlanReport, type WorkSeams, createResolverWork } from "./resolver-work"
import type { SourceItem, TriageAction } from "./triage"
import type { ExecOutcome } from "./triage-engine"

// One resolver run over fake seams and a MOCK model: what is executed (and
// through which guarded seam), what is recorded as agent_activity, and what
// card Jeremie gets — per source, per autonomy, dry run included.

const NOW = 1_000_000
let model: string
let ctx: ResolverContext
let calls: string[]
let executed: { action: TriageAction; by: string }[]
let records: { action: string; summary: string; meta: Record<string, unknown> }[]
let comments: string[]
let turns: string[]
let fixOut: FixOutcome
let execOut: ExecOutcome
let bodyOut: { ok: true; result: InvestigationResult } | { ok: false; error: string }
let reports: PlanReport[]

function task(): SourceItem {
  return {
    source: "task", refId: "t1", version: "blocked|x", title: "Invoice totals", project: "Dash", createdAt: 1, updatedAt: 1,
    facts: { status: "blocked", blocker: "Round per line or on the total?" }, url: null, ref: { source: "task", taskId: "t1", status: "blocked", channel: "general" },
  }
}

function pr(reason = "CI still failing after 2 fixes: test"): SourceItem {
  const url = "https://github.com/jaubut/tls-review/pull/9"
  return {
    source: "pr", refId: "jaubut/tls-review#9", version: "x|41", title: "Fix uploads", project: "tls-review", createdAt: 1, updatedAt: 1,
    facts: { reason, repo: "jaubut/tls-review" }, url, ref: { source: "pr", taskId: "tp9", prUrl: url, repo: "jaubut/tls-review", number: 9 },
  }
}

function proposal(): SourceItem {
  return {
    source: "proposal", refId: "p1", version: "1", title: "Add CSV export", project: "Dash", createdAt: 1, updatedAt: 1,
    facts: { prompt: "Add CSV export" }, url: null, ref: { source: "proposal", taskId: "p1", macFix: false },
  }
}

function body(): SourceItem {
  return {
    source: "body", refId: "zettlab:systemd-service:kb-api", version: "inv-2", title: "kb-api is dead", project: "Body", createdAt: 1, updatedAt: 1,
    facts: { problem: "dead", error: "timed out", host: "zettlab" }, url: null, ref: { source: "body", componentId: "zettlab:systemd-service:kb-api", investigationId: "inv-2" },
  }
}

function job(src: SourceItem, autonomy: Autonomy = "normal", instruction: string | null = null, dryRun = false, deadline = NOW + 60_000): Job {
  return {
    run: { id: 1, itemId: `${src.source}:${src.refId}`, rkey: "k", version: "v", source: src.source, refKey: "r", status: "running", autonomy, instruction, model: "claude-opus-5-5", summary: "", phrase: null, severity: null, action: null, reason: null, createdAt: NOW, startedAt: NOW, finishedAt: null, day: null },
    src, autonomy, instruction, dryRun, model: "claude-opus-5-5", deadline, repeat: false,
  }
}

const reply = (o: Record<string, unknown>) => JSON.stringify({ analysis: "Evidence: STATE.md says round per line.", summary: "Round per line (STATE.md decision).", confidence: 0.9, needsJeremie: false, why: "none", category: "", action: { kind: "none" }, ...o })

function seams(): WorkSeams {
  return {
    gather: async () => { calls.push("gather"); return ctx },
    analyze: async (prompt) => { calls.push(`analyze:${prompt.length > 0}`); return { ok: true, text: model } },
    investigate: async () => { calls.push("investigate"); return bodyOut },
    applyBody: async () => { calls.push("applyBody"); return bodyOut.ok && bodyOut.result.recommendedFix ? "prop-9" : null },
    execute: async (_src, action, by) => { executed.push({ action, by }); return execOut },
    comment: async (_src, b) => { comments.push(b); return true },
    fix: async (_s, _c, instructions) => { calls.push(`fix:${instructions}`); return fixOut },
    unpark: async (_s, reason) => { calls.push(`unpark:${reason}`) },
    revise: async (_s, title) => { calls.push(`revise:${title}`); return "p2" },
    record: async (_s, action, summary, meta) => { records.push({ action, summary, meta }) },
    turn: (_s, text) => { turns.push(text) },
    now: () => NOW,
    log: () => {},
  }
}

const work = () => createResolverWork(seams(), (r) => reports.push(r))

beforeEach(() => {
  ctx = { repo: "/repo", readableDirs: [], blocks: [], sensitivePaths: [], sensitive: false, rescuedBefore: false, pr: { head: "dispatch/ab12", base: "main", number: 9, title: "Fix uploads", taskText: "Fix uploads" } }
  calls = []; executed = []; records = []; comments = []; turns = []; reports = []
  fixOut = { kind: "pushed", sha: "abcdef1234567", summary: "Mocked the clock" }
  execOut = { kind: "done" }
  bodyOut = { ok: false, error: "x" }
  model = reply({})
})

describe("blocked task", () => {
  test("confident → answered through the guarded unblock, recorded 'Opus answered: …'", async () => {
    model = reply({ action: { kind: "answer", text: "Round per line, as STATE.md decided on 2026-09-30." } })
    const out = await work()(job(task()))
    expect(executed).toEqual([{ action: { kind: "answer", text: "Round per line, as STATE.md decided on 2026-09-30." }, by: "Opus" }])
    expect(out).toMatchObject({ kind: "resolved", action: "answer", summary: "Opus answered: Round per line, as STATE.md decided on 2026-09-30." })
    expect(records).toEqual([expect.objectContaining({ action: "resolver:answer", summary: "Opus answered: Round per line, as STATE.md decided on 2026-09-30." })])
    expect(records[0]!.meta).toMatchObject({ model: "claude-opus-5-5", autonomy: "normal", confidence: 0.9, reason: "confident (90 %)" })
  })

  test("not confident (client wording) → a card with Opus's answer recommended, nothing executed", async () => {
    model = reply({ action: { kind: "answer", text: "Bonjour Marie, …" }, needsJeremie: true, why: "client_wording", confidence: 0.6 })
    const out = await work()(job(task()))
    expect(executed).toEqual([])
    expect(out.kind).toBe("prepared")
    if (out.kind !== "prepared") return
    expect(out.phrase.options[0]!.action).toEqual({ kind: "answer", text: "Bonjour Marie, …" })
    expect(out.phrase.context).toContain("STATE.md")
    expect(records.map((r) => r.action)).toEqual(["resolver:prepared"])
  })

  test("the guarded write refused (task moved) → resolved as stale, no activity claim", async () => {
    model = reply({ action: { kind: "answer", text: "CAD" } })
    execOut = { kind: "stale", reason: "conflict" }
    expect(await work()(job(task()))).toMatchObject({ kind: "resolved", action: "stale" })
    expect(records).toEqual([])
  })

  test("a write error → Jeremie's card, with what Opus tried", async () => {
    model = reply({ action: { kind: "answer", text: "CAD" } })
    execOut = { kind: "error", status: 503, error: "turso_unreachable" }
    const out = await work()(job(task()))
    expect(out.kind).toBe("prepared")
    if (out.kind === "prepared") expect(out.phrase.context).toContain("Opus tried to answer but it did not go through: turso_unreachable")
  })
})

describe("parked PR", () => {
  const review = (verdict: string, problems: string[] = []) => ({ whatChanged: "session cookie flags", risk: "logout bypass", prodFailure: "users stay logged in", testsCover: "auth.test.ts covers it", problems, verdict })

  test("sensitive + safe → card 'Opus reviewed: …' with Merge recommended; never merged", async () => {
    ctx.sensitive = true
    ctx.sensitivePaths = ["server/lib/auth.ts"]
    model = reply({ action: { kind: "merge" }, category: "safe", confidence: 1, review: review("safe"), summary: "safe to merge because the cookie change is covered by auth.test.ts" })
    const out = await work()(job(pr("touches server/lib/auth.ts — needs your review")))
    expect(executed).toEqual([])
    expect(out).toMatchObject({ kind: "prepared", summary: "Opus reviewed: safe to merge because the cookie change is covered by auth.test.ts" })
    if (out.kind === "prepared") {
      expect(out.phrase.options[0]!.action.kind).toBe("merge")
      expect(out.phrase.context).toContain("Could fail in prod: users stay logged in")
    }
  })

  test("sensitive + problems → fix run on the PR branch, comment, then still a card (not unparked)", async () => {
    ctx.sensitive = true
    model = reply({ action: { kind: "fix", instructions: "Add the expiry check to the session cookie" }, review: review("changes", ["no expiry check"]) })
    const out = await work()(job(pr("touches server/lib/auth.ts — needs your review")))
    expect(calls).toContain("fix:Add the expiry check to the session cookie")
    expect(calls.some((c) => c.startsWith("unpark"))).toBe(false)
    expect(comments[0]).toContain("Opus pushed a fix (abcdef12)")
    expect(out).toMatchObject({ kind: "prepared", action: "fix" })
    expect(records.map((r) => r.action)).toEqual(["resolver:fix"])
  })

  test("sensitive: 'do it' from Jeremie merges through the guarded merge", async () => {
    ctx.sensitive = true
    model = reply({ action: { kind: "merge" }, review: review("safe") })
    const out = await work()(job(pr(), "elevated", "do it"))
    expect(executed).toEqual([{ action: { kind: "merge" }, by: "Opus" }])
    expect(out).toMatchObject({ kind: "resolved", action: "merge" })
  })

  test("stale / superseded → PR comment, then the guarded close; the reason is recorded", async () => {
    for (const category of ["stale", "superseded"]) {
      executed = []; comments = []; records = []
      model = reply({ action: { kind: "close_pr", reason: `${category}: replaced by #12` }, category, confidence: 0.95 })
      const out = await work()(job(pr(`${category} (no activity for 15 days)`)))
      expect(comments).toEqual([`🤖 **Opus resolver** — closing this PR: ${category}: replaced by #12`])
      expect(executed).toEqual([{ action: { kind: "close_pr" }, by: "Opus" }])
      expect(out).toMatchObject({ kind: "resolved", action: "close_pr", summary: `Opus closed the PR: ${category}: replaced by #12` })
      expect(records[0]).toMatchObject({ action: "resolver:close_pr", meta: expect.objectContaining({ reason: category, category }) })
    }
  })

  test("CI failing after 2 fixes → one rescue: fix run + hand back to the shepherd", async () => {
    model = reply({ action: { kind: "fix", instructions: "The upload test races the clock; inject it" }, category: "ci_failing" })
    const out = await work()(job(pr()))
    expect(calls).toEqual(["gather", "analyze:true", "fix:The upload test races the clock; inject it", "unpark:Opus rescue: The upload test races the clock; inject it"])
    expect(out).toMatchObject({ kind: "resolved", action: "fix" })
    expect(turns[0]).toContain("Opus pushed a fix (abcdef12)")
  })

  test("already rescued once → card, no second fix", async () => {
    ctx.rescuedBefore = true
    model = reply({ action: { kind: "fix", instructions: "again" }, category: "ci_failing" })
    expect((await work()(job(pr()))).kind).toBe("prepared")
    expect(calls.some((c) => c.startsWith("fix"))).toBe(false)
  })

  test("the fix agent blocked → card with its reason, nothing unparked", async () => {
    fixOut = { kind: "blocked", reason: "needs a Stripe test key" }
    model = reply({ action: { kind: "fix", instructions: "x" }, category: "ci_failing" })
    const out = await work()(job(pr()))
    expect(out.kind).toBe("prepared")
    if (out.kind === "prepared") expect(out.phrase.context).toContain("The fix agent stopped: needs a Stripe test key")
    expect(calls.some((c) => c.startsWith("unpark"))).toBe(false)
  })
})

describe("proposal", () => {
  test("duplicate → rejected with the reason (turn + activity)", async () => {
    model = reply({ action: { kind: "reject", reason: "duplicate of [p0], same CSV export" }, category: "duplicate" })
    const out = await work()(job(proposal()))
    expect(executed).toEqual([{ action: { kind: "reject" }, by: "Opus" }])
    expect(turns).toEqual(["🤖 Opus rejected it: duplicate of [p0], same CSV export"])
    expect(out).toMatchObject({ kind: "resolved", action: "reject" })
  })
  test("'make it smaller' → Opus rescopes it through revise", async () => {
    model = reply({ action: { kind: "revise", title: "CSV button only", prompt: "Only add the CSV button" } })
    const out = await work()(job(proposal(), "elevated", "make it smaller"))
    expect(calls).toContain("revise:CSV button only")
    expect(out).toMatchObject({ kind: "resolved", action: "revise" })
  })
  test("still needed → card with Opus's recommendation", async () => {
    model = reply({ category: "needed", summary: "Still needed: no export exists yet", card: {
      title: "Approve the CSV export", problem: "No export exists.", action: "Approve it.",
      options: [{ label: "Approve it", action: { kind: "approve" } }, { label: "Reject it", action: { kind: "reject" } }],
    } })
    const out = await work()(job(proposal()))
    expect(out).toMatchObject({ kind: "prepared", summary: "Still needed: no export exists yet" })
    if (out.kind === "prepared") expect(out.phrase.options.map((o) => o.action.kind)).toEqual(["approve", "reject"])
  })
})

describe("body failed twice", () => {
  test("a fix → posted as a #Body proposal (applyBody), recorded resolver:propose", async () => {
    bodyOut = { ok: true, result: { rootCause: "the venv moved", evidence: ["journalctl: No such file"], confidence: 0.9, severity: "high", recommendedFix: { summary: "Point ExecStart at the new venv", steps: [], risk: "low", reversible: true }, retire: false, notes: "" } }
    const out = await work()(job(body()))
    expect(calls).toEqual(["investigate", "applyBody"])
    expect(out).toMatchObject({ kind: "resolved", action: "propose" })
    expect(records[0]!.action).toBe("resolver:propose")
  })
  test("no fix → a plain explanation; investigation failure → falls through", async () => {
    bodyOut = { ok: true, result: { rootCause: "false positive: a one-shot unit", evidence: [], confidence: 0.9, severity: "low", recommendedFix: null, retire: false, notes: "" } }
    expect(await work()(job(body()))).toMatchObject({ kind: "resolved", action: "explain" })
    bodyOut = { ok: false, error: "timed out after 20 min" }
    expect(await work()(job(body()))).toMatchObject({ kind: "failed", summary: "Opus investigation failed: timed out after 20 min" })
  })
})

describe("safety", () => {
  test("dry run: the plan is reported, nothing is executed or recorded", async () => {
    model = reply({ action: { kind: "answer", text: "CAD" } })
    const out = await work()(job(task(), "normal", null, true))
    expect(executed).toEqual([])
    expect(records).toEqual([])
    expect(out.kind).toBe("prepared")
    expect(out.summary).toStartWith("DRY RUN — would answer: \"CAD\"")
    expect(reports[0]!.verdict).toBe("answer: \"CAD\" — confident (90 %)")
  })
  test("past the deadline before acting → falls through, nothing executed", async () => {
    model = reply({ action: { kind: "answer", text: "CAD" } })
    const out = await work()(job(task(), "normal", null, false, NOW - 1))
    expect(out).toEqual({ kind: "failed", summary: "deadline passed before acting" })
    expect(executed).toEqual([])
  })
  test("an Opus failure or unparseable output → failed (the normal card), recorded resolver:failed", async () => {
    model = "I think you should answer CAD."
    expect(await work()(job(task()))).toMatchObject({ kind: "failed", summary: "Opus output was not the expected JSON" })
    expect(records.map((r) => r.action)).toEqual(["resolver:failed"])
  })
})
