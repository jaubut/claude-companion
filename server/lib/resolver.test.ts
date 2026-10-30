import { describe, expect, test } from "bun:test"
import {
  CONFIDENT, DELEGATED_MIN_CONFIDENCE, type PolicyCtx, REPO_YES_INSTRUCTION, type ResolverOutput, cardSummary, consentOf, consents, decide, digestText, isSensitivePr, outcomePhrase,
  parseResolverOutput, preparedPhrase, resolverConfig, resolverInfo, resolverKey, routable,
} from "./resolver"
import { ANSWER_TEXT_MAX, type SourceItem } from "./triage"

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

function mytask(): SourceItem {
  return {
    source: "mytask", refId: "t-1", version: "1", title: "Call the accountant", project: "Admin", createdAt: 1, updatedAt: 1, facts: {}, url: null,
    ref: { source: "mytask", taskIds: ["t-1"], noteId: "tasks/t-1", oldestDue: "2026-10-01", lateDays: 3 },
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
  test("defaults: on, opus 5.5, 2 concurrent, 60 a day, 20 min; COMPANION_RESOLVER_DAILY sets the budget", () => {
    const c = resolverConfig({ HOME: "/h" }, () => false)
    expect(c).toMatchObject({ enabled: true, model: "claude-opus-5-5", maxConcurrent: 2, maxPerDay: 60, timeoutMs: 20 * 60_000, dryRun: false })
    expect(resolverConfig({ HOME: "/h", COMPANION_RESOLVER_DAILY: "90" }, () => false).maxPerDay).toBe(90)
    expect(resolverConfig({ HOME: "/h", COMPANION_RESOLVER_MAX_PER_DAY: "30" }, () => false).maxPerDay).toBe(30)
  })
  test("COMPANION_RESOLVER=0 or the flag file turn it off; the model is configurable", () => {
    expect(resolverConfig({ HOME: "/h", COMPANION_RESOLVER: "0" }, () => false).enabled).toBe(false)
    expect(resolverConfig({ HOME: "/h" }, (p) => p === "/h/.claude-companion/.resolver-disabled").enabled).toBe(false)
    expect(resolverConfig({ HOME: "/h", COMPANION_RESOLVER_MODEL: "claude-opus-4" }, () => false).model).toBe("claude-opus-4")
  })
})

describe("routing per source", () => {
  test("tasks, PRs, proposals and local Body items go to the resolver; mytasks never", () => {
    expect(routable(blockedTask())).toBe(true)
    expect(routable(parkedPr())).toBe(true)
    expect(routable(proposal())).toBe(true)
    expect(routable(bodyItem())).toBe(true)
    expect(routable(mytask())).toBe(false)
  })
  test("a proposal Opus created itself is not resolved again; a Mac component on Zettlab is not routed", () => {
    expect(routable(proposal("mine"), { createdByResolver: (id) => id === "mine" })).toBe(false)
    expect(routable(bodyItem(), { bodyLocal: () => false })).toBe(false)
  })
  test("a proposal already handed off (brain filing it, or queued) is not a resolver item; a failed filing is", () => {
    expect(routable(proposal("brain1"), { handedOff: (id) => id === "brain1" })).toBe(false)
    expect(routable(proposal("brain2"), { handedOff: () => false })).toBe(true)
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
  test("an answer keeps its full text up to ANSWER_TEXT_MAX; above it the action reads as none, never sliced", () => {
    const long = `${"x".repeat(1996)} END`
    expect(parseResolverOutput(JSON.stringify({ analysis: "a", action: { kind: "answer", text: long } }), blockedTask())!.action).toEqual({ kind: "answer", text: long })
    const over = parseResolverOutput(JSON.stringify({ analysis: "a", action: { kind: "answer", text: "y".repeat(ANSWER_TEXT_MAX + 1) } }), blockedTask())!
    expect(over.action).toEqual({ kind: "none" })
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
  test("sensitive: a fix is Jeremie's card, never an Opus hand-back; his ask hands it back to the shepherd", () => {
    const review = { whatChanged: "auth middleware", risk: "session bypass", prodFailure: "logged-out users", testsCover: "no", problems: ["missing expiry check"], verdict: "changes" as const }
    const fix = { kind: "fix" as const, instructions: "Add the expiry check" }
    expect(decide(parkedPr(), output({ action: fix, review }), sensitive)).toMatchObject({ kind: "card", reason: "sensitive PR: Jeremie decides on the changes" })
    expect(decide(parkedPr(), output({ action: fix, review: { ...review, problems: [] } }), sensitive).kind).toBe("card")
    expect(decide(parkedPr(), output({ action: fix, review }), { ...sensitive, autonomy: "elevated", instruction: "Fix on the PR branch: missing expiry check" }))
      .toMatchObject({ kind: "act", then: "unpark" })
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
    expect(consents("just fix it")).toBe(true)
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
    expect(digestText({ answer: 1, fix: 1, failed: 2 })).toBe("🤖 Opus handled 2 items today: answered 1, closed 0, prepared 0 for you, handed 1 PR back for a fix (2 fell through to you).")
    expect(digestText({ failed: 1 })).toBeNull()
  })
})

describe("consent (ask_opus)", () => {
  test("EN / FR go words = explicit; a longer order = imperative; limits = prepare; nothing = none", () => {
    for (const w of ["Fix it", "fix it!", "do it", "just do it", "go", "go ahead", "handle it", "ok", "yes", "merge", "close", "cancel", "vas-y", "fais-le", "règle ça", "Oui, vas-y", "c'est bon, ferme-le"]) {
      expect([w, consentOf(w)]).toEqual([w, "explicit"])
    }
    expect(consentOf("Fix on the PR branch: why does paid get overwritten?")).toBe("imperative")
    expect(consentOf("fix the flaky test and merge when green")).toBe("imperative")
    for (const w of ["don't merge", "just look", "explain", "ne merge pas", "n'y touche pas", "why is it failing?", "juste regarder", "explique-moi"]) {
      expect([w, consentOf(w)]).toEqual([w, "prepare"])
    }
    expect(consentOf("make it smaller")).toBe("other")
    expect(consentOf(null)).toBe("none")
    expect(consentOf("  ")).toBe("none")
  })

  test("a long order needs Opus's consent flag too; the short ones do not", () => {
    expect(consents("Fix it")).toBe(true)
    expect(consents("fix the flaky test and merge when green")).toBe(false)
    expect(consents("fix the flaky test and merge when green", true)).toBe(true)
    expect(consents("don't merge", true)).toBe(false)
    expect(parseResolverOutput(JSON.stringify({ analysis: "a", summary: "s", consent: true }), blockedTask())?.consent).toBe(true)
    expect(parseResolverOutput(JSON.stringify({ analysis: "a", summary: "s" }), blockedTask())?.consent).toBe(false)
  })

  test("decide: 'Fix it' consents to cancel / close; 'don't merge' only prepares; no instruction keeps the one-tap rule", () => {
    const elevated = (instruction: string | null): PolicyCtx => ({ ...normal, autonomy: "elevated", instruction })
    const cancel = output({ action: { kind: "cancel" }, category: "already_done" })
    expect(decide(blockedTask(), cancel, elevated("Fix it"))).toMatchObject({ kind: "act", action: { kind: "cancel" } })
    expect(decide(blockedTask(), cancel, elevated("vas-y"))).toMatchObject({ kind: "act" })
    expect(decide(blockedTask(), cancel, elevated(null)).kind).toBe("card")
    expect(decide(blockedTask(), cancel, elevated("make it smaller")).kind).toBe("card")
    const merge = output({ action: { kind: "merge" }, category: "safe" })
    const sens: PolicyCtx = { ...elevated("don't merge"), sensitive: true }
    expect(decide(parkedPr(), merge, sens)).toMatchObject({ kind: "card", reason: "Jeremie asked Opus to look, not act" })
    expect(decide(parkedPr(), merge, { ...sens, instruction: "merge" })).toMatchObject({ kind: "act", action: { kind: "merge" } })
    expect(decide(parkedPr(), merge, { ...sens, instruction: "review it again and merge if it is fine" }).kind).toBe("card")
    expect(decide(parkedPr(), { ...merge, consent: true }, { ...sens, instruction: "review it again and merge if it is fine" }).kind).toBe("act")
    expect(decide(parkedPr(), output({ action: { kind: "close_pr", reason: "done" } }), elevated("just look")).kind).toBe("card")
    // No ask_opus at all: a sensitive merge / a cancel still wait for Jeremie.
    expect(decide(parkedPr(), merge, { ...normal, sensitive: true }).kind).toBe("card")
    expect(decide(blockedTask(), cancel, normal).kind).toBe("card")
  })
})

describe("outcome first", () => {
  const review = { whatChanged: "x", risk: "y", prodFailure: "z", testsCover: "no", problems: ["no expiry check"], verdict: "changes" as const }
  test("failed: headline first in problem, retry recommended, 'Ask for changes' gone; given up: Open the PR, no retry", () => {
    const base = preparedPhrase(parkedPr(), output({ review }), { sensitive: true })
    expect(base.options[0]!.label).toBe("Ask for changes")
    const f = outcomePhrase(parkedPr(), base, { outcome: "failed", headline: "Fix failed: no local checkout", retry: "Try the fix again on the PR branch: add expiry" })
    expect(f.problem.startsWith("Fix failed: no local checkout. ")).toBe(true)
    expect(f.options[0]!.label).toBe("Ask Opus to retry")
    expect(f.recommended).toBe(f.options[0]!.id)
    expect(f.options.some((o) => o.label === "Ask for changes")).toBe(false)
    const g = outcomePhrase(parkedPr(), base, { outcome: "failed", headline: "Opus tried twice: no local checkout", gaveUp: true })
    expect(g.options[0]!.action.kind).toBe("open_url")
    expect(g.options.some((o) => o.action.kind === "ask_opus")).toBe(false)
    expect(outcomePhrase(parkedPr(), base, { outcome: "planned", headline: "" })).toEqual(base)
  })
  test("resolverInfo carries outcome and queue position only when set", () => {
    expect(resolverInfo("prepared", "Fix pushed", "m", 1, { outcome: "done" })).toEqual({ status: "prepared", summary: "Fix pushed", model: "m", finishedAt: 1, outcome: "done" })
    expect(resolverInfo("queued", "Opus queued (3)", "m", null, { queuePosition: 3 })).toMatchObject({ status: "queued", queuePosition: 3 })
    expect(resolverInfo("resolving", "x", "m", null)).toEqual({ status: "resolving", summary: "x", model: "m", finishedAt: null })
  })
})

describe("policy: delegated (Jeremie's Yes on a repo card, 2026-10-15)", () => {
  const delegated: PolicyCtx = { autonomy: "delegated", instruction: REPO_YES_INSTRUCTION, sensitive: false, rescuedBefore: false }
  const answer = { kind: "answer" as const, text: "Use CAD; the invoice module only supports CAD." }

  test("an answer acts above 0.5 unless the why is money, client wording or irreversible", () => {
    expect(decide(blockedTask(), output({ action: answer, confidence: 0.6, needsJeremie: true, why: "preference" }), delegated)).toMatchObject({ kind: "act", then: "resolved" })
    expect(decide(blockedTask(), output({ action: answer, confidence: DELEGATED_MIN_CONFIDENCE - 0.01 }), delegated).kind).toBe("card")
    for (const why of ["money", "client_wording", "irreversible"]) {
      expect(decide(blockedTask(), output({ action: answer, confidence: 0.99, why }), delegated).kind).toBe("card")
    }
  })

  test("sits before the repeat check: an item that came back still acts on a Yes", () => {
    expect(decide(blockedTask(), output({ action: answer }), { ...delegated, repeat: true })).toMatchObject({ kind: "act" })
  })

  test("requeue and route act; cancel / merge / approve / revise / reject stay cards", () => {
    expect(decide(blockedTask(), output({ action: { kind: "requeue" }, confidence: 0.3 }), delegated).kind).toBe("act")
    expect(decide(blockedTask(), output({ action: { kind: "route", repo: "dash" }, confidence: 0.3 }), delegated).kind).toBe("act")
    expect(decide(blockedTask(), output({ action: { kind: "cancel" }, confidence: 1 }), delegated).kind).toBe("card")
    expect(decide(parkedPr(), output({ action: { kind: "merge" }, confidence: 1 }), delegated).kind).toBe("card")
    expect(decide(proposal(), output({ action: { kind: "approve" }, confidence: 1 }), delegated).kind).toBe("card")
    expect(decide(proposal(), output({ action: { kind: "revise", title: "x", prompt: "y" } }), delegated).kind).toBe("card")
    expect(decide(proposal(), output({ action: { kind: "reject", reason: "dup" }, category: "duplicate" }), delegated).kind).toBe("card")
  })

  test("fix → unpark on a non-sensitive PR (a Yes is a human hand-back: an earlier rescue does not block it); sensitive → card", () => {
    const fix = output({ action: { kind: "fix", instructions: "Mock the clock" }, category: "ci_failing" })
    expect(decide(parkedPr(), fix, delegated)).toMatchObject({ kind: "act", then: "unpark" })
    expect(decide(parkedPr(), fix, { ...delegated, rescuedBefore: true })).toMatchObject({ kind: "act", then: "unpark" })
    expect(decide(parkedPr(), fix, { ...delegated, sensitive: true }).kind).toBe("card")
  })

  test("close_pr as normal: sure + stale / superseded / task done + not sensitive", () => {
    const close = (category: string, confidence = 0.9) => output({ action: { kind: "close_pr", reason: category }, category, confidence })
    expect(decide(parkedPr(), close("superseded"), delegated)).toMatchObject({ kind: "act", then: "resolved" })
    expect(decide(parkedPr(), close("superseded", 0.6), delegated).kind).toBe("card")
    expect(decide(parkedPr(), close("ambiguous"), delegated).kind).toBe("card")
    expect(decide(parkedPr(), close("superseded"), { ...delegated, sensitive: true }).kind).toBe("card")
  })
})
