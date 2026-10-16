import { beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SourceItem, TriageOption } from "../lib/triage"
import { type ExecOutcome, type TriageResolverHook, createTriageEngine } from "../lib/triage-engine"
import { createTriageStore } from "../lib/triage-store"
import type { runPeerTakeover } from "../wiring/takeover"

// The takeover option through the triage engine (render + choose + replay) and
// the peer endpoint's validation. The run itself is wiring/takeover.test.ts.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-triage-takeover-")), "test.db")
let routes: typeof import("./triage")
beforeAll(async () => { routes = await import("./triage") })

const ID = "a".repeat(32)
const blocked: SourceItem = {
  source: "task", refId: ID, version: "blocked|2026-10-16 10:00:00", title: "Fix the companion poller", project: "Companion", createdAt: 1, updatedAt: 1,
  facts: { status: "blocked", agent: "builder", blocker: "No local repo mapped" }, url: null,
  ref: { source: "task", taskId: ID, status: "blocked", channel: "general" },
  takeover: { repo: "claude-companion", host: "zettlab", pinned: false, candidates: [] },
}

const resolverOn: TriageResolverHook = {
  enabled: () => true, pump: () => {}, consider: () => {}, view: () => null, ask: () => ({ ok: true, runId: 1 }),
}

function engine(resolver: TriageResolverHook | null, execute: (src: SourceItem, o: TriageOption, text: string | null) => Promise<ExecOutcome>) {
  return createTriageEngine({
    collect: async () => [blocked], phrase: async () => null, current: async (s) => s, execute,
    store: createTriageStore(new Database(":memory:")), broadcast: () => {}, resolver,
  })
}

describe("takeover option on the card", () => {
  test("present with the resolver off; with it on, Opus stays last; never the recommendation", async () => {
    const off = engine(null, async () => ({ kind: "done" }))
    await off.refresh()
    const a = off.items()[0]!
    expect(a.options.at(-1)).toMatchObject({ id: "takeover", action: { kind: "takeover", repo: "claude-companion", host: "zettlab" } })
    expect(a.recommended).not.toBe("takeover")
    const on = engine(resolverOn, async () => ({ kind: "done" }))
    await on.refresh()
    expect(on.items()[0]!.options.slice(-2).map((o) => o.id)).toEqual(["takeover", "opus"])
  })

  test("choose → the executor gets the collected src (its target); a retry with the same key → replay, executed once", async () => {
    const seen: { src: SourceItem; text: string | null }[] = []
    const e = engine(null, async (src, _o, text) => {
      seen.push({ src, text })
      return { kind: "done", detail: { host: "zettlab", session: "tko-zettlab-aaaaaaaa", status: "starting" } }
    })
    await e.refresh()
    const first = await e.choose({ id: `task:${ID}`, optionId: "takeover", idemKey: "k1" })
    expect(first).toMatchObject({ status: 200, body: { ok: true, result: "done", detail: { session: "tko-zettlab-aaaaaaaa", status: "starting" } } })
    expect(seen[0]!.src.takeover).toEqual(blocked.takeover)
    const again = await e.choose({ id: `task:${ID}`, optionId: "takeover", idemKey: "k1" })
    expect(again).toMatchObject({ status: 200, body: { result: "replay", detail: { session: "tko-zettlab-aaaaaaaa" } } })
    expect(seen).toHaveLength(1)
  })

  test("executor refusals pass through: 422 repo_required {candidates}, 409 herdr_unavailable", async () => {
    let out: ExecOutcome = { kind: "error", status: 422, error: "repo_required", extra: { candidates: [{ repo: "x", host: "mac" }] } }
    const e = engine(null, async () => out)
    await e.refresh()
    expect(await e.choose({ id: `task:${ID}`, optionId: "takeover" })).toMatchObject({ status: 422, body: { error: "repo_required", candidates: [{ repo: "x", host: "mac" }] } })
    out = { kind: "error", status: 409, error: "herdr_unavailable", extra: { reason: "herdr-down" } }
    expect(await e.choose({ id: `task:${ID}`, optionId: "takeover" })).toMatchObject({ status: 409, body: { error: "herdr_unavailable" } })
  })
})

describe("POST /api/orchestrator/takeover (peer)", () => {
  const calls: Parameters<typeof runPeerTakeover>[0][] = []
  const run: typeof runPeerTakeover = async (input) => {
    calls.push(input)
    return { status: 200, body: { ok: true, detail: { session: "tko-mac-aaaaaaaa" } } }
  }
  const post = async (body: unknown, hop = true) => {
    const handler = routes.createTriageHandler(undefined, undefined, run)
    const req = new Request("http://localhost/api/orchestrator/takeover", {
      method: "POST", body: JSON.stringify(body), headers: hop ? { "x-companion-takeover-hop": "1" } : {},
    })
    const res = (await handler(req, new URL(req.url)))!
    return { status: res.status, json: await res.json() as Record<string, unknown> }
  }
  const good = { taskId: ID, version: "blocked|2026-10-16 10:00:00", repo: "claude-companion", host: "mac", by: "triage" }

  test("hop header required; body validated; a valid hop runs here", async () => {
    expect((await post(good, false)).status).toBe(403)
    expect(await post({ ...good, taskId: "x" })).toMatchObject({ status: 400, json: { error: "taskId_invalid" } })
    expect(await post({ ...good, repo: "../etc" })).toMatchObject({ status: 400, json: { error: "repo_invalid" } })
    expect(await post({ ...good, host: "laptop" })).toMatchObject({ status: 400, json: { error: "host_invalid" } })
    expect(await post({ ...good, logTail: "x".repeat(5_000) })).toMatchObject({ status: 400, json: { error: "logTail_invalid" } })
    expect(calls).toHaveLength(0)
    expect(await post({ ...good, logTail: "▶ builder: Fix" })).toMatchObject({ status: 200, json: { ok: true, detail: { session: "tko-mac-aaaaaaaa" } } })
    expect(calls[0]).toEqual({ ...good, host: "mac", logTail: "▶ builder: Fix" })
  })
})
