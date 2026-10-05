import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FixInput, FixOutcome } from "../lib/resolver-fix"
import type { SourceItem } from "../lib/triage"

// Mac-only repos run their fix on the Mac, over real HTTP: a Bun server with
// routes/resolver.ts plays the Mac; the resolver's fix seam (wiring/resolver.ts
// → wiring/resolver-peer.ts) plays Zettlab. The fix run itself is a fake
// (lib/resolver-fix-git.test.ts covers it on real git).

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-resolver-peer-")), "companion.db")

let peerWiring: typeof import("../wiring/resolver-peer")
let routes: typeof import("./resolver")
let resolverWiring: typeof import("../wiring/resolver")
let peerLib: typeof import("../lib/resolver-peer")
let server: ReturnType<typeof Bun.serve>
let base: string
let runs: FixInput[]
let outcome: FixOutcome
let release: (() => void) | null
let hops: (string | null)[]

beforeAll(async () => {
  peerWiring = await import("../wiring/resolver-peer")
  routes = await import("./resolver")
  resolverWiring = await import("../wiring/resolver")
  peerLib = await import("../lib/resolver-peer")
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      hops.push(req.headers.get("x-companion-body-hop"))
      if (req.headers.get("authorization") !== "Bearer peer-token") return new Response("unauthorized", { status: 401 })
      return (await routes.handleResolverRoute(req, new URL(req.url))) ?? new Response("not found", { status: 404 })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

beforeEach(() => {
  runs = []
  hops = []
  release = null
  outcome = { kind: "pushed", sha: "abc12345def", summary: "Fixed on the Mac" }
  peerWiring.setResolverPeerDeps({
    peer: () => ({ base, token: "peer-token" }),
    localRepo: async (slug) => (slug === "jaubut/tls-review" ? "/Users/me/tls-review" : null),
    runFix: async (f) => {
      runs.push(f)
      if (release === null) return outcome
      await new Promise<void>((r) => { release = r })
      return outcome
    },
    store: (() => { const s = peerLib.createPeerJobStore(new Database(":memory:")); return () => s })(),
    sleep: async () => {},
    pollMs: 0,
  })
})

const url = "https://github.com/jaubut/tls-review/pull/9"
function pr(repo = "jaubut/tls-review"): SourceItem {
  return {
    source: "pr", refId: `${repo}#9`, version: "x|41", title: "Fix uploads", project: "tls-review", createdAt: 1, updatedAt: 1,
    facts: { reason: "ci", repo }, url, ref: { source: "pr", taskId: "tp9", prUrl: url.replace("jaubut/tls-review", repo), repo, number: 9 },
  }
}
const ctx = { repo: null, readableDirs: [], blocks: [], sensitivePaths: [], sensitive: false, rescuedBefore: false, pr: { head: "dispatch/ab12", base: "main", number: 9, title: "Fix uploads", taskText: "Fix uploads" } }

function seams() {
  return resolverWiring.liveSeams({ dispatch: {} as never, gh: async () => ({ code: 0, stdout: "", stderr: "" }), execute: async () => ({ kind: "done" }), store: {} as never })
}

describe("peer endpoints", () => {
  test("has-repo answers for this host only; a bad slug is a 400", async () => {
    const h = { authorization: "Bearer peer-token" }
    expect(await (await fetch(`${base}/api/resolver/has-repo?slug=jaubut/tls-review`, { headers: h })).json()).toMatchObject({ ok: true, hasRepo: true, slug: "jaubut/tls-review" })
    expect(await (await fetch(`${base}/api/resolver/has-repo?slug=jaubut/nope`, { headers: h })).json()).toMatchObject({ ok: true, hasRepo: false })
    expect((await fetch(`${base}/api/resolver/has-repo?slug=..%2F..`, { headers: h })).status).toBe(400)
  })

  test("POST /api/resolver/fix is idempotent on (itemId, attempt): one run, the same job id", async () => {
    release = () => {}
    const body = JSON.stringify({ itemId: "pr:jaubut/tls-review#9", prUrl: url, branch: "dispatch/ab12", instructions: "x", model: "m", timeoutMs: 60_000, attempt: 4 })
    const post = () => fetch(`${base}/api/resolver/fix`, { method: "POST", headers: { authorization: "Bearer peer-token", "content-type": "application/json" }, body })
    const one = await (await post()).json() as Record<string, unknown>
    const two = await (await post()).json() as Record<string, unknown>
    expect(one).toMatchObject({ ok: true, status: "running" })
    expect(two).toMatchObject({ ok: true, jobId: one.jobId, status: "running", replay: true })
    await Bun.sleep(5)
    expect(runs).toHaveLength(1)
    release!()
    await Bun.sleep(5)
    const polled = await (await fetch(`${base}/api/resolver/fix/${one.jobId}`, { headers: { authorization: "Bearer peer-token" } })).json()
    expect(polled).toMatchObject({ status: "done", outcome: { kind: "pushed", sha: "abc12345def" } })
    expect((await fetch(`${base}/api/resolver/fix/not-a-job`, { headers: { authorization: "Bearer peer-token" } })).status).toBe(404)
  })
})

describe("the resolver's fix seam with no local checkout", () => {
  test("Mac has the repo → the job runs there and its outcome comes back; the same fix input as a local run", async () => {
    const out = await seams().fix(pr(), ctx, "Inject the clock", "claude-opus-5-5", 60_000, 42)
    expect(out).toEqual({ kind: "pushed", sha: "abc12345def", summary: "Fixed on the Mac" })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ repo: "/Users/me/tls-review", head: "dispatch/ab12", base: "main", number: 9, instructions: "Inject the clock", model: "claude-opus-5-5", prUrl: url })
    expect(hops.length).toBeGreaterThan(1)
    expect(hops.every((h) => h === "1")).toBe(true)
  })

  test("neither host has it → the plain 'no local checkout' failure (counts for the loop guard)", async () => {
    const out = await seams().fix(pr("jaubut/elsewhere"), ctx, "x", "m", 60_000, 1)
    expect(out).toEqual({ kind: "failed", error: "no local checkout of jaubut/elsewhere on this host or the peer" })
    expect(runs).toHaveLength(0)
  })

  test("Mac down → transient 'Mac unreachable'", async () => {
    peerWiring.setResolverPeerDeps({ peer: () => ({ base: "http://127.0.0.1:9", token: "peer-token" }) })
    const out = await seams().fix(pr(), ctx, "x", "m", 60_000, 1)
    expect(out).toMatchObject({ kind: "failed", transient: true, error: expect.stringMatching(/^Mac unreachable/) })
  })

  test("no peer configured → no checkout failure, nothing sent", async () => {
    peerWiring.setResolverPeerDeps({ peer: () => null })
    expect(await seams().fix(pr(), ctx, "x", "m", 60_000, 1)).toMatchObject({ kind: "failed", error: expect.stringContaining("no local checkout") })
    expect(hops).toEqual([])
  })
})

describe("Xcode repo (repo-map requires xcode) with a clone on a host without Xcode", () => {
  test("linux + checkout present → still forwarded to the Mac peer, never run here", async () => {
    const live = await import("../lib/live-repo")
    const home = mkdtempSync(join(tmpdir(), "cc-xcode-fwd-"))
    const clone = join(home, "lanes", "ndi-wireless")
    mkdirSync(clone, { recursive: true })
    const map = join(home, "repo-map.ts")
    writeFileSync(map, `[\n  { name: "tls-viewer-ios", match: /ndi-wireless/i, path: \`\${home}/lanes/ndi-wireless\`, project: "PRJ-94TA", requires: ["xcode"] },\n]`)
    const saved = { map: process.env.COMPANION_REPO_MAP, home: process.env.HOME }
    process.env.COMPANION_REPO_MAP = map
    process.env.HOME = home
    live.setHostProbe({ platform: "linux", hasBin: () => true })
    peerWiring.setResolverPeerDeps({ localRepo: async (slug) => (slug === "jaubut/NDI-WIRELESS" ? "/Users/me/apps/NDI WIRELESS" : null) })
    try {
      expect(live.fixRepoHere(clone)).toBeNull()
      const out = await seams().fix(pr("jaubut/NDI-WIRELESS"), { ...ctx, repo: clone } as never, "Fix the build", "claude-opus-5-5", 60_000, 3)
      expect(out).toEqual({ kind: "pushed", sha: "abc12345def", summary: "Fixed on the Mac" })
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ repo: "/Users/me/apps/NDI WIRELESS", head: "dispatch/ab12" })
      expect(hops.length).toBeGreaterThan(1)
      // The Mac (darwin + xcodebuild) keeps the same clone as its local checkout.
      expect(live.fixRepoHere(clone, { platform: "darwin", hasBin: (b) => b === "xcodebuild" })).toBe(clone)
    } finally {
      live.setHostProbe(null)
      if (saved.map === undefined) delete process.env.COMPANION_REPO_MAP
      else process.env.COMPANION_REPO_MAP = saved.map
      process.env.HOME = saved.home
    }
  })
})
