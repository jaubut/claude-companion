import { describe, expect, test } from "bun:test"
import {
  CONFIDENT, type PolicyCtx, type ResolverOutput, cardSummary, consents, decide, digestText, isSensitivePr, parseResolverOutput,
  preparedPhrase, resolverConfig, resolverKey, routable,
} from "./resolver"
import type { SourceItem } from "./triage"

// The resolver's pure half: config + kill switch, routing per source, the
// resolver key, output parsing, the POLICY (what may run without Jeremie),
// the prepared card, the digest.

function blockedTask(id = "t1", blocker = "Which currency for the invoice total?", version = "blocked|2026-10-04 10:00:00"): SourceItem {
  return {
    source: "task", refId: id, version, title: `Task ${id}`, project: "Dash", createdAt: 1, updatedAt: 1,
    facts: { status: "blocked", agent: "builder", blocker }, url: null, ref: { source: "task", taskId: id, status: "blocked", channel: "general" },
  }
}

function parkedPr(n = 7, reason = "CI still failing after 2 fixes: test", lastPr = "41"): SourceItem {
  const url = `https://github.com/jaubut/tls-review/pull/${n}`
  return {
    source: "pr", refId: `jaubut/tls-review#${n}`, version: `2026-10-04 09:00:00|${lastPr}`, title: `PR ${n}`, project: "tls-review",
    createdAt: 1, updatedAt: 1, facts: { reason, review: "", repo: "jaubut/tls-review" }, url,
    ref: { source: "pr", taskId: `task-pr-${n}`, prUrl: url, repo: "jaubut/tls-review", number: n },
  }
}

function proposal(id = "p1"): SourceItem {
  return {
    source: "proposal", refId: id, version: "1", title: "Add a CSV export", project: "Dash", createdAt: 1, updatedAt: 1,
    facts: { channel: "general", reasoning: "Jeremie asked", prompt: "Add a CSV export to invoices" }, url: null,
    ref: { source: "proposal", taskId: id, macFix: false },
  }
}

function bodyItem(id = "zettlab:systemd-service:kb-api", host = "zettlab"): SourceItem {
  return {
    source: "body", refId: id, version: "inv-2", title: `${id} is dead`, project: "Body", createdAt: 1, updatedAt: 1,
    facts: { problem: "dead", error: "timed out", host }, url: null, ref: { source: "body", componentId: id, investigationId: "inv-2" },
  }
}

function trip(): SourceItem {
  return {
    source: "trip", refId: "trip-1", version: "1", title: "Trip", project: "Travel log", createdAt: 1, updatedAt: 1, facts: {}, url: null,
    ref: { source: "trip", tripId: "trip-1", guess: "business", clientSlug: null, clientName: null, altSlug: null, altName: null },
  }
}

function output(over: Partial<ResolverOutput> = {}): ResolverOutput {
  return {
    analysis: "The repo's invoice module only handles CAD (src/invoice.ts:12).", summary: "Answer CAD: the code and STATE.md say so.",
    confidence: 0.92, needsJeremie: false, why: "none", category: "", action: { kind: "none" }, review: null, card: null, ...over,
  }
}

const normal: PolicyCtx = { autonomy: "normal", instruction: null, sensitive: false, rescuedBefore: false }

describe("config + kill switch", () => {
  test("defaults: on, opus 5.5, 2 concurrent, 20 a day, 20 min", () => {
    const c = resolverConfig({ HOME: "/h" }, () => false)
    expect(c).toMatchObject({ enabled: true, model: "claude-opus-5-5", maxConcurrent: 2, maxPerDay: 20, timeoutMs: 20 * 60_000, dryRun: false })
  })
  test("COMPANION_RESOLVER=0 or the flag file turn it off; the model is configurable", () => {
    expect(resolverConfig({ HOME: "/h", COMPANION_RESOLVER: "0" }, () => false).enabled).toBe(false)
    expect(resolverConfig({ HOME: "/h" }, (p) => p === "/h/.claude-companion/.resolver-disabled").enabled).toBe(false)
    expect(resolverConfig({ HOME: "/h", COMPANION_RESOLVER_MODEL: "claude-opus-4" }, () => false).model).toBe("claude-opus-4")
  })
})

describe("routing per source", () => {
  test("tasks, PRs, proposals and local Body items go to the resolver; trips never", () => {
    expect(routable(blockedTask())).toBe(true)
    expect(routable(parkedPr())).toBe(true)
    expect(routable(proposal())).toBe(true)
    expect(routable(bodyItem())).toBe(true)
    expect(routable(trip())).toBe(false)
  })
  test("a proposal Opus created itself is not resolved again; a Mac component on Zettlab is not routed", () => {
    expect(routable(proposal("mine"), { createdByResolver: (id) => id === "mine" })).toBe(false)
    expect(routable(bodyItem(), { bodyLocal: () => false })).toBe(false)
  })
  test("the resolver key ignores updated_at churn on a still-blocked task, and moves with a new question", () => {
    const a = resolverKey(blockedTask("t1", "Q?", "blocked|10:00"))
    expect(resolverKey(blockedTask("t1", "Q?", "blocked|11:00"))).toBe(a)
    expect(resolverKey(blockedTask("t1", "Another Q?", "blocked|11:00"))).not.toBe(a)
    expect(resolverKey(parkedPr(7, "r", "41"))).toBe("41")
  })
})

describe("output parsing", () => {
  test("fenced JSON, a 0-100 confidence, and a disallowed action reads as none", () => {
    const raw = "Here:\n```json\n" + JSON.stringify({ analysis: "a", summary: "s", confidence: 85, needsJeremie: false, why: "none", action: { kind: "merge" } }) + "\n```"
    const out = parseResolverOutput(raw, blockedTask())!
    expect(out.confidence).toBe(0.85)
    expect(out.action).toEqual({ kind: "none" })
  })
  test("needsJeremie defaults to true; garbage → null", () => {
    expect(parseResolverOutput(JSON.stringify({ analysis: "a", action: { kind: "answer", text: "CAD" } }), blockedTask())!.needsJeremie).toBe(true)
    expect(parseResolverOutput("no json here", blockedTask())).toBeNull()
  })
})

describe("policy: confident answer vs card", () => {
  const answer = { kind: "answer" as const, text: "Use CAD; the invoice module only supports CAD." }
  test("confident, evidence-backed answer → answered by Opus", () => {
    const plan = decide(blockedTask(), output({ action: answer }), normal)
    expect(plan).toMatchObject({ kind: "act", then: "resolved", action: answer })
  })
  test("below the bar, a preference, money or client wording → card", () => {
    expect(decide(blockedTask(), output({ action: answer, confidence: CONFIDENT - 0.01 }), normal).kind).toBe("card")
    expect(decide(blockedTask(), output({ action: answer, needsJeremie: true, why: "preference" }), normal).kind).toBe("card")
    expect(decide(blockedTask(), output({ action: answer, needsJeremie: false, why: "money" }), normal).kind).toBe("card")
  })
  test("an item that came back after Opus handled it → card only", () => {
    expect(decide(blockedTask(), output({ action: answer }), { ...normal, repeat: true })).toMatchObject({ kind: "card", reason: "came back after Opus handled it once" })
  })
  test("never cancels or approves on its own", () => {
    expect(decide(blockedTask(), output({ action: { kind: "cancel" } }), normal).kind).toBe("card")
    expect(decide(proposal(), output({ action: { kind: "approve" } }), normal).kind).toBe("card")
  })
})

describe("policy: PRs", () => {
  const sensitive: PolicyCtx = { ...normal, sensitive: true }
  test("a sensitive PR is never merged without ask_opus consent", () => {
    const out = output({ action: { kind: "merge" }, category: "safe", confidence: 1 })
    expect(decide(parkedPr(), out, sensitive).kind).toBe("card")
    expect(decide(parkedPr(), out, { ...sensitive, autonomy: "elevated", instruction: "make it smaller" }).kind).toBe("card")
    expect(decide(parkedPr(), out, { ...sensitive, autonomy: "elevated", instruction: null }).kind).toBe("card")
    expect(decide(parkedPr(), out, { ...sensitive, autonomy: "elevated", instruction: "do it" })).toMatchObject({ kind: "act", action: { kind: "merge" } })
    expect(decide(parkedPr(), out, { ...sensitive, autonomy: "elevated", instruction: "vas-y merge-le" }).kind).toBe("act")
  })
  test("non-sensitive merges also stay with Jeremie / the shepherd", () => {
    expect(decide(parkedPr(), output({ action: { kind: "merge" }, confidence: 1 }), normal).kind).toBe("card")
  })
  test("sensitive + problems → a fix run, then still a card; no problems → no fix", () => {
    const review = { whatChanged: "auth middleware", risk: "session bypass", prodFailure: "logged-out users", testsCover: "no", problems: ["missing expiry check"], verdict: "changes" as const }
    const fix = { kind: "fix" as const, instructions: "Add the expiry check" }
    expect(decide(parkedPr(), output({ action: fix, review }), sensitive)).toMatchObject({ kind: "act", then: "card" })
    expect(decide(parkedPr(), output({ action: fix, review: { ...review, problems: [] } }), sensitive).kind).toBe("card")
  })
  test("stale / superseded / task done close themselves; ambiguous or sensitive does not", () => {
    for (const category of ["stale", "superseded", "task_done"]) {
      expect(decide(parkedPr(), output({ action: { kind: "close_pr", reason: category }, category }), normal)).toMatchObject({ kind: "act", then: "resolved", reason: category })
    }
    expect(decide(parkedPr(), output({ action: { kind: "close_pr", reason: "?" }, category: "ambiguous" }), normal).kind).toBe("card")
    expect(decide(parkedPr(), output({ action: { kind: "close_pr", reason: "stale" }, category: "stale" }), sensitive).kind).toBe("card")
  })
  test("one rescue per PR: fix + hand back to the shepherd, then never again", () => {
    const fix = output({ action: { kind: "fix", instructions: "Mock the clock in the flaky test" }, category: "ci_failing" })
    expect(decide(parkedPr(), fix, normal)).toMatchObject({ kind: "act", then: "unpark" })
    expect(decide(parkedPr(), fix, { ...normal, rescuedBefore: true }).kind).toBe("card")
  })
})

describe("policy: proposals", () => {
  test("duplicates and stale ones are rejected with the reason; a rescope needs Jeremie unless he asked", () => {
    expect(decide(proposal(), output({ action: { kind: "reject", reason: "duplicate of [p0]" }, category: "duplicate" }), normal)).toMatchObject({ kind: "act", action: { reason: "duplicate of [p0]" } })
    expect(decide(proposal(), output({ action: { kind: "reject", reason: "meh" }, category: "needed" }), normal).kind).toBe("card")
    const revise = output({ action: { kind: "revise", title: "Smaller", prompt: "Only the CSV button" } })
    expect(decide(proposal(), revise, normal).kind).toBe("card")
    expect(decide(proposal(), revise, { ...normal, autonomy: "elevated", instruction: "make it smaller" })).toMatchObject({ kind: "act", then: "resolved" })
  })
})

describe("the prepared card", () => {
  test("a blocked task: Opus's best answer is the recommended option, context = its analysis", () => {
    const out = output({ action: { kind: "answer", text: "Use CAD" }, needsJeremie: true, why: "client_wording" })
    const p = preparedPhrase(blockedTask(), out, { sensitive: false })
    expect(p.options[0]!.action).toEqual({ kind: "answer", text: "Use CAD" })
    expect(p.recommended).toBe("a")
    expect(p.context).toContain("src/invoice.ts:12")
  })
  test("a sensitive PR reviewed safe: Merge recommended, summary 'Opus reviewed: …'", () => {
    const review = { whatChanged: "token refresh", risk: "low", prodFailure: "none seen", testsCover: "yes, auth.test.ts", problems: [], verdict: "safe" as const }
    const out = output({ review, summary: "safe to merge because the refresh path is covered", card: {
      title: "Merge the token refresh fix", problem: "It touches auth.", action: "Merge it.",
      options: [{ label: "Close it", action: { kind: "close_pr" } }, { label: "Merge", action: { kind: "merge" } }],
    } })
    const p = preparedPhrase(parkedPr(), out, { sensitive: true })
    expect(p.options[0]!.action.kind).toBe("merge")
    expect(p.context).toContain("Tests: yes, auth.test.ts")
    expect(cardSummary(parkedPr(), out, true)).toBe("Opus reviewed: safe to merge because the refresh path is covered")
  })
  test("problems found: 'Ask for changes' (ask_opus with the specifics) first, Merge still offered", () => {
    const review = { whatChanged: "x", risk: "y", prodFailure: "z", testsCover: "no", problems: ["no expiry check"], verdict: "changes" as const }
    const p = preparedPhrase(parkedPr(), output({ review }), { sensitive: true })
    expect(p.options[0]!.action).toEqual({ kind: "ask_opus", instruction: "Fix on the PR branch: no expiry check" })
    expect(p.options.some((o) => o.action.kind === "merge")).toBe(true)
  })
  test("consent words", () => {
    expect(consents("do it")).toBe(true)
    expect(consents("fais-le")).toBe(true)
    expect(consents("just fix it")).toBe(false)
    expect(consents(null)).toBe(false)
  })
  test("isSensitivePr: paths or the shepherd's 'touches' reason", () => {
    expect(isSensitivePr(["server/lib/auth.ts"], "")).toBe(true)
    expect(isSensitivePr(["README.md"], "touches .github/workflows/ci.yml — needs your review")).toBe(true)
    expect(isSensitivePr(["README.md"], "stale (no activity for 15 days)")).toBe(false)
  })
})

describe("digest", () => {
  test("Opus handled N items today: answered X, closed Y, prepared Z for you", () => {
    expect(digestText({ answer: 2, close_pr: 1, reject: 1, prepared: 3 })).toBe("🤖 Opus handled 7 items today: answered 2, closed 2, prepared 3 for you.")
    expect(digestText({ answer: 1, fix: 1, failed: 2 })).toBe("🤖 Opus handled 2 items today: answered 1, closed 0, prepared 0 for you, fixed 1 PR (2 fell through to you).")
    expect(digestText({ failed: 1 })).toBeNull()
  })
})
