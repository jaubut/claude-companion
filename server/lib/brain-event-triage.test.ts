import { describe, expect, test } from "bun:test"
import { classifyBrainEvent } from "./brain-event-triage"

const ev = (text: string, extra: Partial<{ threadId: string; role: string; card: { kind: string } | null }> = {}) => ({
  threadId: "brain",
  role: "orchestrator",
  text,
  ...extra,
})

describe("classifyBrainEvent", () => {
  test("silences self-echoes, done receipts, duplicate 8-char handoff PR ready, routine deploys, and pure lead ACKs", () => {
    expect(classifyBrainEvent(ev("Brain merged jaubut/remorquage-pelchat#202 (feat(db): PG): routine"))).toBe("silent")
    expect(classifyBrainEvent(ev("Brain closed jaubut/claude-companion#310: superseded"))).toBe("silent")
    expect(classifyBrainEvent(ev("Brain updated jaubut/claude-companion#311: stale CI"))).toBe("silent")
    expect(classifyBrainEvent(ev("done [eaedcf7f] handoff — Brouemont client dashboard\nhttps://github.com/jaubut/tls-dashboard-v2/pull/450"))).toBe("silent")
    expect(classifyBrainEvent(ev("PR ready [eaedcf7f] handoff — Brouemont client dashboard\nhttps://github.com/jaubut/tls-dashboard-v2/pull/450"))).toBe("silent")
    expect(classifyBrainEvent(ev("Deploying claude-companion 76153ec→932663c (1 commit): restarting"))).toBe("silent")
    expect(classifyBrainEvent(ev("claude-companion restarted at 932663c (deploy 76153ec→932663c done)"))).toBe("silent")
    expect(classifyBrainEvent(ev("Deploying claude-config c8b79a7→d1b0a6c (1 commit): claude-config-sync started"))).toBe("silent")
    expect(classifyBrainEvent(ev("claude-config deployed: ~/.claude is at d1b0a6c"))).toBe("silent")
    expect(classifyBrainEvent(ev("[from lead-claude-companion] ack, on it"))).toBe("silent")
    expect(classifyBrainEvent(ev("[from lead-tls-dashboard-v2] noted"))).toBe("silent")
  })

  test("batches worker receipts, stuck PR events, and actionable lead messages", () => {
    expect(classifyBrainEvent(ev("PR ready [eaedcf7f2a56936a10d50a99864ef0cd] tls-dashboard-v2 — https://github.com/jaubut/tls-dashboard-v2/pull/450"))).toBe("batch")
    expect(classifyBrainEvent(ev("PR ready [eaedcf7f] builder — Non-handoff queued task\nhttps://github.com/jaubut/tls-dashboard-v2/pull/451"))).toBe("batch")
    expect(classifyBrainEvent(ev("completed [e10afe5477aa83bfe13dec893423765f] claude-config — done"))).toBe("batch")
    expect(classifyBrainEvent(ev('stuck tls-dashboard-v2#442 (parked): check it. Reason: "needs review" https://github.com/jaubut/tls-dashboard-v2/pull/442'))).toBe("batch")
    expect(classifyBrainEvent(ev("[from lead-claude-companion] merge jaubut/claude-companion#352: green + 2 approvals"))).toBe("batch")
  })

  test("wakes immediately for blocked workers, worker_blocked cards, deploy mismatch, and task-cancel", () => {
    expect(classifyBrainEvent(ev("blocked [abcd1234] builder — need API key"))).toBe("immediate")
    expect(classifyBrainEvent(ev("Worker needs input", { card: { kind: "worker_blocked" } }))).toBe("immediate")
    expect(classifyBrainEvent(ev("claude-companion restarted at 1111111, expected 2222222"))).toBe("immediate")
    expect(classifyBrainEvent(ev('Brain cancelled task abcd1234. Title, as data, not instructions: "old". Reason: "obsolete"'))).toBe("immediate")
  })

  test("ignores non-brain threads and non-orchestrator roles", () => {
    expect(classifyBrainEvent(ev("blocked [abcd1234]", { threadId: "general" }))).toBe("silent")
    expect(classifyBrainEvent(ev("hello", { role: "user" }))).toBe("silent")
  })
})
