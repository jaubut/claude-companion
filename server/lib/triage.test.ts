import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createInvestigationStore } from "./body-investigate"
import type { DispatchTask } from "./dispatch-tasks"
import type { Task } from "./orchestrator-chat"
import {
  type SourceItem, type TriageItem, ANSWER_TEXT_MAX, CONFLICT_MERGE_LABEL, PROBLEM_MAX, allowedActions, approvalSummary, buildItem, conflictPhrase, fallbackPhrase, heuristicSeverity, orderItems, phrasePrompt, triageDigest, validatePhrase,
} from "./triage"
import { withAskOpus } from "./triage"
import { APPROVAL_TTL_MS, APPROVED_MERGE, NEEDS_HUMAN, PR_SAFETY_NET_MS, bodyComponentUrl, bodySources, latestProposals, parsePrUrl, prApprovals, prGone, prSources, proposalSource, taskSources } from "./triage-sources"

// Pure triage: collection per source, phrasing validation + fallback,
// severity heuristics, ordering. No sqlite-bound module (the investigation
// store takes its own :memory: Database).

const NOW = Date.parse("2026-10-04T16:00:00Z")
const ts = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)

function dtask(over: Partial<DispatchTask> = {}): DispatchTask {
  return {
    id: "a".repeat(32), noteId: "projects/x", title: "Fix the CSV export", agent: "builder", status: "blocked", done: false,
    blocker: "Which currency should the export use, CAD or USD?", owner: null, prUrl: null, resultRef: null,
    projectTitle: "Dashboard", projectRef: "PRJ-WCLS", createdAt: NOW - 5000, updatedAt: NOW - 1000, updatedAtRaw: ts(NOW - 1000), ...over,
  }
}

const blockedSrc = (): SourceItem => taskSources([dtask()], () => "general")[0]!

describe("collection per source", () => {
  test("tasks: blocked and retryable failures only; done, running and hopeless failures stay out", () => {
    const list = taskSources([
      dtask({ id: "b1" }),
      dtask({ id: "f1", status: "failed", blocker: "claude exited 1 (overloaded)" }),
      dtask({ id: "f2", status: "failed", blocker: "unknown agent: foo" }),
      dtask({ id: "d1", done: true }),
      dtask({ id: "r1", status: "running" }),
      dtask({ id: "q1", status: "queued" }),
    ], () => "general")
    expect(list.map((s) => s.refId)).toEqual(["b1", "f1"])
    expect(list[0]).toMatchObject({ source: "task", version: `blocked|${ts(NOW - 1000)}`, ref: { source: "task", status: "blocked", channel: "general" } })
    expect(list[1]!.ref).toMatchObject({ status: "failed" })
  })

  test("proposals: only `proposed`, with the Mac fix flag", () => {
    const t = { taskId: "p1", threadId: "body", prompt: "Restart the job\nmore", cwd: "/x", sessionKey: null, tmuxSession: null, reasoning: "it died", logTail: null, status: "proposed", createdAt: 1, updatedAt: 2, title: null } as Task
    const s = proposalSource(t, { channelName: "Body", project: null, macFix: true })!
    expect(s).toMatchObject({ source: "proposal", refId: "p1", version: "2", title: "Restart the job", ref: { macFix: true } })
    expect(proposalSource({ ...t, status: "filed" }, { channelName: null, project: null, macFix: false })).toBeNull()
  })

  const prTask = (id: string, url: string | null, updated = NOW - 1000) => ({ id, text: `PR task ${id}`, updated_at: ts(updated), created_at: ts(updated), dispatch_status: "completed", dispatch_blocker: "⚠ review: CHANGES", dispatch_pr_url: url, note_title: "Review app" })
  const act = (id: number, target: string, action: string, meta: Record<string, unknown> = {}, at = NOW - 500) => ({ id, target_id: target, action, meta: JSON.stringify(meta), ts: ts(at) })

  test("PRs: the shepherd's pr:needs-human marker, url from its meta, refId owner/repo#n", () => {
    const items = prSources({
      tasks: [prTask("t1", "https://github.com/jaubut/tls-review/pull/4"), prTask("t2", null)],
      activity: [
        act(10, "t1", NEEDS_HUMAN, { reason: "touches auth", repo: "tls-review", pr: 4, url: "https://github.com/jaubut/tls-review/pull/4" }),
        act(11, "t2", NEEDS_HUMAN, { reason: "merge conflict", url: "https://github.com/jaubut/x/pull/9" }),
      ],
    }, NOW)
    expect(items.map((i) => i.refId)).toEqual(["jaubut/tls-review#4", "jaubut/x#9"])
    expect(items[0]).toMatchObject({ source: "pr", url: "https://github.com/jaubut/tls-review/pull/4", facts: { reason: "touches auth" }, ref: { taskId: "t1", number: 4 } })
    expect(items[0]!.version).toBe(`${ts(NOW - 1000)}|10`)
  })

  test("PRs: other shepherd activity hides it; an outcome after the marker hides it; the 48 h safety net catches the rest", () => {
    const old = NOW - PR_SAFETY_NET_MS - 60_000
    const items = prSources({
      tasks: [
        prTask("busy", "https://github.com/o/r/pull/1"),
        prTask("closed", "https://github.com/o/r/pull/2"),
        prTask("young", "https://github.com/o/r/pull/3"),
        prTask("stale", "https://github.com/o/r/pull/4", old),
        prTask("shepherded-old", "https://github.com/o/r/pull/5", old),
      ],
      activity: [
        act(1, "busy", NEEDS_HUMAN), act(2, "busy", "pr:fixing-ci"),
        act(3, "closed", NEEDS_HUMAN), act(4, "closed", "outcome:rejected"),
        act(5, "shepherded-old", "pr:watching"),
      ],
    }, NOW)
    expect(items.map((i) => i.ref.source === "pr" && i.ref.taskId)).toEqual(["stale"])
    expect(items[0]!.hints?.safetyNet).toBe(true)
    expect(heuristicSeverity(items[0]!)).toBe("low")
  })

  test("PRs: a long Opus-escalated park reason is kept verbatim in facts.reason (suffix included)", () => {
    const reason = `${"touches src/lib/auth and the session store; ".repeat(8)}· Opus: session cookie flag dropped, check before merge`
    const [item] = prSources({
      tasks: [prTask("op", "https://github.com/o/r/pull/7")],
      activity: [act(1, "op", NEEDS_HUMAN, { reason, url: "https://github.com/o/r/pull/7", cascade: { stage: "opus", verdict: "ESCALATE" } })],
    }, NOW)
    expect(reason.length).toBeGreaterThan(PROBLEM_MAX)
    expect(item!.facts.reason).toBe(reason)
  })

  test("parsePrUrl only takes github PR URLs", () => {
    expect(parsePrUrl("https://github.com/a/b/pull/12")).toMatchObject({ owner: "a", repo: "b", number: 12 })
    expect(parsePrUrl("https://evil.example/a/b/pull/12")).toBeNull()
  })

  test("Body: failed twice with no proposal and nothing open; recovered or once-failed stays out", () => {
    const store = createInvestigationStore(new Database(":memory:"))
    const fail = (cid: string, at: number) => {
      const r = store.insert({ componentId: cid, host: "zettlab", state: "dead", trigger: "sweep", status: "running", runOn: "local", attempt: 1 }, at)
      store.update(r.id, { status: "failed", finishedAt: at, error: "claude timed out" })
      return r.id
    }
    fail("zettlab:svc:twice", NOW - 3000); const last = fail("zettlab:svc:twice", NOW - 2000)
    fail("zettlab:svc:once", NOW - 2000)
    fail("zettlab:svc:healed", NOW - 3000); fail("zettlab:svc:healed", NOW - 2000)
    const items = bodySources(store, NOW, { isProblem: (id) => id !== "zettlab:svc:healed", criticality: () => "critical" })
    expect(items.map((i) => i.refId)).toEqual(["zettlab:svc:twice"])
    expect(items[0]).toMatchObject({ version: last, url: bodyComponentUrl("zettlab:svc:twice"), facts: { error: "claude timed out" } })
    expect(heuristicSeverity(items[0]!)).toBe("urgent")
    expect(allowedActions(items[0]!)).toEqual(["requeue", "open_url", "snooze"])
  })
})

describe("phrasing", () => {
  const good = (options: unknown[]) => JSON.stringify({ title: "Currency for the export?", problem: "The worker needs to know the currency.", action: "Answer CAD.", options })

  test("the prompt names only this source's allowed actions and the blocker", () => {
    const p = phrasePrompt(blockedSrc())
    expect(p).toContain('"kind":"answer"')
    expect(p).toContain("Which currency")
    expect(p).not.toContain('"kind":"merge"')
    expect(p).toContain("FIRST option is your recommendation")
  })

  test("valid output: recommended first, re-ided a..d, destructive set by code, answer_custom kept", () => {
    const ph = validatePhrase("```json\n" + good([
      { label: "Use CAD", detail: "Same as the invoices", action: { kind: "answer", text: "Use CAD everywhere." } },
      { label: "Use USD", action: { kind: "answer", text: "Use USD." } },
      { label: "Type my own", action: { kind: "answer_custom" } },
      { label: "Drop it", action: { kind: "cancel" } },
    ]) + "\n```", blockedSrc())!
    expect(ph.recommended).toBe("a")
    expect(ph.options.map((o) => [o.id, o.action.kind])).toEqual([["a", "answer"], ["b", "answer"], ["c", "answer_custom"], ["d", "cancel"]])
    expect(ph.options[3]!.destructive).toBe(true)
    expect(ph.options[0]!.destructive).toBeUndefined()
  })

  test("a blocked task always offers answer_custom (appended when the model left it out)", () => {
    const ph = validatePhrase(good([
      { label: "Use CAD", action: { kind: "answer", text: "CAD" } },
      { label: "Retry", action: { kind: "requeue" } },
    ]), blockedSrc())!
    expect(ph.options.map((o) => o.action.kind)).toEqual(["answer", "requeue", "answer_custom"])
  })

  test("invalid output → null (the caller falls back)", () => {
    const src = blockedSrc()
    expect(validatePhrase(null, src)).toBeNull()
    expect(validatePhrase("not json", src)).toBeNull()
    expect(validatePhrase(good([{ label: "Merge", action: { kind: "merge" } }, { label: "x", action: { kind: "cancel" } }]), src)).toBeNull()
    expect(validatePhrase(good([{ label: "Only one", action: { kind: "cancel" } }]), src)).toBeNull()
    expect(validatePhrase(good([{ label: "Empty answer", action: { kind: "answer", text: " " } }, { label: "x", action: { kind: "cancel" } }]), src)).toBeNull()
    expect(validatePhrase(JSON.stringify({ problem: "p", options: [] }), src)).toBeNull()
    // A failed task cannot be unblocked.
    const failed = taskSources([dtask({ status: "failed", blocker: "crashed" })], () => null)[0]!
    expect(validatePhrase(good([{ label: "a", action: { kind: "answer", text: "x" } }, { label: "b", action: { kind: "cancel" } }]), failed)).toBeNull()
  })

  test("an answer option keeps its full text up to ANSWER_MAX; above it the card is refused (fallback), never sliced", () => {
    const long = `${"x".repeat(1996)} END`
    const ph = validatePhrase(good([{ label: "Confirm", action: { kind: "answer", text: long } }, { label: "x", action: { kind: "cancel" } }]), blockedSrc())!
    expect(ph.options[0]!.action).toEqual({ kind: "answer", text: long })
    expect(validatePhrase(good([
      { label: "Too long", action: { kind: "answer", text: "y".repeat(ANSWER_TEXT_MAX + 1) } },
      { label: "Cancel", action: { kind: "cancel" } },
    ]), blockedSrc())).toBeNull()
  })

  test("open_url always carries the source's own URL, never the model's", () => {
    const pr = prSources({ tasks: [{ id: "t", text: "x", updated_at: ts(NOW), created_at: ts(NOW), dispatch_status: "completed", dispatch_blocker: "", dispatch_pr_url: "https://github.com/o/r/pull/7", note_title: null }], activity: [{ id: 1, target_id: "t", action: NEEDS_HUMAN, meta: "{}", ts: ts(NOW) }] }, NOW)[0]!
    const ph = validatePhrase(good([
      { label: "Look", action: { kind: "open_url", url: "https://evil.example" } },
      { label: "Merge", action: { kind: "merge" } },
      { label: "Nap", action: { kind: "snooze", hours: 9999 } },
    ]), pr)!
    expect(ph.options[0]!.action).toEqual({ kind: "open_url", url: "https://github.com/o/r/pull/7" })
    expect(ph.options[2]!.action).toEqual({ kind: "snooze", hours: 168 })
  })

  test("labels and texts are clipped to the contract lengths", () => {
    const ph = validatePhrase(JSON.stringify({
      title: "t".repeat(200), problem: "p", action: "a",
      options: [{ label: "L".repeat(80), detail: "d".repeat(200), action: { kind: "requeue" } }, { label: "x", action: { kind: "cancel" } }],
    }), blockedSrc())!
    expect(ph.title.length).toBeLessThanOrEqual(80)
    expect(ph.options[0]!.label.length).toBeLessThanOrEqual(32)
    expect(ph.options[0]!.detail!.length).toBeLessThanOrEqual(90)
  })

  test("fallback per source: blocker text + answer_custom / requeue / cancel; proposal approve first; PR review first", () => {
    const fb = fallbackPhrase(blockedSrc())
    expect(fb.problem).toBe("Which currency should the export use, CAD or USD?")
    expect(fb.options.map((o) => o.action.kind)).toEqual(["answer_custom", "requeue", "cancel"])
    const t = { taskId: "p1", threadId: "general", prompt: "Do it", cwd: "", sessionKey: null, tmuxSession: null, reasoning: null, logTail: null, status: "proposed", createdAt: 1, updatedAt: 1 } as Task
    expect(fallbackPhrase(proposalSource(t, { channelName: null, project: null, macFix: true })!).options.map((o) => [o.label, o.action.kind])).toEqual([
      ["Run the fix on the Mac", "approve"], ["Reject it", "reject"], ["Snooze for a day", "snooze"],
    ])
    const pr = prSources({ tasks: [{ id: "t", text: "x", updated_at: ts(NOW), created_at: ts(NOW), dispatch_status: "completed", dispatch_blocker: "", dispatch_pr_url: "https://github.com/o/r/pull/7", note_title: null }], activity: [{ id: 1, target_id: "t", action: NEEDS_HUMAN, meta: "{}", ts: ts(NOW) }] }, NOW)[0]!
    expect(fallbackPhrase(pr).options.map((o) => o.action.kind)).toEqual(["open_url", "merge", "close_pr"])
    for (const p of [fb, fallbackPhrase(pr)]) expect(p.recommended).toBe("a")
  })
})

describe("severity + ordering", () => {
  test("heuristics: production / client words → urgent; failed task → low", () => {
    expect(heuristicSeverity(taskSources([dtask({ blocker: "Prod is down for the client — roll back?" })], () => null)[0]!)).toBe("urgent")
    expect(heuristicSeverity(blockedSrc())).toBe("normal")
    expect(heuristicSeverity(taskSources([dtask({ status: "failed", blocker: "crashed" })], () => null)[0]!)).toBe("low")
  })

  test("urgent first, then oldest", () => {
    const mk = (id: string, severity: TriageItem["severity"], createdAt: number): TriageItem =>
      ({ ...buildItem(blockedSrc(), fallbackPhrase(blockedSrc()), severity), id, createdAt })
    const out = orderItems([mk("n-new", "normal", 30), mk("low", "low", 1), mk("u-new", "urgent", 20), mk("n-old", "normal", 10), mk("u-old", "urgent", 5)])
    expect(out.map((i) => i.id)).toEqual(["u-old", "u-new", "n-old", "n-new", "low"])
  })

  test("the brain digest counts items and urgent ones", () => {
    const item = buildItem(blockedSrc(), fallbackPhrase(blockedSrc()), "urgent")
    expect(triageDigest([])).toBeNull()
    expect(triageDigest([item, { ...item, id: "x", severity: "normal" }])).toStartWith("Triage: 2 items wait for Jeremie (1 urgent)")
  })
})

describe("merge intent (2026-10-05)", () => {
  const URL = "https://github.com/jaubut/tls-dashboard-v2/pull/164"
  const task = { id: "t164", text: "Quotes out of the books: safe to merge", updated_at: ts(NOW - 60_000), created_at: ts(NOW - 60_000), dispatch_status: "completed", dispatch_blocker: "", dispatch_pr_url: URL, note_title: "Dashboard" }
  const act = (id: number, action: string, meta: Record<string, unknown> = {}, at = NOW - 500) => ({ id, target_id: "t164", action, meta: JSON.stringify({ url: URL, ...meta }), ts: ts(at) })
  const approve = (id: number, at: number, reason = "conflict") => act(id, APPROVED_MERGE, { approvedHeadSha: "abc", approvedAt: new Date(at).toISOString(), reason, by: "jeremie" }, at)

  test("a live approval newer than the park: no card, one approved row with the reason", () => {
    const rows = { tasks: [task], activity: [act(1, NEEDS_HUMAN, { reason: "touches books" }), approve(2, NOW - 1000)] }
    expect(prSources(rows, NOW)).toEqual([])
    expect(prApprovals(rows, NOW)).toEqual([{
      id: "pr:jaubut/tls-dashboard-v2#164", taskId: "t164", url: URL, title: task.text, project: "Dashboard", repo: "tls-dashboard-v2",
      reason: "conflict", approvedAt: NOW - 1000, approvedHeadSha: "abc",
    }])
  })

  test("shepherd activity after the approval (fix attempts) keeps it approved, not a card", () => {
    const rows = { tasks: [task], activity: [act(1, NEEDS_HUMAN), approve(2, NOW - 1000), act(3, "pr:fix-attempt", { kind: "conflict" })] }
    expect(prSources(rows, NOW)).toEqual([])
    expect(prApprovals(rows, NOW)).toHaveLength(1)
  })

  test("re-parked after the approval (changed after your approval): the card is back, no approved row", () => {
    const rows = { tasks: [task], activity: [act(1, NEEDS_HUMAN), approve(2, NOW - 2000), act(3, NEEDS_HUMAN, { reason: "changed after your approval: src/x.ts" })] }
    expect(prSources(rows, NOW).map((i) => i.facts.reason)).toEqual(["changed after your approval: src/x.ts"])
    expect(prApprovals(rows, NOW)).toEqual([])
  })

  test("an approval older than 7 days: the park holds again, the card says the approval expired", () => {
    const old = NOW - APPROVAL_TTL_MS - 60_000
    const rows = { tasks: [task], activity: [act(1, NEEDS_HUMAN, { reason: "touches books" }, old - 1000), approve(2, old)] }
    expect(prApprovals(rows, NOW)).toEqual([])
    const items = prSources(rows, NOW)
    expect(items).toHaveLength(1)
    expect(items[0]!.facts.reason).toBe("Your merge approval expired (7 days). touches books")
  })

  test("merged by the shepherd (outcome after the approval): neither a card nor a row", () => {
    const rows = { tasks: [task], activity: [act(1, NEEDS_HUMAN), approve(2, NOW - 1000), act(3, "outcome:merged")] }
    expect(prSources(rows, NOW)).toEqual([])
    expect(prApprovals(rows, NOW)).toEqual([])
  })

  test("a conflicting PR's card: headline and merge option say so, whatever the phrasing said", () => {
    const rows = { tasks: [task], activity: [act(1, NEEDS_HUMAN, { reason: "touches books" })] }
    const src = prSources(rows, NOW)[0]!
    const phrase = { ...fallbackPhrase(src), title: "Quotes out of the books: safe to merge", action: "Merge it: safe to merge." }
    const plain = buildItem(src, phrase, "normal")
    expect(plain.title).toBe("Quotes out of the books: safe to merge")
    const item = buildItem({ ...src, facts: { ...src.facts, mergeable: "CONFLICTING" } }, phrase, "normal")
    expect(item.title).toBe("Quotes out of the books: merge after the conflict fix")
    expect(item.action).toBe("Merge it: merge after the conflict fix.")
    expect(item.problem.startsWith("GitHub reports a merge conflict")).toBe(true)
    expect(item.options.find((o) => o.action.kind === "merge")!.label).toBe(CONFLICT_MERGE_LABEL)
    expect(conflictPhrase({ ...phrase, title: "Ship it" }).title).toBe("Ship it — conflicting now")
  })

  test("approvalSummary", () => {
    expect(approvalSummary("conflict")).toBe("Approved — merging once the conflict clears")
    expect(approvalSummary("ci_pending")).toBe("Approved — merging once pending CI clears")
    expect(approvalSummary(null)).toBe("Approved — merging on the PR shepherd's next pass")
  })
})

describe("queue hygiene (2026-10-14)", () => {
  const ptask = (id: string, url: string, done: number, updated = NOW - 1000) => ({ id, text: `PR task ${id}`, done, updated_at: ts(updated), created_at: ts(updated), dispatch_status: "completed", dispatch_blocker: "", dispatch_pr_url: url, note_title: "Remorquage" })
  const act = (id: number, target: string, action: string, url: string, at = NOW - 500) => ({ id, target_id: target, action, meta: JSON.stringify({ url, reason: "needs your review" }), ts: ts(at) })

  test("(1) GitHub state: MERGED / CLOSED drop the card; OPEN or unknown keep it", () => {
    expect(prGone("CLOSED")).toBe(true)
    expect(prGone("MERGED")).toBe(true)
    expect(prGone("OPEN")).toBe(false)
    expect(prGone("")).toBe(false)
    expect(prGone(undefined)).toBe(false)
  })

  test("(1b) done=1 task whose PR is still parked: shown; done=1 with no park as newest pr:* row, or with an outcome: not shown", () => {
    const u66 = "https://github.com/jaubut/remorquage-pelchat/pull/66"
    const u2 = "https://github.com/jaubut/x/pull/2"
    const u3 = "https://github.com/jaubut/x/pull/3"
    const u4 = "https://github.com/jaubut/x/pull/4"
    const old = NOW - PR_SAFETY_NET_MS - 60_000
    const items = prSources({
      tasks: [ptask("828e0d7d", u66, 1), ptask("moved-on", u2, 1), ptask("merged", u3, 1), ptask("quiet-done", u4, 1, old)],
      activity: [
        act(1, "828e0d7d", NEEDS_HUMAN, u66),
        act(2, "moved-on", NEEDS_HUMAN, u2), act(3, "moved-on", "pr:watching", u2),
        act(4, "merged", NEEDS_HUMAN, u3), act(5, "merged", "outcome:merged", u3),
      ],
    }, NOW)
    expect(items.map((i) => i.refId)).toEqual(["jaubut/remorquage-pelchat#66"])
    expect(items[0]).toMatchObject({ facts: { reason: "needs your review" }, hints: { safetyNet: false }, ref: { taskId: "828e0d7d", number: 66 } })
  })

  test("(1c) hints.parked = the park reason's prefix (the cascade's ' · Opus:' brief stripped); safety net and approvals carry none", () => {
    const u = "https://github.com/jaubut/x/pull/"
    const old = NOW - PR_SAFETY_NET_MS - 60_000
    const items = prSources({
      tasks: [ptask("p1", `${u}1`, 0), ptask("p2", `${u}2`, 0, old)],
      activity: [{ id: 1, target_id: "p1", action: NEEDS_HUMAN, meta: JSON.stringify({ url: `${u}1`, reason: "touches src/auth.ts — needs your review · Opus: cookie flag dropped" }), ts: ts(NOW - 500) }],
    }, NOW)
    expect(items.map((i) => [i.refId, i.hints?.parked])).toEqual([["jaubut/x#1", "touches src/auth.ts — needs your review"], ["jaubut/x#2", undefined]])
    expect(items[0]!.facts.reason).toContain("· Opus:")
    expect(items[1]!.hints).toMatchObject({ safetyNet: true })
  })

  const prop = (taskId: string, title: string, createdAt: number, over: Partial<Task> = {}) => ({
    taskId, threadId: "body", prompt: `${title}\ndetails`, cwd: "/x", sessionKey: null, tmuxSession: null, reasoning: null, logTail: null,
    status: "proposed", createdAt, updatedAt: createdAt, title, noteId: "projects/dash", ...over,
  }) as Task

  test("(2) proposals: same target + normalized title → the newest only; a Body fix by component; other targets kept", () => {
    const list = [
      prop("epic1", "Epic Games login agent", 1),
      prop("epic2", "Epic games — login agent!", 5),
      prop("mac1", "Mac secrets pull", 2),
      prop("mac2", "mac secrets pull", 3),
      prop("probe1", "Add Turso probes", 1),
      prop("probe2", "Turso probe for the dashboard", 4),
      prop("other", "Epic Games login agent", 2, { noteId: "projects/other" }),
      prop("arch", "Architecture map", 1),
      prop("fix12", "Fix PR 12", 1),
      prop("fix13", "Fix PR 13", 2),
    ]
    const component = (id: string) => (id.startsWith("probe") ? "zettlab:turso" : null)
    expect(latestProposals(list, component).map((t) => t.taskId)).toEqual(["epic2", "mac2", "probe2", "other", "arch", "fix12", "fix13"])
  })
})

describe("repo field (needs-you-by-repo, 2026-10-15)", () => {
  test("buildItem always emits repo: null when unset, the value when set (fallback, cached and prepared phrases alike)", () => {
    const src = blockedSrc()
    expect(src.repo).toBeUndefined() // collectors stay pure: wiring sets it
    const fb = buildItem(src, fallbackPhrase(src), "normal")
    expect(fb).toHaveProperty("repo", null)
    expect(Object.keys(fb)).toContain("repo")
    const named = { ...src, repo: "claude-companion" }
    expect(buildItem(named, fallbackPhrase(named), "low").repo).toBe("claude-companion")
    const prepared = { ...fallbackPhrase(named), title: "Opus card" }
    expect(buildItem(named, prepared, "urgent", { status: "prepared", summary: "s", model: "m", finishedAt: 1 }).repo).toBe("claude-companion")
  })

  test("repo never reaches the phrase prompt", () => {
    const src = blockedSrc()
    expect(phrasePrompt({ ...src, repo: "TLSTUDIO" })).toBe(phrasePrompt(src))
  })

  test("prSources: repo = the GitHub repo NAME from the URL (never owner/repo); version unchanged", () => {
    const row = { id: "t", text: "x", updated_at: ts(NOW), created_at: ts(NOW), dispatch_status: "completed", dispatch_blocker: "", dispatch_pr_url: "https://github.com/jaubut/claude-companion-ios/pull/12", note_title: "Companion iOS" }
    const [pr] = prSources({ tasks: [row], activity: [{ id: 1, target_id: "t", action: NEEDS_HUMAN, meta: "{}", ts: ts(NOW) }] }, NOW)
    expect(pr!.refId).toBe("jaubut/claude-companion-ios#12")
    expect(pr!.repo).toBe("claude-companion-ios")
    expect(pr!.version).toBe(`${ts(NOW)}|1`)
    expect(buildItem(pr!, fallbackPhrase(pr!), "normal").repo).toBe("claude-companion-ios")
  })

  test("prApprovals: repo set from the PR URL", () => {
    const URL = "https://github.com/jaubut/TLSTUDIO/pull/4"
    const row = { id: "t4", text: "Hero", updated_at: ts(NOW - 60_000), created_at: ts(NOW - 60_000), dispatch_status: "completed", dispatch_blocker: "", dispatch_pr_url: URL, note_title: null }
    const activity = [
      { id: 1, target_id: "t4", action: NEEDS_HUMAN, meta: JSON.stringify({ url: URL }), ts: ts(NOW - 900) },
      { id: 2, target_id: "t4", action: APPROVED_MERGE, meta: JSON.stringify({ url: URL, approvedAt: new Date(NOW - 500).toISOString(), approvedHeadSha: "h" }), ts: ts(NOW - 500) },
    ]
    const [a] = prApprovals({ tasks: [row], activity }, NOW)
    expect(a!.repo).toBe("TLSTUDIO")
    expect(a!.project).toBe("TLSTUDIO")
  })
})

describe("blocked task card: guarded unblock/requeue only (one work stream, slice B)", () => {
  test("the card's actions are the dispatch.sh vocabulary; a takeover is never offered nor accepted", () => {
    const src = blockedSrc()
    const kinds = buildItem(src, fallbackPhrase(src), "normal").options.map((o) => o.action.kind)
    expect(kinds).toEqual(["answer_custom", "requeue", "cancel"])
    expect(withAskOpus(buildItem(src, fallbackPhrase(src), "normal")).options.at(-1)!.id).toBe("opus")
    expect(allowedActions(src) as string[]).not.toContain("takeover")
    const raw = JSON.stringify({ problem: "p", action: "a", options: [{ label: "Take it", action: { kind: "takeover" } }, { label: "Retry", action: { kind: "requeue" } }] })
    expect(validatePhrase(raw, src)).toBeNull()
  })

  test("a blocked task carries no takeover hint", () => {
    const [ended] = taskSources([dtask({ blocker: "Takeover ended without a PR — Which currency?" })], () => "general")
    expect(ended!.hints).toBeUndefined()
  })
})
