import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { recordPeer } from "../lib/vault-guard"
import type { Session } from "../lib/sessions"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"

// brain-v2 routes (routes/brain.ts): the propose hook's auth, dedupe and
// hand-off end to end (real sqlite proposals, a fake Turso with the
// production tasks/notes columns incl. origin), and the Bearer-gated controls.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-route-")), "test.db")
process.env.COMPANION_AUTH_TOKEN = process.env.COMPANION_AUTH_TOKEN || "brain-route-test-token-0123456789"
const savedHome = process.env.HOME
const tempHome = mkdtempSync(join(tmpdir(), "cc-brain-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
writeFileSync(join(tempHome, ".claude", "agents", "builder.md"), "---\n---\n")

const turso = new Database(":memory:")
turso.exec(`
  CREATE TABLE notes (id TEXT PRIMARY KEY, folder TEXT, title TEXT, ref_code TEXT, status TEXT, type TEXT, body TEXT, updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_id TEXT DEFAULT '', text TEXT NOT NULL, description TEXT DEFAULT '',
    done INTEGER DEFAULT 0, due_date TEXT DEFAULT '', position INTEGER DEFAULT 0, assignee TEXT, origin TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    dispatch_status TEXT, dispatch_run_id TEXT, dispatch_started_at TEXT, dispatch_completed_at TEXT,
    dispatch_blocker TEXT, dispatch_owner TEXT, dispatch_result_ref TEXT, dispatch_pr_url TEXT, last_pm_review TEXT
  );
  CREATE TABLE agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT,
    target_id TEXT, summary TEXT, meta TEXT, ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)
const hooks: { beforeExec: ((sql: string) => void) | null } = { beforeExec: null }
const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  hooks.beforeExec?.(sql)
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  return { rows: [], affected: turso.query(sql).run(...args).changes }
}
const query: QueryFn = async (sql, args) => (await exec(sql, args)).rows

let route: typeof import("./brain")
let wiringMod: typeof import("../wiring/brain")
let chat: typeof import("../lib/orchestrator-chat")
let sqlite: typeof import("../lib/orchestrator-db")["db"]
let handler: (req: Request, url: URL) => Promise<Response | null>
let flags: { paused: boolean; spawns: number }
let harnessWiring: ReturnType<typeof import("../wiring/brain").createBrainWiring>

const BRAIN_SESSION = {
  key: "herdr:p_brain", agent: "claude", label: "brain", title: "", sidConfirmed: true, agentStatus: "", waitingFor: "", cwd: "/srv/brain",
  sessionId: "sid-brain", termProgram: "", tty: "", iTermSessionId: "", tmuxPane: "", herdrPane: "p_brain", taskId: "brain",
  waitingSince: 0, waitingKind: "", waitingRef: "", waitingReasons: [], pid: "5150", firstSeenAt: 0, lastSeenAt: 0,
} as unknown as Session
const sessions: Session[] = [BRAIN_SESSION, { ...BRAIN_SESSION, key: "tty:other", sessionId: "sid-other", taskId: "", pid: "6060", herdrPane: "" } as Session]

beforeAll(async () => {
  process.env.HOME = tempHome
  route = await import("./brain")
  wiringMod = await import("../wiring/brain")
  chat = await import("../lib/orchestrator-chat")
  sqlite = (await import("../lib/orchestrator-db")).db
  const poller = await import("../lib/dispatch-poller")
  const mirror = await import("../lib/dispatch-mirror")
  const channels = await import("../lib/orchestrator-channels")
  const dispatch = poller.createDispatchWiring({
    query, exec, broadcast: () => {}, appendTurn: (text, taskId, ch, card) => chat.appendTurn("orchestrator", text, taskId, ch, card),
    push: () => {}, pushEnabled: () => false, linkedNotes: channels.linkedNotes, getChannel: channels.getChannel,
    localQueue: () => ({ cap: 0, live: 0, queued: 0 }), log: () => {}, mirror, generalChannel: "general",
  })
  channels.ensureChannel("brain", "Brain")
  flags = { paused: false, spawns: 0 }
  const w = wiringMod.createBrainWiring({
    now: Date.now, alive: async () => false, agentPane: async () => "", spawn: async () => { flags.spawns++; return { ok: true, herdrPane: "p_brain" } },
    stopAgent: async () => {}, sessions: () => sessions, sessionByKey: (k) => sessions.find((s) => s.key === k) ?? null, tagBrain: () => false,
    agentStatus: async () => "",
    lastReply: async () => "",
    interrupt: async () => {},
    deliver: async () => Response.json({ ok: true }), broadcast: () => {}, push: () => {},
    paused: { read: () => flags.paused, write: (on) => { flags.paused = on } },
    contextPct: () => null, compact: async () => true, dispatch, host: "test", log: () => {},
  })
  w.setSpawnedPaneForTests("p_brain")
  w.onSessionStart(BRAIN_SESSION)
  harnessWiring = w
  const todoMod = await import("../wiring/brain-todo")
  handler = route.createBrainRoute({ wiring: w, sessions: () => sessions, enabled: () => true, todo: (p) => todoMod.addBrainTodo(p, dispatch) })
})
afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})
beforeEach(() => {
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status) VALUES ('projects/dash', 'projects', 'TLS Dashboard', 'PRJ-WCLS', 'active')").run()
  sqlite.exec("DELETE FROM brain_proposals; DELETE FROM brain_consent")
})

async function call(method: string, path: string, body?: unknown, opts: { peer?: string; headers?: Record<string, string> } = {}) {
  const req = new Request(`http://localhost:4245${path}`, {
    method, headers: { "content-type": "application/json", ...(opts.headers ?? {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  recordPeer(req, opts.peer ?? "127.0.0.1")
  const res = await handler(req, new URL(req.url))
  const text = await res!.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* plain-text 401 */ }
  return { status: res!.status, json }
}

const AUTH = { "x-companion-task-id": "brain", "x-companion-pid": "5150" }
const propose = (body: Record<string, unknown>, opts: { peer?: string; headers?: Record<string, string> } = { headers: AUTH }) =>
  call("POST", "/hooks/brain/propose", body, opts)
const voiceTurn = (ageMs = 0) => {
  const t = chat.appendTurn("user", "dispatch the fix", null, "brain", { kind: "voice", source: "app" })
  sqlite.query("UPDATE orchestrator_turns SET created_at = ? WHERE id = ?").run(Date.now() - ageMs, t.id)
  return t
}
const body = (sourceTurnId: string, prompt = "Fix the tax rounding in invoices") => ({ title: "Fix tax rounding", prompt, noteId: "projects/dash", reasoning: "asked by voice", sourceTurnId })

describe("POST /hooks/brain/propose — auth", () => {
  test("a tailscale-serve hop (loopback peer + XFF) → 403", async () => {
    const r = await propose(body(voiceTurn().id), { headers: { ...AUTH, "x-forwarded-for": "100.101.102.103" } })
    expect(r.status).toBe(403)
  })
  test("tailnet peer → 403; wrong pid → 403; another session's pid → 403; missing task header → 403", async () => {
    const t = voiceTurn().id
    expect((await propose(body(t), { peer: "100.64.0.9", headers: AUTH })).status).toBe(403)
    expect((await propose(body(t), { headers: { ...AUTH, "x-companion-pid": "9999" } })).status).toBe(403)
    expect((await propose(body(t), { headers: { ...AUTH, "x-companion-pid": "6060" } })).status).toBe(403)
    expect((await propose(body(t), { headers: { "x-companion-pid": "5150" } })).status).toBe(403)
    expect(turso.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 })
  })
  test("missing noteId → 422 no_project", async () => {
    const r = await propose({ ...body(voiceTurn().id), noteId: undefined })
    expect(r).toEqual({ status: 422, json: { ok: false, error: "no_project" } })
  })
})

describe("POST /hooks/brain/propose — the brain hands off, no Approve card", () => {
  test("typed or voice, any age: filed queued (origin jeremie) at once, no proposal text in the thread", async () => {
    const typed = chat.appendTurn("user", "typed ask", null, "brain")
    const r = await propose(body(typed.id))
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, status: "queued" })
    expect(chat.getTask(String(r.json.proposalId))!.status).not.toBe("proposed")
    expect((await propose(body(voiceTurn(11 * 60_000).id))).json).toMatchObject({ status: "queued" })
    const rows = turso.query("SELECT dispatch_status, origin FROM tasks").all() as Array<Record<string, unknown>>
    expect(rows).toEqual([{ dispatch_status: "queued", origin: "jeremie" }, { dispatch_status: "queued", origin: "jeremie" }])
    expect(chat.getThread("brain").some((t) => t.text.startsWith("Proposal [") || t.text.startsWith("filed ["))).toBe(false)
  })
  test("same (sourceTurnId, prompt) twice → one proposal, one Turso row", async () => {
    const t = voiceTurn().id
    const a = await propose(body(t))
    const b = await propose(body(t))
    expect(b.json).toMatchObject({ ok: true, proposalId: a.json.proposalId, replay: true })
    expect(turso.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 })
  })
  test("the resolver never takes it: handed off while filing and once queued; a failed filing stays a card", async () => {
    const seen: boolean[] = []
    let fail = false
    const watch = (sql: string) => {
      if (!/INSERT\s+(OR\s+\w+\s+)?INTO tasks/i.test(sql)) return
      const id = (sqlite.query("SELECT task_id FROM orchestrator_tasks ORDER BY created_at DESC LIMIT 1").get() as { task_id: string }).task_id
      seen.push(wiringMod.proposalHandedOff(id))
      if (fail) throw new Error("turso down")
    }
    hooks.beforeExec = watch
    try {
      const ok = await propose(body(voiceTurn().id, "merge PR 368"))
      expect(ok.json).toMatchObject({ status: "queued" })
      expect(seen).toEqual([true])
      expect(wiringMod.proposalHandedOff(String(ok.json.proposalId))).toBe(true)
      fail = true
      const bad = await propose(body(voiceTurn().id, "merge PR 369"))
      expect(bad.json).toMatchObject({ status: "proposed" })
      expect(wiringMod.proposalHandedOff(String(bad.json.proposalId))).toBe(false)
    } finally {
      hooks.beforeExec = null
    }
  })
  test("two prompts from one turn → two dispatches", async () => {
    const v = voiceTurn().id
    expect((await propose(body(v, "first prompt"))).json).toMatchObject({ status: "queued" })
    expect((await propose(body(v, "a different second prompt"))).json).toMatchObject({ status: "queued" })
    expect(turso.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 2 })
  })
})

describe("/api/brain controls", () => {
  const bearer = { authorization: `Bearer ${getAuthToken()}` }
  test("without the Bearer → 401 (pause / resume / restart / status)", async () => {
    for (const p of ["/api/brain/pause", "/api/brain/resume", "/api/brain/restart"]) expect((await call("POST", p)).status).toBe(401)
    expect((await call("GET", "/api/brain")).status).toBe(401)
  })
  test("pause writes the flag and the next tick does not spawn; restart while paused → 409; resume clears it", async () => {
    const p = await call("POST", "/api/brain/pause", undefined, { headers: bearer })
    expect(p.json).toMatchObject({ ok: true, brain: { state: "paused" } })
    expect(flags.paused).toBe(true)
    const before = flags.spawns
    await harnessWiring.tick() // the brain is not alive: only the flag stops a respawn
    expect(flags.spawns).toBe(before)
    expect(harnessWiring.status().state).toBe("paused")
    expect((await call("POST", "/api/brain/restart", undefined, { headers: bearer })).status).toBe(409)
    expect(flags.spawns).toBe(before)
    const r = await call("POST", "/api/brain/resume", undefined, { headers: bearer })
    expect(r.json).toMatchObject({ ok: true })
    expect(flags.paused).toBe(false)
  })
  test("GET /api/brain/trace returns rows", async () => {
    const r = await call("GET", "/api/brain/trace?since=0", undefined, { headers: bearer })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.json.rows)).toBe(true)
  })
})

describe("POST /hooks/brain/thread", () => {
  beforeEach(() => {
    // /api/brain controls above pause and resume: adopt the brain session again.
    flags.paused = false
    harnessWiring.setSpawnedPaneForTests("p_brain")
    harnessWiring.onSessionStart(BRAIN_SESSION)
  })

  test("the brain finds its own thread turns, newest first; LIKE wildcards are literal", async () => {
    chat.appendTurn("user", "post the Instagram reel for Bistro Mavia", null, "brain")
    chat.appendTurn("orchestrator", "Proposed: Instagram reel — waits for your tap", null, "brain")
    chat.appendTurn("user", "instagram elsewhere", null, "general")
    chat.appendTurn("user", "100% done", null, "brain")
    const r = await call("POST", "/hooks/brain/thread", { q: "instagram" }, { headers: AUTH })
    expect(r.status).toBe(200)
    const turns = r.json.turns as Array<{ role: string; text: string }>
    expect(turns.map((t) => t.text)).toEqual(["Proposed: Instagram reel — waits for your tap", "post the Instagram reel for Bistro Mavia"])
    const pct = await call("POST", "/hooks/brain/thread", { q: "0%" }, { headers: AUTH })
    expect((pct.json.turns as unknown[]).length).toBe(1)
    const none = await call("POST", "/hooks/brain/thread", { q: "_" }, { headers: AUTH })
    expect((none.json.turns as unknown[]).length).toBe(0)
  })

  test("same auth as propose: a tailnet peer or a foreign pid → 403; no q → 400", async () => {
    expect((await call("POST", "/hooks/brain/thread", { q: "x" }, { headers: AUTH, peer: "100.64.0.9" })).status).toBe(403)
    expect((await call("POST", "/hooks/brain/thread", { q: "x" }, { headers: { ...AUTH, "x-companion-pid": "9999" } })).status).toBe(403)
    expect((await call("POST", "/hooks/brain/thread", {}, { headers: AUTH })).status).toBe(400)
  })
})

describe("POST /hooks/brain/todo", () => {
  beforeEach(() => {
    flags.paused = false
    harnessWiring.setSpawnedPaneForTests("p_brain")
    harnessWiring.onSessionStart(BRAIN_SESSION)
  })

  test("adds Jeremie's to-do on the note (by ref code), never queued; a retry adds it once", async () => {
    const t = chat.appendTurn("user", "remind me to call the cousin", null, "brain")
    const req = { text: "Call the cousin about Le Brouemont", noteId: "PRJ-WCLS", due: "2026-11-02", sourceTurnId: t.id }
    const a = await call("POST", "/hooks/brain/todo", req, { headers: AUTH })
    expect(a.status).toBe(200)
    expect(a.json).toMatchObject({ ok: true, replay: false })
    const b = await call("POST", "/hooks/brain/todo", req, { headers: AUTH })
    expect(b.json).toMatchObject({ ok: true, taskId: a.json.taskId, replay: true })
    const rows = turso.query("SELECT note_id, text, due_date, assignee, dispatch_status, done FROM tasks").all()
    expect(rows).toEqual([{ note_id: "projects/dash", text: "Call the cousin about Le Brouemont", due_date: "2026-11-02", assignee: "human:jeremie", dispatch_status: null, done: 0 }])
  })

  test("auth like propose; bad due / no note / no text refused", async () => {
    const t = chat.appendTurn("user", "x", null, "brain")
    const ok = { text: "x", noteId: "projects/dash", sourceTurnId: t.id }
    expect((await call("POST", "/hooks/brain/todo", ok, { headers: { ...AUTH, "x-companion-pid": "9999" } })).status).toBe(403)
    expect((await call("POST", "/hooks/brain/todo", { ...ok, due: "tomorrow" }, { headers: AUTH })).status).toBe(400)
    expect((await call("POST", "/hooks/brain/todo", { ...ok, noteId: "projects/nope" }, { headers: AUTH })).status).toBe(404)
    expect((await call("POST", "/hooks/brain/todo", { ...ok, text: "" }, { headers: AUTH })).status).toBe(400)
    expect(turso.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 })
  })
})

describe("POST /hooks/brain/pr-close", () => {
  test("brain auth, then input checks; only a valid call reaches the gate", async () => {
    const seen: unknown[] = []
    const h = route.createBrainRoute({
      wiring: harnessWiring, sessions: () => sessions, enabled: () => true,
      prClose: async (p) => { seen.push(p); return { status: 409, body: { ok: false, error: "not_dead" } } },
    })
    const post = async (b: unknown, headers: Record<string, string> = AUTH, peer = "127.0.0.1") => {
      const req = new Request("http://localhost:4245/hooks/brain/pr-close", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) })
      recordPeer(req, peer)
      const res = (await h(req, new URL(req.url)))!
      return { status: res.status, json: await res.json() as Record<string, unknown> }
    }
    const ok = { repo: "o/r", pr: 7, reason: "conflicting since #12" }
    expect((await post(ok, { ...AUTH, "x-companion-pid": "9999" })).status).toBe(403)
    expect((await post(ok, AUTH, "100.64.0.9")).status).toBe(403)
    expect((await post({ ...ok, repo: "o/r; rm -rf" })).status).toBe(400)
    expect((await post({ ...ok, pr: "7" })).status).toBe(400)
    expect((await post({ ...ok, reason: "" })).status).toBe(400)
    expect((await post({ ...ok, reason: "x".repeat(301) })).status).toBe(400)
    expect(seen).toHaveLength(0)
    const r = await post(ok)
    expect(r.status).toBe(409)
    expect(r.json.error).toBe("not_dead")
    expect(seen).toEqual([ok])
  })
})

describe("POST /hooks/brain/pr-merge", () => {
  test("brain auth, then input checks; only a valid call reaches the merge gate, never the close gate", async () => {
    const seen: unknown[] = []
    const h = route.createBrainRoute({
      wiring: harnessWiring, sessions: () => sessions, enabled: () => true,
      prClose: async () => { throw new Error("pr-merge must not reach pr-close") },
      prMerge: async (p) => { seen.push(p); return { status: 403, body: { ok: false, error: "needs_human", reasons: ["sensitive paths: billing.ts"] } } },
    })
    const post = async (b: unknown, headers: Record<string, string> = AUTH, peer = "127.0.0.1", method = "POST") => {
      const req = new Request("http://localhost:4245/hooks/brain/pr-merge", { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(b) : undefined })
      recordPeer(req, peer)
      const res = (await h(req, new URL(req.url)))!
      return { status: res.status, json: await res.json() as Record<string, unknown> }
    }
    const ok = { repo: "o/r", pr: 7, reason: "routine: cascade approved, CI green" }
    expect((await post(ok, {})).status).toBe(403)
    expect((await post(ok, { ...AUTH, "x-companion-pid": "9999" })).status).toBe(403)
    expect((await post(ok, { ...AUTH, "x-companion-task-id": "worker" })).status).toBe(403)
    expect((await post(ok, AUTH, "100.64.0.9")).status).toBe(403)
    expect((await post(ok, AUTH, "127.0.0.1", "GET")).status).toBe(405)
    expect((await post({ ...ok, repo: "o/r; rm -rf" })).status).toBe(400)
    expect((await post({ ...ok, pr: "7" })).status).toBe(400)
    expect((await post({ ...ok, pr: 0 })).status).toBe(400)
    expect((await post({ ...ok, reason: "" })).status).toBe(400)
    expect((await post({ ...ok, reason: "x".repeat(301) })).status).toBe(400)
    expect(seen).toHaveLength(0)
    const r = await post(ok)
    expect(r.status).toBe(403)
    expect(r.json).toEqual({ ok: false, error: "needs_human", reasons: ["sensitive paths: billing.ts"] })
    expect(seen).toEqual([ok])
  })

  test("404 brain_disabled when the brain is off", async () => {
    const h = route.createBrainRoute({ wiring: harnessWiring, sessions: () => sessions, enabled: () => false, prMerge: async () => { throw new Error("unreachable") } })
    const req = new Request("http://localhost:4245/hooks/brain/pr-merge", { method: "POST", headers: { "content-type": "application/json", ...AUTH }, body: "{}" })
    recordPeer(req, "127.0.0.1")
    expect((await h(req, new URL(req.url)))!.status).toBe(404)
  })
})

describe("POST /hooks/brain/deploy", () => {
  const post = (h: ReturnType<typeof route.createBrainRoute>) => async (b: unknown, headers: Record<string, string> = AUTH, peer = "127.0.0.1", method = "POST") => {
    const req = new Request("http://localhost:4245/hooks/brain/deploy", { method, headers: { "content-type": "application/json", ...headers }, body: method === "POST" ? JSON.stringify(b) : undefined })
    recordPeer(req, peer)
    const res = (await h(req, new URL(req.url)))!
    return { status: res.status, json: await res.json() as Record<string, unknown> }
  }

  test("brain auth, then the repo allowlist and a reason; only a valid call reaches the deployer", async () => {
    const seen: string[] = []
    const call = post(route.createBrainRoute({
      wiring: harnessWiring, sessions: () => sessions, enabled: () => true,
      deploy: async (repo) => { seen.push(repo); return { ok: false, repo, error: "not_fast_forward", from: "a", to: "b" } },
    }))
    const ok = { repo: "claude-config", reason: "merge #176 needs to be live now" }
    expect((await call(ok, {})).status).toBe(403)
    expect((await call(ok, { ...AUTH, "x-companion-pid": "9999" })).status).toBe(403)
    expect((await call(ok, AUTH, "100.64.0.9")).status).toBe(403)
    expect((await call(ok, AUTH, "127.0.0.1", "GET")).status).toBe(405)
    for (const repo of ["tls-dashboard-v2", "jaubut/claude-config", "../claude-companion", 7]) expect((await call({ ...ok, repo })).status).toBe(400)
    expect((await call({ ...ok, reason: "" })).status).toBe(400)
    expect(seen).toHaveLength(0)
    const r = await call(ok)
    expect([r.status, r.json.error]).toEqual([409, "not_fast_forward"])
    expect(seen).toEqual(["claude-config"])
  })

  test("404 deploy_disabled where the deployer does not run (not the brain host)", async () => {
    const call = post(route.createBrainRoute({ wiring: harnessWiring, sessions: () => sessions, enabled: () => true, deploy: null }))
    const r = await call({ repo: "claude-companion", reason: "now" })
    expect([r.status, r.json.error]).toEqual([404, "deploy_disabled"])
  })
})
