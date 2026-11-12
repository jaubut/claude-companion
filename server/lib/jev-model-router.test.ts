import { describe, expect, test } from "bun:test"
import type { JevOutcome } from "./jev"
import {
  decideBrainTurnModel,
  decideWorkerModel,
  pickBrainTurnModelFromOutcome,
  pickWorkerModelFromOutcome,
} from "./jev-model-router"

function workerJev(
  scope: "single_spot" | "focused_feature" | "cross_module",
  scopeProb: number,
  secNoul: number,
  moneyNoul: number,
): JevOutcome {
  return {
    ok: true,
    model: "jev-latest",
    latencyMs: 165,
    answers: {
      scope: {
        type: "choice",
        choice: scope,
        probabilities: { [scope]: scopeProb },
        confidence: scopeProb,
      },
      security_or_auth: { type: "noul", noul: secNoul },
      money_or_data_integrity: { type: "noul", noul: moneyNoul },
    },
  }
}

function brainJev(deepPlanning: number, routineMergeOrAck: number): JevOutcome {
  return {
    ok: true,
    model: "jev-latest",
    latencyMs: 140,
    answers: {
      needs_deep_planning: { type: "noul", noul: deepPlanning },
      is_routine_merge_or_ack: { type: "noul", noul: routineMergeOrAck },
    },
  }
}

describe("Jev worker model router", () => {
  test("routes single_spot and focused_feature tasks to claude-sonnet-5-5", () => {
    const single = pickWorkerModelFromOutcome(workerJev("single_spot", 0.92, 0.05, 0.02), {
      repo: "tls-dashboard-v2",
      title: "Fix invoice badge color",
      prompt: "Change badge text in InvoiceRow.vue from gray to emerald.",
    })
    expect(single).toMatchObject({
      model: "claude-sonnet-5-5",
      reason: "single_spot",
      source: "jev",
    })

    const focused = pickWorkerModelFromOutcome(workerJev("focused_feature", 0.84, 0.12, 0.08), {
      repo: "tls-dashboard-v2",
      title: "Add date filter to trips page",
      prompt: "Add a 30-day filter dropdown to TripsView.vue and update TripsView.test.ts.",
    })
    expect(focused).toMatchObject({
      model: "claude-sonnet-5-5",
      reason: "focused_feature",
      source: "jev",
    })
  })

  test("escalates security_or_auth, money_or_data_integrity, and cross_module tasks to claude-opus-5-5", () => {
    const sec = pickWorkerModelFromOutcome(workerJev("focused_feature", 0.8, 0.88, 0.1), {
      repo: "claude-companion",
      title: "Harden bwrap sandbox rules",
      prompt: "Update leadSettings in brain-lead.ts to block unsandboxed token reads.",
    })
    expect(sec).toMatchObject({
      model: "claude-opus-5-5",
      reason: "security_or_auth",
      source: "jev",
    })

    const money = pickWorkerModelFromOutcome(workerJev("focused_feature", 0.78, 0.1, 0.91), {
      repo: "tls-dashboard-v2",
      title: "Reconcile Q3 GST/QST ledger entries",
      prompt: "Fix tax rounding on multi-invoice Stripe payouts and add a migration.",
    })
    expect(money).toMatchObject({
      model: "claude-opus-5-5",
      reason: "money_or_data_integrity",
      source: "jev",
    })

    const cross = pickWorkerModelFromOutcome(workerJev("cross_module", 0.76, 0.15, 0.1), {
      repo: "claude-companion",
      title: "Refactor WebSocket session sync across server and iOS",
      prompt: "Update server/wiring/orchestrator.ts, server/lib/sessions.ts, and CompanionClient.swift.",
    })
    expect(cross).toMatchObject({
      model: "claude-opus-5-5",
      reason: "cross_module",
      source: "jev",
    })
  })

  test("escalates turn 3+ retries to claude-opus-5-5 and preserves explicit or turn-2 models without calling Jev", async () => {
    let called = 0
    const mockFetch = (async () => {
      called++
      return new Response("{}", { status: 500 })
    }) as unknown as typeof fetch

    const explicit = await decideWorkerModel(
      { repo: "r", title: "t", prompt: "p", explicitModel: "claude-opus-5-5" },
      { enabled: true, jev: { key: "k", fetch: mockFetch } },
    )
    expect(explicit).toEqual({ model: "claude-opus-5-5", reason: "explicit", source: "code", jevMs: 0 })

    const keepTurn2 = await decideWorkerModel(
      { repo: "r", title: "t", prompt: "p", turnCount: 2, existingModel: "claude-sonnet-5-5" },
      { enabled: true, jev: { key: "k", fetch: mockFetch } },
    )
    expect(keepTurn2).toEqual({ model: "claude-sonnet-5-5", reason: "session_keep", source: "code", jevMs: 0 })

    const retryTurn3 = await decideWorkerModel(
      { repo: "r", title: "t", prompt: "p", turnCount: 3, existingModel: "claude-sonnet-5-5" },
      { enabled: true, jev: { key: "k", fetch: mockFetch } },
    )
    expect(retryTurn3).toEqual({ model: "claude-opus-5-5", reason: "retry_escalation", source: "code", jevMs: 0 })
    expect(called).toBe(0)
  })

  test("falls back cleanly to claude-sonnet-5-5 when Jev is unreachable", () => {
    const out = pickWorkerModelFromOutcome({ ok: false, error: "timeout", latencyMs: 1200 }, {
      repo: "r",
      title: "t",
      prompt: "p",
    })
    expect(out).toEqual({ model: "claude-sonnet-5-5", reason: "fallback", source: "code", jevMs: 1200 })
  })
})

describe("Jev brain per-turn model router", () => {
  test("fast-paths [flush] and [rollover] control turns to claude-sonnet-5-5 in 0ms", async () => {
    const flush = await decideBrainTurnModel("[flush] Save memory to STATE.md before compact.", "claude-opus-5-5", { enabled: true })
    expect(flush).toEqual({ model: "claude-sonnet-5-5", reason: "control_turn", source: "code", jevMs: 0 })

    const rollover = await decideBrainTurnModel("[rollover] Summarize open work.", "auto", { enabled: true })
    expect(rollover).toEqual({ model: "claude-sonnet-5-5", reason: "control_turn", source: "code", jevMs: 0 })
  })

  test("honors pinned custom models like claude-fable-5-1 without calling Jev", async () => {
    const pinned = await decideBrainTurnModel("Design a new architecture", "claude-fable-5-1", { enabled: true })
    expect(pinned).toEqual({ model: "claude-fable-5-1", reason: "pinned_custom", source: "code", jevMs: 0 })
  })

  test("routes routine merge requests and short confirmations to claude-sonnet-5-5, and planning turns to claude-opus-5-5", () => {
    const mergeTurn = pickBrainTurnModelFromOutcome(brainJev(0.08, 0.94), "claude-opus-5-5")
    expect(mergeTurn).toEqual({
      model: "claude-sonnet-5-5",
      reason: "routine_turn",
      source: "jev",
      jevMs: 140,
    })

    const planTurn = pickBrainTurnModelFromOutcome(brainJev(0.89, 0.05), "claude-opus-5-5")
    expect(planTurn).toEqual({
      model: "claude-opus-5-5",
      reason: "planning_turn",
      source: "jev",
      jevMs: 140,
    })
  })
})
