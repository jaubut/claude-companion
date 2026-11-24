import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  BODY_MAX_BYTES, type OutboundPayload, type OutboundProposal, type OutboundStore,
  canonicalJson, createOutboundStore, currentOutbound, executeOutbound, outboundSource, parseMessageId, payloadHash, produceOutbound,
} from "./outbound"
import { gmailArgv } from "../wiring/outbound"
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

describe("updateCc", () => {
  test("updates cc_json and payload_hash atomically when proposed at expectedHash; returns null on stale hash, invalid address, or policy refusal", () => {
    const { id, payloadHash: oldHash } = propose({ cc: ["a@example.com", "b@example.com"] })
    // Stale hash returns null
    expect(store.updateCc(id, ["a@example.com"], "wrong-hash", clock + 1)).toBeNull()
    // Invalid email address returns null
    expect(store.updateCc(id, ["not-an-email"], oldHash, clock + 1)).toBeNull()
    // Policy refusal (> 10 total recipients) returns null
    const tenCc = Array.from({ length: 10 }, (_, i) => `cc${i}@example.com`)
    expect(store.updateCc(id, tenCc, oldHash, clock + 1)).toBeNull()

    // Valid subset updates cc and payloadHash
    const updated = store.updateCc(id, ["b@example.com"], oldHash, clock + 5)
    expect(updated).not.toBeNull()
    expect(updated!.cc).toEqual(["b@example.com"])
    expect(updated!.payloadHash).not.toBe(oldHash)
    expect(updated!.updatedAt).toBe(clock + 5)
    expect(store.get(id)!.cc).toEqual(["b@example.com"])
    expect(store.get(id)!.payloadHash).toBe(updated!.payloadHash)

    // Old hash is now stale
    expect(store.updateCc(id, [], oldHash, clock + 10)).toBeNull()
  })
})

describe("parseMessageId", () => {
  test("JSON, gmail.py real `sent: <id> thread <tid> | to: ...` output, or an id line", () => {
    expect(parseMessageId("sent: 1a20ecd3c5eb013e thread 1a20ecd3c5eb013e | to: client@example.com | subject: Suivi\n")).toBe("1a20ecd3c5eb013e")
    expect(parseMessageId('{"id":"18c2f0a1b2c3d4e5","threadId":"x"}')).toBe("18c2f0a1b2c3d4e5")
    expect(parseMessageId("Sent.\nMessage ID: 18c2f0a1b2c3d4e5\n")).toBe("18c2f0a1b2c3d4e5")
    expect(parseMessageId("ok")).toBeNull()
  })
})

const GMAIL_PY_FALLBACK = `#!/usr/bin/env python3
import argparse, sys
def cmd_auth(a): pass
def cmd_search(a): pass
def cmd_read(a): pass
def cmd_draft(a): pass
def cmd_send(a): pass
def cmd_selftest(a): pass
def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    def acc(sp): sp.add_argument("--account", default="hello")
    s = sub.add_parser("auth"); acc(s); s.add_argument("--url"); s.set_defaults(fn=cmd_auth)
    s = sub.add_parser("search"); acc(s); s.add_argument("query"); s.add_argument("--max", type=int, default=20); s.set_defaults(fn=cmd_search)
    s = sub.add_parser("read"); acc(s); s.add_argument("id"); s.add_argument("--thread", action="store_true"); s.set_defaults(fn=cmd_read)
    for name, fn in (("draft", cmd_draft), ("send", cmd_send)):
        s = sub.add_parser(name); acc(s)
        s.add_argument("--to", required=True); s.add_argument("--cc"); s.add_argument("--subject", required=True)
        s.add_argument("--body-file")
        s.add_argument("--html-file")
        s.add_argument("--from", dest="sender")
        s.add_argument("--reply-to")
        s.add_argument("--attach", action="append")
        s.set_defaults(fn=fn)
    s = sub.add_parser("selftest"); s.set_defaults(fn=cmd_selftest)
    a = p.parse_args(); a.fn(a)
`

describe("gmailArgv", () => {
  test("formats comma-joined --to and --cc, maps inReplyTo to --reply-to, omits empty --cc and --body-stdin", () => {
    const full = gmailArgv({
      account: "hello",
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com", "d@example.com"],
      subject: "Facture Q4",
      body: "Bonjour",
      inReplyTo: "18f00aabbccdd123",
    })
    expect(full.slice(2)).toEqual([
      "send", "--account", "hello",
      "--to", "a@example.com, b@example.com",
      "--cc", "c@example.com, d@example.com",
      "--subject", "Facture Q4",
      "--reply-to", "18f00aabbccdd123",
    ])
    expect(full).not.toContain("--body-stdin")
    expect(full).not.toContain("--in-reply-to")

    const minimal = gmailArgv({
      account: "personal",
      to: ["solo@example.com"],
      cc: [],
      subject: "Quick note",
      body: "Salut",
      inReplyTo: null,
    })
    expect(minimal.slice(2)).toEqual([
      "send", "--account", "personal",
      "--to", "solo@example.com",
      "--subject", "Quick note",
    ])
    expect(minimal).not.toContain("--cc")
    expect(minimal).not.toContain("--reply-to")
    expect(minimal).not.toContain("--body-stdin")
  })

  test("parses cleanly against ~/.claude/tools/gmail.py real argparse parser without network access", async () => {
    const realPath = join(homedir(), ".claude", "tools", "gmail.py")
    let tempDir: string | null = null
    const prevEnv = process.env.COMPANION_GMAIL_PY
    if (!existsSync(realPath) && !prevEnv) {
      tempDir = mkdtempSync(join(tmpdir(), "cc-gmail-py-"))
      const fallbackPath = join(tempDir, "gmail.py")
      writeFileSync(fallbackPath, GMAIL_PY_FALLBACK)
      process.env.COMPANION_GMAIL_PY = fallbackPath
    }
    const harness = [
      "import importlib.util, json, sys",
      "script = sys.argv[1]",
      "sys.argv = sys.argv[1:]",
      "spec = importlib.util.spec_from_file_location('gmail_cli', script)",
      "mod = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "def forbid(*a, **k): raise RuntimeError('network/credential access forbidden')",
      "mod._http = forbid",
      "mod._account = forbid",
      "captured = {}",
      "def stub_send(ns): captured.update({k: v for k, v in vars(ns).items() if k != 'fn'})",
      "mod.cmd_send = stub_send",
      "mod.main()",
      "print(json.dumps(captured))",
    ].join("\n")

    async function parseWithGmailPy(payload: OutboundPayload): Promise<Record<string, unknown>> {
      const argv = gmailArgv(payload)
      const proc = Bun.spawn(["python3", "-c", harness, ...argv.slice(1)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      proc.stdin.write(payload.body)
      await proc.stdin.end()
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      if (code !== 0) throw new Error(`gmail.py argparse failed (${code}): ${stderr}`)
      return JSON.parse(stdout.trim()) as Record<string, unknown>
    }

    try {
      const fullParsed = await parseWithGmailPy({
        account: "hello",
        to: ["client1@example.com", "client2@example.com"],
        cc: ["ops@example.com", "accounting@example.com"],
        subject: "Q4 Statement",
        body: "Bonjour,\n\nVoici l'état de compte.",
        inReplyTo: "1a20ecd3c5eb013e",
      })
      expect(fullParsed).toMatchObject({
        cmd: "send",
        account: "hello",
        to: "client1@example.com, client2@example.com",
        cc: "ops@example.com, accounting@example.com",
        subject: "Q4 Statement",
        reply_to: "1a20ecd3c5eb013e",
        body_file: null,
      })

      const minimalParsed = await parseWithGmailPy({
        account: "personal",
        to: ["jeremie@example.com"],
        cc: [],
        subject: "Ping",
        body: "Body on stdin",
        inReplyTo: null,
      })
      expect(minimalParsed).toMatchObject({
        cmd: "send",
        account: "personal",
        to: "jeremie@example.com",
        cc: null,
        subject: "Ping",
        reply_to: null,
        body_file: null,
      })
    } finally {
      if (prevEnv === undefined) delete process.env.COMPANION_GMAIL_PY
      else process.env.COMPANION_GMAIL_PY = prevEnv
      if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
