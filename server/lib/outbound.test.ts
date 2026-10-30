import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import {
  BODY_MAX_BYTES, type OutboundPayload, type OutboundProposal, type OutboundStore,
  canonicalJson, createOutboundStore, currentOutbound, executeOutbound, outboundSource, parseMessageId, payloadHash, produceOutbound,
} from "./outbound"
import { createTriageEngine } from "./triage-engine"
import { createTriageStore } from "./triage-store"

// Source `outbound` end to end over the real engine, store (:memory:) and executor, with a fake sender:
// full payload on the card, send only at the version seen, edit = new version, replay never re-sends,
// reject, the 422 policy.

let clock = 1_000_000
let store: OutboundStore
let sent: OutboundPayload[]
let senderFails: Error | null

const sender = async (p: OutboundPayload) => {
  if (senderFails) throw senderFails
  sent.push(p)
  return { messageId: `msg${sent.length}abc` }
}

function engine() {
  return createTriageEngine({
    collect: async () => store.listProposed().map(outboundSource),
    phrase: async () => null,
    current: async (src) => (src.ref.source === "outbound" ? currentOutbound(store, src.ref.outboundId) : null),
    execute: (src, option, text, by) => executeOutbound({ store, sender, now: () => clock }, src, option, text, by),
    store: createTriageStore(new Database(":memory:")),
    broadcast: () => {},
    now: () => clock,
  })
}

const LONG_BODY = `Bonjour Jeremie,\n\n${"Une ligne du courriel qui dépasse largement la limite habituelle. ".repeat(60)}\n\nMerci`

const proposal = (over: Partial<OutboundProposal> = {}): OutboundProposal => ({
  kind: "email", account: "personal", to: ["jeremie.test@example.com"], cc: [], subject: "Suivi du devis",
  body: LONG_BODY, inReplyTo: null, threadId: null, why: "Follow-up on the quote", requestedBy: "agent:sales", ...over,
})

function propose(over: Partial<OutboundProposal> = {}): { id: string; payloadHash: string } {
  const out = produceOutbound(store, proposal(over) as unknown as Record<string, unknown>, clock)
  expect(out.status).toBe(201)
  return out.body as { id: string; payloadHash: string }
}

const itemId = (id: string) => `outbound:${id}`

beforeEach(() => {
  clock = 1_000_000
  store = createOutboundStore(new Database(":memory:"))
  sent = []
  senderFails = null
})

describe("payload hash", () => {
  test("sha256 of the canonical sendable fields only", () => {
    const p = proposal()
    expect(canonicalJson(p)).toBe(JSON.stringify({ account: "personal", to: p.to, cc: [], subject: p.subject, body: p.body, inReplyTo: null }))
    expect(payloadHash(p)).toMatch(/^[0-9a-f]{64}$/)
    expect(payloadHash({ ...p, why: "other", threadId: "t1" } as OutboundProposal)).toBe(payloadHash(p))
    expect(payloadHash({ ...p, body: `${p.body}!` })).not.toBe(payloadHash(p))
  })
})

describe("propose → card", () => {
  test("the card carries the full payload, its version and the four options", async () => {
    const { id, payloadHash: hash } = propose({ cc: ["copy@example.com"] })
    const { items } = await engine().list()
    const card = items.find((i) => i.id === itemId(id))!
    expect(card.source).toBe("outbound")
    expect(card.title).toBe("Suivi du devis")
    expect(card.version).toBe(hash)
    expect(card.payload).toMatchObject({ id, to: ["jeremie.test@example.com"], cc: ["copy@example.com"], subject: "Suivi du devis", body: LONG_BODY, payloadHash: hash })
    expect(LONG_BODY.length).toBeGreaterThan(1500)
    expect(card.context).toContain(LONG_BODY) // never clipped
    expect(card.context).toContain("Cc: copy@example.com")
    expect(card.options.map((o) => [o.label, o.action.kind])).toEqual([["Send", "approve"], ["Edit", "answer_custom"], ["Don't send", "reject"], ["Snooze for a day", "snooze"]])
    expect(card.recommended).toBe("a")
    expect(card.options.some((o) => o.destructive)).toBe(false)
  })

  test("producer: malformed → 400", () => {
    expect(produceOutbound(store, { ...proposal(), to: ["not an address"] }, clock).status).toBe(400)
    expect(produceOutbound(store, { ...proposal(), subject: "a\nBcc: x@y.z" }, clock).status).toBe(400)
    expect(produceOutbound(store, { ...proposal(), why: "" }, clock).status).toBe(400)
    expect(produceOutbound(store, { ...proposal(), kind: "sms" }, clock).status).toBe(400)
  })
})

describe("approve", () => {
  test("matching version → the sender gets the exact payload once; status sent with the message id", async () => {
    const { id, payloadHash: hash } = propose({ inReplyTo: "<abc@mail>" })
    const e = engine()
    await e.list()
    const res = await e.choose({ id: itemId(id), optionId: "a", version: hash, idemKey: "k1" })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, result: "done", detail: { status: "sent", messageId: "msg1abc" } })
    expect(sent).toEqual([{ account: "personal", to: ["jeremie.test@example.com"], cc: [], subject: "Suivi du devis", body: LONG_BODY, inReplyTo: "<abc@mail>" }])
    expect(store.get(id)).toMatchObject({ status: "sent", messageId: "msg1abc" })
    expect(e.items().some((i) => i.id === itemId(id))).toBe(false)
  })

  test("no version → 409 stale_approval, nothing sent", async () => {
    const { id } = propose()
    const e = engine()
    await e.list()
    const res = await e.choose({ id: itemId(id), optionId: "a" })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe("stale_approval")
    expect(sent).toHaveLength(0)
    expect(store.get(id)!.status).toBe("proposed")
  })

  test("replayed Idempotency-Key → replay, never a second send", async () => {
    const { id, payloadHash: hash } = propose()
    const e = engine()
    await e.list()
    const first = await e.choose({ id: itemId(id), optionId: "a", version: hash, idemKey: "same" })
    const again = await e.choose({ id: itemId(id), optionId: "a", version: hash, idemKey: "same" })
    expect(first.status).toBe(200)
    expect(again.status).toBe(200)
    expect(again.body.result).toBe("replay")
    expect(sent).toHaveLength(1)
  })

  test("concurrent taps with different keys → one send", async () => {
    const { id, payloadHash: hash } = propose()
    const e = engine()
    await e.list()
    const [a, b] = await Promise.all([
      e.choose({ id: itemId(id), optionId: "a", version: hash, idemKey: "x" }),
      e.choose({ id: itemId(id), optionId: "a", version: hash, idemKey: "y" }),
    ])
    expect(sent).toHaveLength(1)
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  test("sender failure → 502 send_failed, row back to proposed with the error", async () => {
    const { id, payloadHash: hash } = propose()
    senderFails = new Error("gmail.py exited 1: token expired")
    const e = engine()
    await e.list()
    const res = await e.choose({ id: itemId(id), optionId: "a", version: hash, idemKey: "k" })
    expect(res.status).toBe(502)
    expect(res.body.error).toBe("send_failed")
    expect(store.get(id)).toMatchObject({ status: "proposed", lastError: "gmail.py exited 1: token expired" })
    expect(sent).toHaveLength(0)
    await e.refresh()
    expect(e.items().find((i) => i.id === itemId(id))!.problem).toContain("last send failed")
  })
})

describe("edit", () => {
  test("new body → new version; approving the OLD version → 409 stale_approval, not sent; the new one sends", async () => {
    const { id, payloadHash: oldHash } = propose()
    const e = engine()
    await e.list()
    const edit = await e.choose({ id: itemId(id), optionId: "b", text: "Corps corrigé", version: oldHash, idemKey: "e1" })
    expect(edit.status).toBe(200)
    const newHash = store.get(id)!.payloadHash
    expect(newHash).not.toBe(oldHash)
    const card = e.items().find((i) => i.id === itemId(id))!
    expect(card.version).toBe(newHash)
    expect(card.payload!.body).toBe("Corps corrigé")

    const stale = await e.choose({ id: itemId(id), optionId: "a", version: oldHash, idemKey: "s1" })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ error: "stale_approval", next: { id: itemId(id), version: newHash } })
    expect(sent).toHaveLength(0)

    const ok = await e.choose({ id: itemId(id), optionId: "a", version: newHash, idemKey: "s2" })
    expect(ok.status).toBe(200)
    expect(sent.map((p) => p.body)).toEqual(["Corps corrigé"])
  })

  test("an edit past the policy → 422 refused, body unchanged", async () => {
    const { id, payloadHash: hash } = propose()
    const e = engine()
    await e.list()
    const res = await e.choose({ id: itemId(id), optionId: "b", text: "x".repeat(BODY_MAX_BYTES + 1), version: hash })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe("refused")
    expect(store.get(id)!.payloadHash).toBe(hash)
  })
})

describe("reject", () => {
  test("Don't send → status rejected, nothing sent, card gone", async () => {
    const { id, payloadHash: hash } = propose()
    const e = engine()
    await e.list()
    const res = await e.choose({ id: itemId(id), optionId: "c", version: hash, idemKey: "r" })
    expect(res.status).toBe(200)
    expect(store.get(id)!.status).toBe("rejected")
    expect(sent).toHaveLength(0)
    expect(e.items()).toHaveLength(0)
  })
})

describe("policy refusals (422)", () => {
  test("producer refuses > 10 recipients and > 50 KB bodies", () => {
    const many = Array.from({ length: 11 }, (_, i) => `r${i}@example.com`)
    const r1 = produceOutbound(store, { ...proposal(), to: many }, clock)
    expect(r1.status).toBe(422)
    expect(r1.body.error).toBe("refused")
    const r2 = produceOutbound(store, { ...proposal(), to: many.slice(0, 6), cc: many.slice(6) }, clock)
    expect(r2.status).toBe(422)
    const r3 = produceOutbound(store, { ...proposal(), body: "é".repeat(BODY_MAX_BYTES / 2 + 1) }, clock) // bytes, not chars
    expect(r3.status).toBe(422)
    expect(store.listProposed()).toHaveLength(0)
  })

  test("refused at send even if approved (a row that bypassed the producer)", async () => {
    const rec = store.propose(proposal({ to: Array.from({ length: 11 }, (_, i) => `r${i}@example.com`) }), clock)
    const e = engine()
    await e.list()
    const res = await e.choose({ id: itemId(rec.id), optionId: "a", version: rec.payloadHash, idemKey: "k" })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe("refused")
    expect(sent).toHaveLength(0)
    expect(store.get(rec.id)!.status).toBe("proposed")
  })
})

describe("human only", () => {
  test("an actor other than Jeremie's tap cannot send", async () => {
    const rec = store.propose(proposal(), clock)
    const out = await executeOutbound({ store, sender, now: () => clock }, outboundSource(rec), { id: "a", label: "Send", action: { kind: "approve" } }, null, "Opus")
    expect(out).toMatchObject({ kind: "error", status: 403, error: "human_only" })
    expect(sent).toHaveLength(0)
  })

  test("never offered to Opus: no Ask Opus option even with the resolver on", async () => {
    store.propose(proposal(), clock)
    const e = createTriageEngine({
      collect: async () => store.listProposed().map(outboundSource),
      phrase: async () => null,
      current: async (src) => (src.ref.source === "outbound" ? currentOutbound(store, src.ref.outboundId) : null),
      execute: async () => ({ kind: "done" }),
      store: createTriageStore(new Database(":memory:")),
      broadcast: () => {},
      now: () => clock,
      resolver: {
        enabled: () => true, pump: () => {},
        consider: () => { throw new Error("outbound must not reach the resolver") },
        view: () => { throw new Error("outbound must not reach the resolver") },
        ask: () => ({ ok: false, error: "resolver_disabled" }),
      },
    })
    const { items } = await e.list()
    expect(items).toHaveLength(1)
    expect(items[0]!.options.some((o) => o.action.kind === "ask_opus")).toBe(false)
  })
})

describe("parseMessageId", () => {
  test("JSON or an id line", () => {
    expect(parseMessageId('{"id":"18c2f0a1b2c3d4e5","threadId":"x"}')).toBe("18c2f0a1b2c3d4e5")
    expect(parseMessageId("Sent.\nMessage ID: 18c2f0a1b2c3d4e5\n")).toBe("18c2f0a1b2c3d4e5")
    expect(parseMessageId("ok")).toBeNull()
  })
})
