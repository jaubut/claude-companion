import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ReapMode } from "../lib/brain-workers"
import type { TraceRow } from "../lib/brain-trace"
import type { DispatchTask } from "../lib/dispatch-tasks"
import type { Herdr } from "../lib/herdr"
import type { Session } from "../lib/sessions"
import type { BrainWiring } from "./brain"

// brain-workers reconciler (wiring/brain-workers.ts) against a fake herdr —
// never the real one — and real sqlite (COMPANION_DB_PATH) for proposal
// ownership and trace rows. Also the two routes it backs (routes/brain.ts).

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-workers-")), "test.db")
// The vault suites pin this token (auth caches the first read): share it, like copy-jobs.test.ts.
process.env.COMPANION_AUTH_TOKEN ||= "vault-test-token-0123456789"

let mod: typeof import("./brain-workers")
let chat: typeof import("../lib/orchestrator-chat")
let trace: typeof import("../lib/brain-trace")
let route: typeof import("../routes/brain")
let vault: typeof import("../lib/vault-guard")
let sqlite: typeof import("../lib/orchestrator-db")["db"]

beforeAll(async () => {
  mod = await import("./brain-workers")
  chat = await import("../lib/orchestrator-chat")
  trace = await import("../lib/brain-trace")
  route = await import("../routes/brain")
  vault = await import("../lib/vault-guard")
  sqlite = (await import("../lib/orchestrator-db")).db
})

const NOW = 1_800_000_000_000
const TASK = "0123456789abcdef0123456789abcdef"
const OTHER_TASK = "fedcba9876543210fedcba9876543210"

interface FakePane { id: string; agentStatus: string; shellPid: number; fg: number }
interface FakeWs { label: string; panes: FakePane[] }

class FakeHerdr implements Herdr {
  ws = new Map<string, FakeWs>()
  calls: string[][] = []
  brainAgent: { kind: "present"; ws: string; pane: string } | { kind: "absent" } | { kind: "error" } = { kind: "absent" }

  add(id: string, label: string, pane: Partial<FakePane> = {}): void {
    this.ws.set(id, { label, panes: [{ id: `${id}:p1`, agentStatus: "unknown", shellPid: 100, fg: 100, ...pane }] })
  }

  async call(args: string[]): Promise<Record<string, unknown>> {
    this.calls.push(args)
    const [a, b, c] = args
    const err = (code: string): Error => Object.assign(new Error(code), { code })
    if (a === "workspace" && b === "list") {
      return { workspaces: [...this.ws].map(([id, w]) => ({ workspace_id: id, label: w.label, pane_count: w.panes.length, agent_status: "unknown" })) }
    }
    if (a === "workspace" && b === "get") {
      const w = this.ws.get(c!)
      if (!w) throw err("workspace_not_found")
      return { workspace: { workspace_id: c, label: w.label, pane_count: w.panes.length } }
    }
    if (a === "workspace" && b === "close") {
      if (!this.ws.delete(c!)) throw err("workspace_not_found")
      return {}
    }
    if (a === "pane" && b === "list") {
      const id = args[3]!
      return { panes: (this.ws.get(id)?.panes ?? []).map((p) => ({ pane_id: p.id, workspace_id: id, agent_status: p.agentStatus })) }
    }
    if (a === "pane" && b === "process-info") {
      const p = [...this.ws.values()].flatMap((w) => w.panes).find((x) => x.id === args[3])
      if (!p) throw err("pane_not_found")
      return { process_info: { shell_pid: p.shellPid, foreground_process_group_id: p.fg } }
    }
    if (a === "agent" && b === "get") {
      const g = this.brainAgent
      if (g.kind === "error") throw err("timeout")
      if (g.kind === "absent") throw err("agent_not_found")
      return { agent: { pane_id: g.pane, workspace_id: g.ws } }
    }
    if (a === "agent" && b === "stop") return {}
    throw err("unexpected")
  }
  async read(): Promise<string | null> { return null }
  async gate(): Promise<string | null> { return null }
  closes(): string[] { return this.calls.filter((x) => x[0] === "workspace" && x[1] === "close").map((x) => x[2]!) }
}

const dtask = (id: string, status: DispatchTask["status"], updatedAt: number): DispatchTask => ({
  id, noteId: "projects/x", title: "t", agent: "builder", status, done: false, blocker: null, owner: "zettlab", prUrl: null,
  resultRef: null, projectTitle: null, projectRef: null, createdAt: 0, updatedAt, updatedAtRaw: "",
})

let h: FakeHerdr
let mode: ReapMode
let now: number
let logs: string[]
let traced: TraceRow[]
let tasks: DispatchTask[] | null
let envs: Map<string, string[]>
let brainSessions: Pick<Session, "key" | "taskId" | "herdrPane">[]
let proposalId: string

function make() {
  return mod.createBrainWorkers({
    herdr: h,
    envOf: async (pid) => envs.get(pid) ?? null,
    sessions: () => brainSessions,
    proposalOf: (id) => { const t = chat.getTaskByDispatchId(id); return t ? { proposalId: t.taskId, threadId: t.threadId } : null },
    snapshot: () => tasks,
    cached: (id) => tasks?.find((t) => t.id === id) ?? null,
    fetchTask: async () => null,
    mode: () => mode,
    now: () => now,
    log: (m) => logs.push(m),
    trace: (rows) => traced.push(...rows),
  })
}

/** A brain-proposed task filed as `dispatchId`, with its agent row on the trace. */
function brainProposal(dispatchId: string, thread = "brain"): string {
  const p = chat.createProposal("do it", "", "why", thread, { noteId: "projects/x", agent: "builder", title: "t" })
  chat.stampDispatchId(p.taskId, dispatchId)
  trace.upsertRow({ id: trace.rowId.agent(p.taskId), parentId: "repo:t1:x", turnId: "t1", kind: "agent", status: "running", title: "builder — t" })
  return p.taskId
}

beforeEach(() => {
  sqlite.exec("DELETE FROM orchestrator_tasks; DELETE FROM brain_trace")
  h = new FakeHerdr()
  mode = "observe"
  now = NOW
  logs = []
  traced = []
  brainSessions = []
  envs = new Map([
    ["100", ["COMPANION_TASK_ID=brain"]],
    ["200", [`DISPATCH_TASK_ID=${TASK}`, "DISPATCH_WORKER=1"]],
    ["300", [`DISPATCH_TASK_ID=${OTHER_TASK}`]],
    ["400", ["HOME=/home/j"]],
  ])
  tasks = [dtask(TASK, "completed", NOW - 3 * 60_000), dtask(OTHER_TASK, "completed", 0)]
  proposalId = brainProposal(TASK)
  // Jeremie's own sessions: never brain-owned.
  h.add("w30", "cc-work", { shellPid: 400, fg: 400 })
  h.add("w31", "builder-mac-wt-x", { shellPid: 400, fg: 400 })
  h.add("w32", "tko-mac-a617f2e8", { shellPid: 400, fg: 400 })
  h.add("w50", "dispatch-01234567", { shellPid: 200, fg: 999, agentStatus: "done" })
})

describe("worker sweep", () => {
  test("observe → no `workspace close`, one `would close` log per workspace", async () => {
    const w = make()
    for (let i = 0; i < 4; i++) await w.tick()
    expect(h.closes()).toEqual([])
    expect(logs.filter((l) => l.includes("would close"))).toEqual([expect.stringContaining("would close w50 (dispatch-01234567)")])
    expect(h.ws.size).toBe(4)
  })

  test("on → exactly one close after two settled sweeps, preceded by `workspace get`", async () => {
    mode = "on"
    const w = make()
    await w.tick()
    expect(h.closes()).toEqual([])
    await w.tick()
    await w.tick()
    expect(h.closes()).toEqual(["w50"])
    const i = h.calls.findIndex((c) => c[0] === "workspace" && c[1] === "close")
    expect(h.calls[i - 1]).toEqual(["workspace", "get", "w50"])
    expect([...h.ws.keys()]).toEqual(["w30", "w31", "w32"])
  })

  test("the close adds a `worker:<proposalId>` row under `agent:<proposalId>`", async () => {
    mode = "on"
    const w = make()
    await w.tick()
    await w.tick()
    expect(traced).toHaveLength(1)
    expect(traced[0]).toMatchObject({
      id: `worker:${proposalId}`, parentId: `agent:${proposalId}`, kind: "worker", status: "done", title: "Closed worker",
      ref: { workspaceId: "w50", taskId: TASK },
    })
  })

  test("a fresh instance over the same db still proves ownership (no in-memory map)", async () => {
    make()
    const s = await make().survey()
    expect(s.sessions).toEqual([expect.objectContaining({ workspaceId: "w50", kind: "worker", taskId: TASK, proposalId })])
    expect(s.foreign).toBe(3)
  })

  test("within the 2-min grace, while running, and for a non-brain task → kept", async () => {
    mode = "on"
    tasks = [dtask(TASK, "completed", NOW - 60_000)]
    const w = make()
    for (let i = 0; i < 3; i++) await w.tick()
    expect(h.closes()).toEqual([])
    tasks = [dtask(TASK, "running", 0)]
    for (let i = 0; i < 3; i++) await w.tick()
    expect(h.closes()).toEqual([])
    brainProposal(OTHER_TASK, "general")
    h.add("w51", "dispatch-fedcba98", { shellPid: 300, fg: 300 })
    tasks = [dtask(OTHER_TASK, "completed", 0)]
    for (let i = 0; i < 3; i++) await w.tick()
    expect(h.closes()).toEqual([])
  })

  test("a split appearing between survey and close → not closed", async () => {
    mode = "on"
    const w = make()
    await w.tick()
    const orig = h.call.bind(h)
    h.call = async (args) => {
      if (args[0] === "workspace" && args[1] === "get") h.ws.get("w50")!.panes.push({ id: "w50:p2", agentStatus: "unknown", shellPid: 1, fg: 1 })
      return orig(args)
    }
    await w.tick()
    expect(h.closes()).toEqual([])
  })

  test("the periodic sweep never touches a brain workspace", async () => {
    mode = "on"
    h.add("w34", "brain")
    const w = make()
    for (let i = 0; i < 3; i++) await w.tick()
    expect(h.closes()).toEqual(["w50"])
  })
})

describe("stopBrain / beforeSpawn", () => {
  test("crashed brain (agent absent) + stopBrain → the leftover closes only in on mode", async () => {
    h.add("w34", "brain")
    h.add("w35", "brain")
    await make().stopBrain()
    expect(h.closes()).toEqual([])
    expect(logs.filter((l) => l.includes("would close"))).toHaveLength(2)
    mode = "on"
    await make().stopBrain()
    expect(h.closes().sort()).toEqual(["w34", "w35"])
  })

  test("the live brain's workspace and a brain session's pane are never swept", async () => {
    mode = "on"
    h.add("w34", "brain")
    h.add("w40", "brain", { fg: 777 })
    h.add("w41", "brain")
    h.brainAgent = { kind: "present", ws: "w40", pane: "w40:p1" }
    brainSessions = [{ key: "herdr:w41:p1", taskId: "brain", herdrPane: "w41:p1" }]
    await make().beforeSpawn()
    expect(h.closes()).toEqual(["w34"])
  })

  test("stopBrain stops a present agent and closes its workspace (as before), then sweeps", async () => {
    mode = "on"
    h.add("w34", "brain")
    h.add("w40", "brain", { fg: 777 })
    h.brainAgent = { kind: "present", ws: "w40", pane: "w40:p1" }
    await make().stopBrain()
    expect(h.calls.some((c) => c[0] === "agent" && c[1] === "stop")).toBe(true)
    expect(h.closes()).toEqual(["w40", "w34"])
  })

  test("herdr can't say where the brain is → no sweep", async () => {
    mode = "on"
    h.add("w34", "brain")
    h.brainAgent = { kind: "error" }
    const w = make()
    await w.stopBrain()
    await w.beforeSpawn()
    expect(h.closes()).toEqual([])
  })
})

describe("routes: /hooks/brain/sessions and GET /api/brain/workers", () => {
  const BRAIN = { key: "herdr:p_brain", sessionId: "sid-brain", taskId: "brain", pid: "5150", herdrPane: "p_brain" } as unknown as Session
  const OTHER = { key: "tty:x", sessionId: "sid-x", taskId: "", pid: "6060", herdrPane: "" } as unknown as Session
  const AUTH = { "x-companion-task-id": "brain", "x-companion-pid": "5150" }

  async function call(body: unknown, opts: { peer?: string; headers?: Record<string, string>; path?: string; method?: string } = {}) {
    const handler = route.createBrainRoute({
      wiring: { status: () => ({ sessionKey: BRAIN.key }) } as unknown as BrainWiring,
      sessions: () => [BRAIN, OTHER], enabled: () => true, workers: make(),
    })
    const req = new Request(`http://localhost:4245${opts.path ?? "/hooks/brain/sessions"}`, {
      method: opts.method ?? "POST", headers: { "content-type": "application/json", ...(opts.headers ?? AUTH) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    vault.recordPeer(req, opts.peer ?? "127.0.0.1")
    const res = (await handler(req, new URL(req.url)))!
    return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> }
  }

  test("403 for a non-loopback peer, a wrong pid, a missing task header", async () => {
    expect((await call({ op: "list" }, { peer: "100.64.0.9" })).status).toBe(403)
    expect((await call({ op: "list" }, { headers: { ...AUTH, "x-companion-pid": "6060" } })).status).toBe(403)
    expect((await call({ op: "list" }, { headers: { "x-companion-pid": "5150" } })).status).toBe(403)
  })

  test("list returns brain-owned workspaces only", async () => {
    h.add("w34", "brain")
    const r = await call({ op: "list" })
    expect(r.status).toBe(200)
    expect(r.json.mode).toBe("observe")
    const ids = (r.json.sessions as Array<{ workspaceId: string }>).map((s) => s.workspaceId).sort()
    expect(ids).toEqual(["w34", "w50"])
  })

  test("close: 404 not_owned for cc-*, 409 running, 409 observe_only, 200 in on mode", async () => {
    expect(await call({ op: "close", workspaceId: "w30" })).toEqual({ status: 404, json: { ok: false, error: "not_owned" } })
    tasks = [dtask(TASK, "running", 0)]
    expect((await call({ op: "close", workspaceId: "w50" })).json).toMatchObject({ error: "running" })
    tasks = [dtask(TASK, "completed", NOW)]
    const obs = await call({ op: "close", workspaceId: "w50" })
    expect(obs).toMatchObject({ status: 409, json: { error: "observe_only", verdict: "close" } })
    expect(h.closes()).toEqual([])
    mode = "on"
    expect(await call({ op: "close", workspaceId: "w50" })).toMatchObject({ status: 200, json: { ok: true, closed: "w50" } })
    expect(h.closes()).toEqual(["w50"])
    expect((await call({ op: "close", workspaceId: "w50" })).json).toMatchObject({ ok: true, gone: true })
  })

  test("close of the live brain's own workspace → 409 self", async () => {
    mode = "on"
    h.add("w40", "brain", { fg: 777 })
    h.brainAgent = { kind: "present", ws: "w40", pane: "w40:p1" }
    expect((await call({ op: "close", workspaceId: "w40" })).json).toMatchObject({ error: "self" })
    expect(h.closes()).toEqual([])
  })

  test("GET /api/brain/workers: Bearer-gated, counts foreign workspaces without naming them", async () => {
    expect((await call(undefined, { path: "/api/brain/workers", method: "GET", headers: {} })).status).toBe(401)
    const { getAuthToken } = await import("../lib/auth")
    const r = await call(undefined, { path: "/api/brain/workers", method: "GET", headers: { authorization: `Bearer ${getAuthToken()}` } })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, mode: "observe", foreign: 3 })
    expect(JSON.stringify(r.json)).not.toContain("cc-work")
  })
})
