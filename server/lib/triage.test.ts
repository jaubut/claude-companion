import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createInvestigationStore } from "./body-investigate"
import type { DispatchTask } from "./dispatch-tasks"
import type { Task } from "./orchestrator-chat"
import {
  type SourceItem, type TriageItem, allowedActions, buildItem, fallbackPhrase, heuristicSeverity, orderItems, phrasePrompt, triageDigest, validatePhrase,
} from "./triage"
import { NEEDS_HUMAN, PR_SAFETY_NET_MS, bodyComponentUrl, bodySources, parsePrUrl, prSources, proposalSource, taskSources } from "./triage-sources"

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
