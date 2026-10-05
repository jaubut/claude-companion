import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { INTERRUPTED, createPeerJobStore, outcomeOf, parsePeerFixRequest, peerHasRepo, prRef, runFixOnPeer } from "./resolver-peer"

// The peer fix-run contract: request parsing, the peer's job store (idempotent
// on (itemId, attempt), restart → transient failure), and the Zettlab client
// (has-repo, POST + poll, peer down → transient "Mac unreachable").

const cfg = { base: "http://127.0.0.1:1", token: "tok" }
const HOP = "x-companion-body-hop"
const good = {
  itemId: "pr:jaubut/tls-review#9", prUrl: "https://github.com/jaubut/tls-review/pull/9", branch: "dispatch/ab12", instructions: "Fix it",
  model: "claude-opus-5-5", timeoutMs: 60_000, attempt: 7,
}

describe("request", () => {
  test("parses the contract body; rejects what is not a GitHub PR or a bad attempt", () => {
    expect(parsePeerFixRequest(good)).toMatchObject(good)
    expect(parsePeerFixRequest({ ...good, prUrl: "https://evil.example/x/y/pull/1" })).toEqual({ error: "prUrl must be a github.com pull request URL" })
    expect(parsePeerFixRequest({ ...good, attempt: -1 })).toHaveProperty("error")
    expect(parsePeerFixRequest({ ...good, timeoutMs: 10 })).toHaveProperty("error")
    expect(parsePeerFixRequest([])).toHaveProperty("error")
    expect(prRef("https://github.com/jaubut/tls-review/pull/9")).toEqual({ slug: "jaubut/tls-review", number: 9 })
  })

  test("outcomeOf never turns a malformed answer into pushed", () => {
    expect(outcomeOf({ kind: "pushed" })).toBeNull()
    expect(outcomeOf({ kind: "pushed", sha: "abc", summary: "s" })).toEqual({ kind: "pushed", sha: "abc", summary: "s" })
    expect(outcomeOf({ kind: "failed", error: "x", transient: true })).toEqual({ kind: "failed", error: "x", transient: true })
    expect(outcomeOf("nope")).toBeNull()
  })
})

describe("job store", () => {
  test("one job per (itemId, attempt); a restart turns running jobs into a transient failure", () => {
    const s = createPeerJobStore(new Database(":memory:"))
    const a = s.claim("pr:x#1", 3, "job-a", 1)
    expect(a.created).toBe(true)
    const again = s.claim("pr:x#1", 3, "job-b", 2)
    expect(again).toMatchObject({ created: false, job: { jobId: "job-a", status: "running" } })
    expect(s.claim("pr:x#1", 4, "job-c", 3).created).toBe(true)
    s.finish("job-c", { kind: "pushed", sha: "s", summary: "ok" }, 4)
    expect(s.closeInterrupted(5)).toBe(1)
    expect(s.get("job-a")).toMatchObject({ status: "done", outcome: INTERRUPTED })
    expect(s.get("job-c")).toMatchObject({ status: "done", outcome: { kind: "pushed" } })
  })
})

type Reply = { status: number; json?: unknown } | "down"

function fakeFetch(replies: Reply[], seen: { url: string; method: string; hop: string | null; auth: string | null }[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers)
    seen.push({ url, method: init.method ?? "GET", hop: h.get(HOP), auth: h.get("authorization") })
    const r = replies.shift() ?? "down"
    if (r === "down") throw Object.assign(new Error("refused"), { name: "ConnectionRefused" })
    return Response.json(r.json ?? {}, { status: r.status })
  }) as unknown as typeof fetch
}

describe("client", () => {
  test("has-repo: yes / no / unreachable, with the bearer and the HOP header", async () => {
    const seen: { url: string; method: string; hop: string | null; auth: string | null }[] = []
    const d = { hopHeader: HOP, fetchFn: fakeFetch([{ status: 200, json: { ok: true, hasRepo: true } }, { status: 200, json: { ok: true, hasRepo: false } }, "down"], seen) }
    expect(await peerHasRepo(cfg, "jaubut/tls-review", d)).toEqual({ kind: "yes" })
    expect(await peerHasRepo(cfg, "jaubut/tls-review", d)).toEqual({ kind: "no" })
    expect((await peerHasRepo(cfg, "jaubut/tls-review", d)).kind).toBe("unreachable")
    expect(seen[0]).toEqual({ url: "http://127.0.0.1:1/api/resolver/has-repo?slug=jaubut%2Ftls-review", method: "GET", hop: "1", auth: "Bearer tok" })
  })

  test("POST then poll until done; the outcome is the Mac's", async () => {
    const seen: { url: string; method: string; hop: string | null; auth: string | null }[] = []
    const replies: Reply[] = [
      { status: 202, json: { ok: true, jobId: "j1", status: "running" } },
      { status: 200, json: { ok: true, jobId: "j1", status: "running" } },
      "down",
      { status: 200, json: { ok: true, jobId: "j1", status: "done", outcome: { kind: "pushed", sha: "abc123", summary: "Fixed" } } },
    ]
    const out = await runFixOnPeer(cfg, good, { hopHeader: HOP, fetchFn: fakeFetch(replies, seen), sleep: async () => {}, pollMs: 0 })
    expect(out).toEqual({ kind: "pushed", sha: "abc123", summary: "Fixed" })
    expect(seen.map((s) => `${s.method} ${s.url.replace(cfg.base, "")}`)).toEqual([
      "POST /api/resolver/fix", "GET /api/resolver/fix/j1", "GET /api/resolver/fix/j1", "GET /api/resolver/fix/j1",
    ])
    expect(seen.every((s) => s.hop === "1")).toBe(true)
  })

  test("a replayed POST that is already done answers at once", async () => {
    const out = await runFixOnPeer(cfg, good, {
      hopHeader: HOP, sleep: async () => {}, fetchFn: fakeFetch([{ status: 202, json: { ok: true, jobId: "j1", status: "done", replay: true, outcome: { kind: "blocked", reason: "conflicts" } } }], []),
    })
    expect(out).toEqual({ kind: "blocked", reason: "conflicts" })
  })

  test("peer down at the start → transient Mac unreachable; lost for the whole tail → transient; job lost → transient", async () => {
    const d = { hopHeader: HOP, sleep: async () => {}, pollMs: 0 }
    expect(await runFixOnPeer(cfg, good, { ...d, fetchFn: fakeFetch(["down"], []) })).toMatchObject({ kind: "failed", transient: true, error: expect.stringMatching(/^Mac unreachable/) })
    let t = 0
    const tail = await runFixOnPeer(cfg, { ...good, timeoutMs: 1_000 }, {
      ...d, now: () => (t += 60_000), fetchFn: fakeFetch([{ status: 202, json: { ok: true, jobId: "j1", status: "running" } }], []),
    })
    expect(tail).toMatchObject({ kind: "failed", transient: true, error: expect.stringContaining("lost contact") })
    const gone = await runFixOnPeer(cfg, good, { ...d, fetchFn: fakeFetch([{ status: 202, json: { ok: true, jobId: "j1", status: "running" } }, { status: 404, json: { ok: false } }], []) })
    expect(gone).toEqual({ kind: "failed", error: "the Mac lost the fix job", transient: true })
  })

  test("a refusal (400) is a plain failure, not transient", async () => {
    const out = await runFixOnPeer(cfg, good, { hopHeader: HOP, fetchFn: fakeFetch([{ status: 400, json: { ok: false, error: "branch required" } }], []) })
    expect(out).toEqual({ kind: "failed", error: "the Mac refused the fix job: branch required" })
  })
})
