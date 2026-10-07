import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"
import type { LiveRunner } from "../wiring/live"
import type { Task } from "../lib/orchestrator-chat"
import type { BodyComponentDetail } from "../lib/body"
import type { InvestigationRecord } from "../lib/body-investigate"
import { agentFor, buildAgentPrompt, parseAgentBody } from "../lib/body-agent"
import { createBodyHandler } from "./body"

// "Get an agent on it" — POST /api/body/component/:id/agent. Same harness as
// body-fix.test.ts: real Companion sqlite (isolated COMPANION_DB_PATH), "Turso"
// = in-memory bun:sqlite behind the QueryFn / ExecFn seams, a fake tmux runner,
// and an in-process "Mac" peer (runBodyFix with local "mac").

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-body-agent-")), "test.db")

const savedHome = process.env.HOME
const savedNote = process.env.COMPANION_BODY_NOTE_ID
const tempHome = mkdtempSync(join(tmpdir(), "cc-body-agent-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
for (const a of ["builder", "inbox-processor"]) writeFileSync(join(tempHome, ".claude", "agents", `${a}.md`), "---\n---\n")
const dispatchRun = join(tempHome, "dispatch-run.ts")
writeFileSync(dispatchRun, "const REPO_MAP = []\n")
const fixCwd = mkdtempSync(join(tmpdir(), "cc-body-agent-cwd-"))

let poller: typeof import("../lib/dispatch-poller")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let live: typeof import("../wiring/live")
let fix: typeof import("../wiring/body-fix")
let fixLib: typeof import("../lib/body-fix")
let agent: typeof import("../wiring/body-agent")
let host: string
let prevAgentDeps: import("../wiring/body-agent").BodyAgentDeps
let prevFixDeps: import("../wiring/body-fix").BodyFixDeps

// ── fake Turso ───────────────────────────────────────────────────────────────

const turso = new Database(":memory:")
turso.exec(`
  CREATE TABLE notes (id TEXT PRIMARY KEY, folder TEXT, title TEXT, ref_code TEXT, status TEXT, type TEXT, body TEXT, updated_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, note_id TEXT NOT NULL, parent_id TEXT DEFAULT '', text TEXT NOT NULL, description TEXT DEFAULT '',
    done INTEGER DEFAULT 0, due_date TEXT DEFAULT '', position INTEGER DEFAULT 0, assignee TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    dispatch_status TEXT, dispatch_run_id TEXT, dispatch_started_at TEXT, dispatch_completed_at TEXT,
    dispatch_blocker TEXT, dispatch_owner TEXT, dispatch_result_ref TEXT, dispatch_pr_url TEXT, last_pm_review TEXT
  );
  CREATE TABLE agent_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT, agent_slug TEXT NOT NULL, action TEXT NOT NULL, target_kind TEXT,
    target_id TEXT, summary TEXT, meta TEXT, ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)
const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  const res = turso.query(sql).run(...args)
  return { rows: [], affected: res.changes }
}
const query: QueryFn = async (sql, args) => (await exec(sql, args)).rows
const tursoRows = () => turso.query("SELECT * FROM tasks").all() as Record<string, any>[]
const activity = () => turso.query("SELECT * FROM agent_activity WHERE action = 'body:agent'").all() as Record<string, any>[]

// ── fakes ────────────────────────────────────────────────────────────────────

const spawns: { taskId: string; cwd: string; prompt: string; agent: string | null | undefined }[] = []
const fakeRunner: LiveRunner = {
  async spawn(t: Task) {
    spawns.push({ taskId: t.taskId, cwd: t.cwd, prompt: t.prompt, agent: t.agent })
    chat.setTaskSpawn(t.taskId, `cc-fake-${t.taskId}`, null)
    return { ok: true }
  },
  async kill() {},
  async alive() { return true },
}

let macDown = false
const peerCalls: { url: string; body: Record<string, unknown> }[] = []
let w: ReturnType<typeof makeWiring>

const peerFetch = (async (url: string, init: RequestInit) => {
  if (macDown) throw new TypeError("fetch failed")
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  peerCalls.push({ url, body })
  const req = fixLib.parseFixRequest(body)
  if ("error" in req) return Response.json({ ok: false, error: req.error }, { status: 400 })
  return fix.runBodyFix(req, w, "mac")
}) as unknown as typeof fetch

function makeWiring() {
  return poller.createDispatchWiring({
    query, exec,
    broadcast: () => {},
    appendTurn: (text, taskId, channelId) => chat.appendTurn("orchestrator", text, taskId, channelId),
    push: () => {}, pushEnabled: () => false,
    linkedNotes: channels.linkedNotes, getChannel: channels.getChannel,
    localQueue: () => ({ cap: 3, live: 0, queued: 0 }),
    liveIdentity: () => null,
    log: () => {}, mirror, generalChannel: "general",
  })
}

// Components "in Turso": id → detail.
const components = new Map<string, BodyComponentDetail>()
const investigations = new Map<string, InvestigationRecord>()

function component(id: string, kind: string, state: string, events = 5): BodyComponentDetail {
  const d: BodyComponentDetail = {
    ok: true, generated_at: "2026-10-06T12:00:00.000Z",
    component: {
      id, host: id.split(":")[0]!, kind, name: id.split(":").slice(2).join(":"), schedule_s: 300, criticality: "normal",
      depends_on: [], notes: null, first_seen: null, last_seen: null, retired: false, dependents: [], dependents_count: 0,
    },
    vitals: {
      component_id: id, observed_at: "2026-10-06T11:55:00Z", state: state as any, last_exit: 1, last_run_at: "2026-10-06T11:55:00Z",
      last_ok_at: "2026-10-05T10:00:00Z", runs_total: 10, runs_delta: 1, consecutive_failures: 4, detail: "inbox backlog 47 > 40",
    },
    events: Array.from({ length: events }, (_, i) => ({
      id: i, component_id: id, at: `2026-10-06T1${i}:00:00Z`, kind: "transition", from_state: "ok", to_state: state, detail: `event-${i}`,
    })),
  }
  components.set(id, d)
  return d
}

function investigated(id: string, proposalId: string | null = null): InvestigationRecord {
  const rec: InvestigationRecord = {
    id: `inv-${id.length}`, componentId: id, host: id.split(":")[0]!, state: "failing", fromState: "ok", trigger: "alert", status: "done",
    runOn: "zettlab", attempt: 1, createdAt: 1, startedAt: 1, finishedAt: 2, error: null, proposalId, reported: true, peerId: null,
    result: {
      rootCause: "Working as designed: 47 unprocessed inbox entries exceed the threshold of 40", evidence: ["SELECT COUNT(*) → 47", "threshold 40"],
      confidence: 0.9, severity: "med", recommendedFix: null, retire: false, notes: "",
    },
  }
  investigations.set(id, rec)
  return rec
}

let seq = 0
const uid = (base: string) => `${base}${++seq}`

const start = (id: string, instruction: string | null = null) => agent.startBodyAgent(id, instruction, w)
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, any> })

beforeAll(async () => {
  process.env.HOME = tempHome
  process.env.COMPANION_DISPATCH_RUN = dispatchRun
  process.env.COMPANION_BODY_NOTE_ID = "projects/dash"
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  const sqlite = (await import("../lib/orchestrator-db")).db
  mirror = await import("../lib/dispatch-mirror")
  poller = await import("../lib/dispatch-poller")
  live = await import("../wiring/live")
  fix = await import("../wiring/body-fix")
  fixLib = await import("../lib/body-fix")
  agent = await import("../wiring/body-agent")
  const agentLib = await import("../lib/body-agent")
  host = (await import("../state")).HOST_INFO.name
  live.setLiveRunner(fakeRunner)
  w = makeWiring()
  const peer = () => ({ base: "https://mac.test", token: "peer-token" })
  prevFixDeps = fix.setBodyFixDeps({ store: fixLib.createBodyFixStore(sqlite), localHost: () => "zettlab", peer, fetchFn: peerFetch })
  prevAgentDeps = agent.setBodyAgentDeps({
    store: agentLib.createBodyAgentStore(sqlite),
    localHost: () => "zettlab", peer, fetchFn: peerFetch,
    detail: async (id) => {
      if (id.includes("turso-down")) throw new Error("turso down")
      return components.get(id) ?? null
    },
    investigation: (id) => investigations.get(id) ?? null,
    fixCard: (taskId) => taskId === "card-mac" ? { taskId, host: "mac", componentId: "x", cwd: fixCwd, noteId: "projects/dash", agent: "builder", title: "t", investigationId: "i" } : null,
    paths: () => ({ files: [], commands: [], cwd: null, repo: null }),
    home: () => tempHome,
  })
})

afterAll(() => {
  agent.setBodyAgentDeps(prevAgentDeps)
  fix.setBodyFixDeps(prevFixDeps)
  live.setLiveRunner(live.tmuxRunner)
  live.setLiveCap(null)
  // bun shares one sqlite across test files: leave no live rows behind.
  for (const s of spawns) chat.setTaskStatus(s.taskId, "done")
  delete process.env.COMPANION_DISPATCH_RUN
  if (savedNote === undefined) delete process.env.COMPANION_BODY_NOTE_ID
  else process.env.COMPANION_BODY_NOTE_ID = savedNote
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

beforeEach(() => {
  macDown = false
  for (const s of spawns) chat.setTaskStatus(s.taskId, "done")
  spawns.length = 0
  peerCalls.length = 0
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status) VALUES ('projects/dash', 'projects', 'Companion Orchestrator', 'PRJ-OR1T', 'active')").run()
  live.setLiveCap(chat.countLiveTasks() + 3)
})

// ── pure parts ───────────────────────────────────────────────────────────────

describe("agent table + prompt + body", () => {
  test("component → agent", () => {
    expect(agentFor({ id: "cloud:turso-table:inbox_entries", kind: "turso-table" }, false)).toBe("inbox-processor")
    expect(agentFor({ id: "zettlab:systemd-timer:kb-sync", kind: "systemd-timer" }, true)).toBe("claude")
    expect(agentFor({ id: "zettlab:systemd-service:kb-api", kind: "systemd-service" }, false)).toBe("claude")
    expect(agentFor({ id: "mac:launchd:com.x", kind: "launchd" }, true)).toBe("claude")
    expect(agentFor({ id: "zettlab:github-actions:site", kind: "github-actions" }, true)).toBe("builder")
    expect(agentFor({ id: "cloud:http:site", kind: "http" }, false)).toBe("claude")
    expect(agentFor({ id: "cloud:turso-table:notes", kind: "turso-table" }, false)).toBe("claude")
  })

  test("body: empty / instruction / bad", () => {
    expect(parseAgentBody("")).toEqual({ instruction: null })
    expect(parseAgentBody("{}")).toEqual({ instruction: null })
    expect(parseAgentBody('{"instruction":"  clear it  "}')).toEqual({ instruction: "clear it" })
    expect(parseAgentBody('{"instruction":"   "}')).toEqual({ instruction: null })
    expect(parseAgentBody("nope")).toEqual({ error: "invalid JSON" })
    expect(parseAgentBody("[]")).toEqual({ error: "body must be a JSON object" })
    expect(parseAgentBody('{"instruction":3}')).toEqual({ error: "instruction must be a string" })
  })

  test("prompt carries id, kind, state, vitals line, last 3 events, rootCause, evidence, instruction", () => {
    const d = component("cloud:turso-table:inbox_entries", "turso-table", "failing")
    const p = buildAgentPrompt({ detail: d, investigation: investigated(d.component.id), instruction: "process the backlog", host: "zettlab", cwd: "/x" })
    expect(p).toContain("Component: cloud:turso-table:inbox_entries (kind turso-table, host zettlab, state failing)")
    expect(p).toContain("Latest vitals: state=failing")
    expect(p).toContain("detail=inbox backlog 47 > 40")
    expect(p).toContain("event-0")
    expect(p).toContain("event-2")
    expect(p).not.toContain("event-3")
    expect(p).toContain("47 unprocessed inbox entries exceed the threshold of 40")
    expect(p).toContain("- SELECT COUNT(*) → 47")
    expect(p).toContain("Instruction from Jeremie: process the backlog")
    expect(buildAgentPrompt({ detail: d, investigation: null, instruction: null, host: "zettlab", cwd: "/x" })).toContain("No finished investigation")
  })
})

// ── the endpoint ─────────────────────────────────────────────────────────────

describe("POST /api/body/component/:id/agent", () => {
  test("route: decodes the id, passes the instruction, 400 on bad JSON", async () => {
    const calls: [string, string | null][] = []
    const h = createBodyHandler({ startAgent: async (id, ins) => { calls.push([id, ins]); return Response.json({ ok: true }) } })
    const post = (path: string, body?: string) => {
      const req = new Request(`http://localhost${path}`, { method: "POST", body })
      return h(req, new URL(req.url))
    }
    expect((await post("/api/body/component/cloud%3Aturso-table%3Ainbox_entries/agent"))!.status).toBe(200)
    await post("/api/body/component/mac:launchd:x/agent", '{"instruction":"go"}')
    expect(calls).toEqual([["cloud:turso-table:inbox_entries", null], ["mac:launchd:x", "go"]])
    expect((await post("/api/body/component/x/agent", "{"))!.status).toBe(400)
    expect((await post("/api/body/component//agent"))!.status).toBe(400)
  })

  test("zettlab-owned (cloud:*) → live run here: inbox-processor, claimed running, Sessions-visible, logged", async () => {
    const id = "cloud:turso-table:inbox_entries"
    component(id, "turso-table", "failing")
    investigated(id)
    const r = await json(await start(id))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, host: "zettlab", agent: "inbox-processor", status: "running", mode: "live" })
    const { taskId, dispatchTaskId } = r.body
    expect(peerCalls).toHaveLength(0)

    const rows = tursoRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: dispatchTaskId, dispatch_status: "running", dispatch_owner: `companion:${host}`, assignee: "agent:inbox-processor", note_id: "projects/dash" })
    expect(spawns).toHaveLength(1)
    expect(spawns[0]).toMatchObject({ taskId, cwd: join(tempHome, ".claude"), agent: "inbox-processor" })
    expect(spawns[0]!.prompt).toContain("inbox backlog 47 > 40")
    expect(chat.getTask(taskId)).toMatchObject({ threadId: "body", dispatchTaskId })

    const log = activity()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ agent_slug: "inbox-processor", target_kind: "body_component", target_id: id })
    expect(JSON.parse(log[0]!.meta)).toMatchObject({ taskId, dispatchTaskId, owner: "zettlab" })

    // One open run per component: a second tap names the running one.
    const again = await json(await start(id))
    expect(again).toMatchObject({ status: 409, body: { ok: false, error: "already_running", taskId, dispatchTaskId } })
    expect(spawns).toHaveLength(1)

    // Once that run is finished, a new tap starts a new one.
    turso.query("UPDATE tasks SET dispatch_status = 'completed' WHERE id = ?").run(dispatchTaskId)
    const third = await json(await start(id))
    expect(third.status).toBe(200)
    expect(third.body.dispatchTaskId).not.toBe(dispatchTaskId)
  })

  test("a concurrent double tap starts one run", async () => {
    const id = uid("zettlab:systemd-service:kb")
    component(id, "systemd-service", "dead")
    const [a, b] = await Promise.all([start(id), start(id)])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(spawns).toHaveLength(1)
    expect(tursoRows()).toHaveLength(1)
  })

  test("state ok: refused without an instruction, started with one", async () => {
    const id = uid("zettlab:systemd-timer:t")
    component(id, "systemd-timer", "ok")
    expect(await json(await start(id))).toMatchObject({ status: 409, body: { error: "component_ok" } })
    expect(spawns).toHaveLength(0)
    const r = await json(await start(id, "rotate the logs"))
    expect(r).toMatchObject({ status: 200, body: { ok: true, agent: "claude", host: "zettlab" } })
    expect(spawns[0]!.prompt).toContain("Instruction from Jeremie: rotate the logs")
    expect(JSON.parse(activity()[0]!.meta).instruction).toBe("rotate the logs")
  })

  test("mac:* → forwarded to the Mac's /api/body/fix; the Mac claims live in the fix card's cwd", async () => {
    const id = uid("mac:launchd:com.job")
    component(id, "launchd", "crash_loop")
    investigated(id, "card-mac")
    const r = await json(await start(id))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, host: "mac", agent: "claude" })
    expect(peerCalls).toHaveLength(1)
    expect(peerCalls[0]).toMatchObject({ url: "https://mac.test/api/body/fix", body: { host: "mac", componentId: id, cwd: fixCwd, agent: "claude" } })
    expect(String(peerCalls[0]!.body.fixId)).toMatch(/^agent-/)
    expect(tursoRows()).toEqual([expect.objectContaining({ id: r.body.dispatchTaskId, dispatch_status: "running", dispatch_owner: `companion:${host}` })])
    expect(spawns).toEqual([expect.objectContaining({ taskId: r.body.taskId, cwd: fixCwd })])
    expect(activity()).toHaveLength(1)

    const again = await json(await start(id))
    expect(again).toMatchObject({ status: 409, body: { error: "already_running", taskId: r.body.taskId, host: "mac" } })
  })

  test("Mac unreachable → 503 host_unreachable, nothing recorded", async () => {
    const id = uid("mac:launchd:com.down")
    component(id, "launchd", "dead")
    macDown = true
    expect(await json(await start(id))).toMatchObject({ status: 503, body: { ok: false, error: "host_unreachable", host: "mac" } })
    expect(tursoRows()).toHaveLength(0)
    expect(activity()).toHaveLength(0)
    macDown = false
    expect((await start(id)).status).toBe(200)
  })

  test("404 unknown component, 503 when Turso is down", async () => {
    expect(await json(await start("zettlab:docker:nope"))).toMatchObject({ status: 404, body: { error: "no such component" } })
    expect(await json(await start("zettlab:docker:turso-down"))).toMatchObject({ status: 503, body: { error: "turso_unreachable" } })
  })

  test("a failed live start leaves no stray #Body card", async () => {
    const id = uid("zettlab:docker:c")
    component(id, "docker", "dead")
    live.setLiveCap(chat.countLiveTasks())
    const r = await json(await start(id))
    expect(r).toMatchObject({ status: 429, body: { error: "live_cap", host: "zettlab" } })
    const mine = chat.listTasks("body").filter((t) => t.prompt.includes(id))
    expect(mine).toHaveLength(1)
    expect(mine[0]!.status).toBe("cancelled")
  })
})
