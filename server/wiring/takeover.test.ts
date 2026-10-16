import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DispatchColumns, DispatchTask } from "../lib/dispatch-tasks"
import type { Herdr } from "../lib/herdr"
import type { RepoEntry } from "../lib/live-repo"
import type { ShFn } from "../lib/resolver-fix"
import type { SpawnResult } from "../lib/spawn-session"
import type { SourceItem } from "../lib/triage"
import { type ExecFn, type QueryFn, type Row, type SqlArg, TursoUnreachable } from "../lib/turso"
import type { DispatchWiring } from "./dispatch"

// The takeover run, wired: fake Turso (in-memory bun:sqlite behind QueryFn /
// ExecFn), fake herdr / spawn / git / gh / peer, the run store on its own
// :memory: db. Nothing spawns a real session, runs git or reaches a network.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-takeover-")), "test.db")

let tk: typeof import("./takeover")
let storeMod: typeof import("../lib/takeover-store")
let triageSources: typeof import("../lib/triage-sources")
let tasks: typeof import("../lib/dispatch-tasks")

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
let down = false
const exec: ExecFn = async (sql: string, args: SqlArg[]) => {
  if (down) throw new TursoUnreachable("network")
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { rows: turso.query(sql).all(...args) as Row[], affected: 0 }
  return { rows: [], affected: turso.query(sql).run(...args).changes }
}
const query: QueryFn = async (sql, args) => (await exec(sql, args)).rows
const cols: DispatchColumns = { prUrl: true, resultRef: true }
const tursoTask = (id: string) => turso.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown>
const ledger = (id: string) => (turso.query("SELECT action FROM agent_activity WHERE target_id = ? ORDER BY id").all(id) as { action: string }[]).map((r) => r.action)

const applied: DispatchTask[] = []
const dispatch = {
  query, exec, columns: async () => cols, threadIdFor: () => "general", applyLocal: (t: DispatchTask) => { applied.push(t) }, cached: () => null,
} as unknown as DispatchWiring

// ── fakes ────────────────────────────────────────────────────────────────────

const REPO = "/h/claude-companion"
const entries: RepoEntry[] = [
  { name: "claude-companion", match: /companion/i, path: REPO },
  { name: "tls-dashboard-v2", match: /dashboard/i, path: "/h/tls-dashboard-v2" },
]
let gate: string | null = null
const agents = new Set<string>()
const closed: string[] = []
let paneAtShell = true
// One workspace per agent: ws-<name>, pane <name>:p1, labelled with the name.
const herdr: Herdr = {
  async call(args) {
    if (args[0] === "agent" && args[1] === "get") {
      const n = args[2]!
      if (agents.has(n)) return { agent: { agent_status: "idle", pane_id: `${n}:p1`, workspace_id: `ws-${n}`, terminal_id: `term-${n}` } }
      throw Object.assign(new Error("agent_not_found"), { code: "agent_not_found" })
    }
    const n = (args[2] ?? args[3] ?? "").replace(/^ws-/, "").replace(/:p1$/, "")
    if (args[0] === "pane" && args[1] === "get") return { pane: { workspace_id: `ws-${n}`, terminal_id: `term-${n}` } }
    if (args[0] === "workspace" && args[1] === "get") return { workspace: { pane_count: 1, label: n } }
    if (args[0] === "pane" && args[1] === "process-info") return { process_info: paneAtShell ? { shell_pid: 42, foreground_process_group_id: 42 } : { shell_pid: 42, foreground_process_group_id: 7 } }
    if (args[0] === "workspace" && args[1] === "close") {
      closed.push(args[2]!)
      agents.delete(args[2]!.replace(/^ws-/, ""))
    }
    return {}
  },
  async read() { return null },
  async gate() { return gate },
}
const dirs = new Set<string>()
const shCalls: string[] = []
let prList = "[]"
let prHead = "takeover/aaaaaaaa"
let fetchFails = false
const sh: ShFn = async (cmd, args) => {
  shCalls.push(`${cmd} ${args.join(" ")}`)
  if (cmd === "gh" && args[1] === "view") return { ok: true, code: 0, out: JSON.stringify({ headRefName: prHead }), err: "" }
  if (cmd === "gh") return { ok: true, code: 0, out: prList, err: "" }
  if (args.includes("fetch") && fetchFails) return { ok: false, code: 1, out: "", err: "fatal: denied" }
  if (args.includes("symbolic-ref")) return { ok: true, code: 0, out: "origin/main\n", err: "" }
  if (args.includes("rev-parse")) return { ok: false, code: 1, out: "", err: "" }
  if (args.includes("worktree") && args.includes("add")) dirs.add(args.find((a) => a.includes("/tko-"))!)
  return { ok: true, code: 0, out: "", err: "" }
}
const spawns: Parameters<typeof import("../lib/spawn-session").spawnCompanionSession>[0][] = []
let spawnGate: Promise<void> = Promise.resolve()
let spawnResult: SpawnResult = { ok: true, app: "herdr", herdrPane: "w9:p1" }
const delivered: string[] = []
let deliverFailures = 0
const turns: string[] = []
const sessions: { key: string; taskId: string }[] = []
const fetches: { url: string; body: Record<string, unknown> }[] = []
let peerAnswer: () => Response = () => Response.json({ ok: false, error: "no_checkout" }, { status: 409 })

const NAME = "tko-zettlab-aaaaaaaa"
const ID = "a".repeat(32)
const SEEN = "2026-10-16 10:00:00"
const VERSION = `blocked|${SEEN}`

function seedTask(id = ID, blocker = "No local repo mapped — how-to: RES-AB12", title = "Fix the companion poller"): void {
  turso.query("DELETE FROM tasks WHERE id = ?").run(id)
  turso.query(
    "INSERT INTO tasks (id, note_id, text, description, assignee, dispatch_status, dispatch_blocker, dispatch_owner, updated_at) VALUES (?, 'projects/x', ?, 'Poll every 20 s', 'agent:builder', 'blocked', ?, 'zettlab', ?)",
  ).run(id, title, blocker, SEEN)
}

const start = (over: Partial<import("./takeover").StartInput> = {}) =>
  tk.startTakeover({ taskId: ID, version: VERSION, repo: "claude-companion", by: "triage", ...over })

beforeAll(async () => {
  tk = await import("./takeover")
  storeMod = await import("../lib/takeover-store")
  triageSources = await import("../lib/triage-sources")
  tasks = await import("../lib/dispatch-tasks")
})

beforeEach(() => {
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.query("INSERT INTO notes (id, ref_code, body) VALUES ('resources/how', 'RES-AB12', 'How-to: map the repo first')").run()
  seedTask()
  for (const a of [applied, shCalls, spawns, delivered, turns, sessions, fetches]) a.length = 0
  agents.clear()
  dirs.clear()
  closed.length = 0
  paneAtShell = true
  prHead = "takeover/aaaaaaaa"
  gate = null
  down = false
  prList = "[]"
  fetchFails = false
  deliverFailures = 0
  spawnGate = Promise.resolve()
  spawnResult = { ok: true, app: "herdr", herdrPane: "w9:p1" }
  peerAnswer = () => Response.json({ ok: false, error: "no_checkout" }, { status: 409 })
  tk.setTakeoverDeps({
    dispatch: () => dispatch,
    store: (() => { const s = storeMod.createTakeoverStore(new Database(":memory:")); return () => s })(),
    localHost: () => "zettlab",
    entries: () => entries,
    canRun: () => true,
    isDir: (p) => p === REPO || dirs.has(p),
    herdr,
    spawn: async (opts) => {
      spawns.push(opts)
      await spawnGate
      if (spawnResult.ok && opts.herdr) agents.add(opts.herdr.name)
      return spawnResult
    },
    deliver: async (_pane, text) => {
      if (deliverFailures-- > 0) return { ok: false, blocked: false, reason: "agent_not_ready" }
      delivered.push(text)
      return { ok: true }
    },
    sh,
    peer: () => ({ base: "https://mac.tail.ts.net", token: "t" }),
    fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
      fetches.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
      if (fetchFails) throw new TypeError("fetch failed")
      return peerAnswer()
    }) as typeof fetch,
    sessions: () => sessions,
    logs: () => [],
    root: () => "/h/.claude-companion/takeover",
    turn: (text) => { turns.push(text) },
    writeCtx: async (d) => ({ exec: d.exec, cols, host: "zettlab", channel: null }),
    now: Date.now,
    sleep: async () => {},
    log: () => {},
  })
})

afterAll(() => turso.close())

describe("start (claim-then-async)", () => {
  test("200 detail right after the claim, before herdr starts; then worktree → session → seed", async () => {
    let release!: () => void
    spawnGate = new Promise<void>((r) => { release = r })
    const out = await start()
    expect(out).toEqual({ ok: true, detail: {
      host: "zettlab", session: NAME, cwd: `/h/.claude-companion/takeover/${NAME}`, branch: "takeover/aaaaaaaa", dispatchTaskId: ID, status: "starting",
    } })
    expect(tursoTask(ID)).toMatchObject({ dispatch_status: "running", dispatch_owner: `companion:takeover:${NAME}`, dispatch_blocker: null })
    expect(delivered).toHaveLength(0)
    release()
    await tk.takeoverIdle()
    expect(shCalls).toContain(`git -C ${REPO} worktree add -b takeover/aaaaaaaa /h/.claude-companion/takeover/${NAME} origin/main`)
    expect(spawns[0]).toMatchObject({ cwd: `/h/.claude-companion/takeover/${NAME}`, agent: "claude", env: { COMPANION_TASK_ID: NAME }, herdr: { name: NAME, args: ["--remote-control", NAME] } })
    expect(delivered[0]).toContain("Fix the companion poller")
    expect(delivered[0]).toContain("How-to: map the repo first")
    expect(delivered[0]).toContain("No local repo mapped — how-to: RES-AB12")
    expect(turns.some((t) => t.includes(`session ${NAME} starting on Zettlab`))).toBe(true)
    expect(turns.some((t) => t.includes(`Takeover ${NAME} is ready`))).toBe(true)
    expect(ledger(ID)).toEqual(["dispatch:running"])
    expect(applied.at(-1)?.status).toBe("running")
  })

  test("two concurrent starts on one (task, version) → one claim, one run, the same detail; a retry later → replay", async () => {
    const [a, b] = await Promise.all([start(), start()])
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.detail.session).toBe(b.detail.session)
    expect([a.detail.replay, b.detail.replay].filter(Boolean)).toHaveLength(1)
    await tk.takeoverIdle()
    expect(ledger(ID)).toEqual(["dispatch:running"])
    expect(spawns).toHaveLength(1)
    const later = await start()
    expect(later).toMatchObject({ ok: true, detail: { session: NAME, replay: true, status: "active" } })
    expect(spawns).toHaveLength(1)
  })

  test("refusals are 409 and write nothing: stale version, no checkout, herdr down, name taken", async () => {
    expect(await start({ version: "blocked|old" })).toMatchObject({ ok: false, status: 409, error: "stale" })
    expect(await start({ repo: "tls-dashboard-v2" })).toMatchObject({ ok: false, status: 409, error: "no_checkout" })
    gate = "herdr-down: refused"
    expect(await start()).toMatchObject({ ok: false, status: 409, error: "herdr_unavailable", extra: { reason: "herdr-down: refused" } })
    gate = null
    agents.add(NAME)
    expect(await start()).toMatchObject({ ok: false, status: 409, error: "name_taken" })
    expect(tursoTask(ID).dispatch_status).toBe("blocked")
    expect(ledger(ID)).toEqual([])
  })

  test("Turso down before the claim → throws (the engine answers 503); the run is not left open", async () => {
    down = true
    await expect(start()).rejects.toBeInstanceOf(TursoUnreachable)
    down = false
    expect((await start()).ok).toBe(true)
  })

  test("a failed start → the task blocked again with why + the original blocker, and a turn", async () => {
    spawnResult = { ok: false, app: "herdr", error: "herdr agent start: timeout" }
    expect((await start()).ok).toBe(true)
    await tk.takeoverIdle()
    expect(tursoTask(ID)).toMatchObject({
      dispatch_status: "blocked", dispatch_blocker: "Takeover failed to start (herdr agent start: timeout) — No local repo mapped — how-to: RES-AB12",
    })
    expect(turns.at(-1)).toContain("Takeover failed to start")
    expect(ledger(ID)).toEqual(["dispatch:running", "dispatch:blocked"])
    expect((await start({ version: `blocked|${String(tursoTask(ID).updated_at)}` })).ok).toBe(true)
  })

  test("git fetch failing → failed start, no session", async () => {
    fetchFails = true
    await start()
    await tk.takeoverIdle()
    expect(spawns).toHaveLength(0)
    expect(String(tursoTask(ID).dispatch_blocker)).toStartWith("Takeover failed to start (git fetch: fatal: denied)")
  })

  test("seed: agent_not_ready retried; never delivered → a turn, the session stays", async () => {
    deliverFailures = 3
    await start()
    await tk.takeoverIdle()
    expect(delivered).toHaveLength(1)
    seedTask("b".repeat(32))
    deliverFailures = 99
    await start({ taskId: "b".repeat(32) })
    await tk.takeoverIdle()
    expect(turns.at(-1)).toContain("seed prompt was not delivered")
    expect(tursoTask("b".repeat(32)).dispatch_status).toBe("running")
  })
})

describe("completion", () => {
  async function running(): Promise<void> {
    await start()
    await tk.takeoverIdle()
  }

  test("Stop with a PR in the turn → completed + pr_url, once; the worktree goes when clean and pushed", async () => {
    await running()
    const pr = "https://github.com/jaubut/claude-companion/pull/171"
    await tk.takeoverStop(NAME, `Opened ${pr}`)
    await tk.takeoverStop(NAME, `Opened ${pr}`)
    expect(tursoTask(ID)).toMatchObject({ dispatch_status: "completed", dispatch_pr_url: pr })
    expect(ledger(ID)).toEqual(["dispatch:running", "dispatch:completed"])
    expect(turns.at(-1)).toContain(`opened ${pr}`)
    expect(shCalls).toContain(`git -C ${REPO} worktree remove /h/.claude-companion/takeover/${NAME}`)
  })

  test("Stop with TAKEOVER DONE: → completed without a PR; a plain turn changes nothing", async () => {
    await running()
    await tk.takeoverStop(NAME, "Looking into it")
    expect(tursoTask(ID).dispatch_status).toBe("running")
    await tk.takeoverStop(NAME, "Reloaded it.\nTAKEOVER DONE: reloaded the launchd job")
    expect(tursoTask(ID)).toMatchObject({ dispatch_status: "completed", dispatch_pr_url: null })
    expect(turns.at(-1)).toContain("done: reloaded the launchd job")
  })

  test("Stop finds the PR on the branch with gh (≤ 1 call / 30 s)", async () => {
    await running()
    await tk.takeoverStop(NAME, "pushed")
    prList = JSON.stringify([{ url: "https://github.com/jaubut/claude-companion/pull/172" }])
    await tk.takeoverStop(NAME, "pushed again")
    expect(tursoTask(ID).dispatch_status).toBe("running")
    expect(shCalls.filter((c) => c.startsWith("gh pr list --head takeover/aaaaaaaa"))).toHaveLength(1)
  })

  test("SessionEnd with no PR → blocked 'Takeover ended without a PR…', how-to ref kept; with a PR → completed", async () => {
    await running()
    await tk.takeoverEnded(NAME)
    expect(tursoTask(ID)).toMatchObject({ dispatch_status: "blocked", dispatch_blocker: "Takeover ended without a PR — No local repo mapped — how-to: RES-AB12" })
    expect(turns.at(-1)).toContain("ended without a PR")
    const src = triageSources.taskSource(tasks.fromRow({ ...tursoTask(ID), note_title: null, note_ref: null } as Row), "general")!
    expect(src.hints).toEqual({ takeoverEnded: true })
    seedTask("c".repeat(32))
    await start({ taskId: "c".repeat(32) })
    await tk.takeoverIdle()
    prList = JSON.stringify([{ url: "https://github.com/jaubut/claude-companion/pull/173" }])
    await tk.takeoverEnded("tko-zettlab-cccccccc")
    expect(tursoTask("c".repeat(32))).toMatchObject({ dispatch_status: "completed", dispatch_pr_url: "https://github.com/jaubut/claude-companion/pull/173" })
  })

  test("Stop naming an unrelated PR (gh: another head) → not completed; the branch's own PR still counts", async () => {
    await running()
    prHead = "dispatch/other-task"
    await tk.takeoverStop(NAME, "See https://github.com/jaubut/claude-companion/pull/99 from the old run")
    expect(tursoTask(ID)).toMatchObject({ dispatch_status: "running", dispatch_pr_url: null })
    expect(shCalls).toContain("gh pr view https://github.com/jaubut/claude-companion/pull/99 --json headRefName")
  })

  test("re-takeover after an ended run: the lingering agent's workspace is closed and the same name starts a new run", async () => {
    await running()
    sessions.push({ key: "k1", taskId: NAME })
    await tk.takeoverEnded(NAME) // session still registered: workspace kept
    expect(closed).toEqual([])
    sessions.length = 0
    expect(agents.has(NAME)).toBe(true) // autoclose off: the old agent lingers
    const v2 = `blocked|${String(tursoTask(ID).updated_at)}`
    expect(await start({ version: v2 })).toMatchObject({ ok: true, detail: { session: NAME, status: "starting" } })
    expect(closed).toEqual([`ws-${NAME}`])
    await tk.takeoverIdle()
    expect(tursoTask(ID)).toMatchObject({ dispatch_status: "running", dispatch_owner: `companion:takeover:${NAME}` })
    expect(spawns).toHaveLength(2)
  })

  test("a live agent of that name (open run, live session, or claude still in the pane) → 409 name_taken, nothing written", async () => {
    seedTask("d".repeat(32))
    agents.add("tko-zettlab-dddddddd") // no run row: not ours
    expect(await start({ taskId: "d".repeat(32) })).toMatchObject({ ok: false, status: 409, error: "name_taken" })
    await running()
    await tk.takeoverEnded(NAME)
    closed.length = 0
    agents.add(NAME)
    sessions.push({ key: "k1", taskId: NAME })
    const v2 = `blocked|${String(tursoTask(ID).updated_at)}`
    const before = ledger(ID)
    expect(await start({ version: v2 })).toMatchObject({ ok: false, status: 409, error: "name_taken" })
    sessions.length = 0
    paneAtShell = false
    expect(await start({ version: v2 })).toMatchObject({ ok: false, status: 409, error: "name_taken" })
    expect(tursoTask(ID).dispatch_status).toBe("blocked")
    expect(ledger(ID)).toEqual(before)
    expect(closed).toEqual([])
  })

  test("ended with the session gone → its workspace is released", async () => {
    await running()
    await tk.takeoverEnded(NAME)
    expect(closed).toEqual([`ws-${NAME}`])
    expect(agents.has(NAME)).toBe(false)
  })

  test("tick: herdr keeps the agent record but no session for 2 ticks → ended + workspace released; a session keeps it", async () => {
    await running()
    sessions.push({ key: "k1", taskId: NAME })
    for (let i = 0; i < 3; i++) await tk.takeoverTick()
    expect(tursoTask(ID).dispatch_status).toBe("running")
    sessions.length = 0
    expect(agents.has(NAME)).toBe(true)
    await tk.takeoverTick()
    expect(tursoTask(ID).dispatch_status).toBe("running")
    await tk.takeoverTick()
    expect(tursoTask(ID).dispatch_status).toBe("blocked")
    expect(closed).toEqual([`ws-${NAME}`])
  })

  test("tick: a fresh run never seen live keeps its start grace while herdr has the agent", async () => {
    await running()
    for (let i = 0; i < 3; i++) await tk.takeoverTick()
    expect(tursoTask(ID).dispatch_status).toBe("running")
  })

  test("tick: a live session keeps it; a dead pane (2 misses) ends it", async () => {
    await running()
    sessions.push({ key: "k1", taskId: NAME })
    agents.delete(NAME)
    await tk.takeoverTick()
    await tk.takeoverTick()
    expect(tursoTask(ID).dispatch_status).toBe("running")
    expect(tk.takeoverIdentity(ID)).toMatchObject({ localTaskId: NAME, sessionKey: "k1" })
    sessions.length = 0
    await tk.takeoverTick()
    expect(tursoTask(ID).dispatch_status).toBe("running")
    await tk.takeoverTick()
    expect(tursoTask(ID).dispatch_status).toBe("blocked")
    expect(tk.takeoverIdentity(ID)).toBeNull()
  })

  test("Turso down at the finish → the run stays finishing; the tick writes it later", async () => {
    await running()
    down = true
    await tk.takeoverEnded(NAME)
    down = false
    expect(tursoTask(ID).dispatch_status).toBe("running")
    await tk.takeoverTick()
    expect(tursoTask(ID).dispatch_status).toBe("blocked")
    expect(ledger(ID)).toEqual(["dispatch:running", "dispatch:blocked"])
  })
})

describe("choose (takeoverAction) and the peer hop", () => {
  function src(over: Partial<SourceItem> = {}): SourceItem {
    return {
      source: "task", refId: ID, version: VERSION, title: "Fix the companion poller", project: "Companion", createdAt: 1, updatedAt: 1,
      facts: { status: "blocked", agent: "builder", blocker: "No local repo mapped — how-to: RES-AB12" }, url: null,
      ref: { source: "task", taskId: ID, status: "blocked", channel: "general" },
      takeover: { repo: "claude-companion", host: "zettlab", pinned: false, candidates: [] }, ...over,
    }
  }

  test("local host first → done with the detail", async () => {
    const out = await tk.takeoverAction(src(), { kind: "takeover", repo: "claude-companion", host: "zettlab" }, null, "triage")
    expect(out).toMatchObject({ kind: "done", detail: { host: "zettlab", session: NAME, status: "starting" } })
    expect(fetches).toHaveLength(0)
    await tk.takeoverIdle()
  })

  test("no checkout here → the other host via the peer (hop header body), its detail returned", async () => {
    peerAnswer = () => Response.json({ ok: true, detail: { host: "mac", session: "tko-mac-aaaaaaaa", cwd: "/m", branch: "takeover/aaaaaaaa", dispatchTaskId: ID, status: "starting" } })
    const out = await tk.takeoverAction(src({ takeover: { repo: "tls-dashboard-v2", host: "zettlab", pinned: false, candidates: [] } }), { kind: "takeover", repo: "tls-dashboard-v2", host: "zettlab" }, null, "triage")
    expect(out).toMatchObject({ kind: "done", detail: { host: "mac", session: "tko-mac-aaaaaaaa" } })
    expect(fetches[0]).toMatchObject({ url: "https://mac.tail.ts.net/api/orchestrator/takeover", body: { taskId: ID, version: VERSION, repo: "tls-dashboard-v2", host: "mac" } })
  })

  test("both refuse → 409 no_checkout; peer unreachable → 409 host_unreachable (never 5xx)", async () => {
    const dash = src({ takeover: { repo: "tls-dashboard-v2", host: "zettlab", pinned: false, candidates: [] } })
    expect(await tk.takeoverAction(dash, { kind: "takeover", repo: "tls-dashboard-v2", host: "zettlab" }, null, "triage"))
      .toMatchObject({ kind: "error", status: 409, error: "no_checkout" })
    fetchFails = true
    expect(await tk.takeoverAction(dash, { kind: "takeover", repo: "tls-dashboard-v2", host: "zettlab" }, null, "triage"))
      .toMatchObject({ kind: "error", status: 409, error: "host_unreachable" })
  })

  test("a pinned Mac target from Zettlab → forwarded only, never started here", async () => {
    peerAnswer = () => Response.json({ ok: true, detail: { host: "mac", session: "tko-mac-aaaaaaaa", cwd: "/m", branch: "b", dispatchTaskId: ID, status: "starting" } })
    const pinned = src({ title: "Fix mac:launchd:com.tls.x: claude-companion", takeover: { repo: "claude-companion", host: "mac", pinned: true, candidates: [] } })
    expect(await tk.takeoverAction(pinned, { kind: "takeover", repo: "claude-companion", host: "mac" }, null, "triage")).toMatchObject({ kind: "done", detail: { host: "mac" } })
    expect(tursoTask(ID).dispatch_status).toBe("blocked")
  })

  test("ask: no repo and no / unknown text → 422 repo_required {candidates}; a typed map name is used", async () => {
    const cands = [{ repo: "claude-companion", host: "zettlab" as const }, { repo: "tls-dashboard-v2", host: "zettlab" as const }]
    const ask = src({ takeover: { repo: null, host: "zettlab", pinned: false, candidates: cands } })
    expect(await tk.takeoverAction(ask, { kind: "takeover", candidates: cands }, null, "triage"))
      .toEqual({ kind: "error", status: 422, error: "repo_required", extra: { candidates: cands } })
    expect(await tk.takeoverAction(ask, { kind: "takeover", candidates: cands }, "no-such-repo", "triage")).toMatchObject({ status: 422 })
    expect(await tk.takeoverAction(ask, { kind: "takeover", candidates: cands }, "Claude-Companion", "triage")).toMatchObject({ kind: "done", detail: { session: NAME } })
    await tk.takeoverIdle()
  })

  test("the peer endpoint refuses another host's run (not_owner) and answers Turso down with 503", async () => {
    expect(await tk.runPeerTakeover({ taskId: ID, version: VERSION, repo: "claude-companion", host: "mac", by: "triage" }))
      .toEqual({ status: 409, body: { ok: false, error: "not_owner" } })
    down = true
    expect((await tk.runPeerTakeover({ taskId: ID, version: VERSION, repo: "claude-companion", host: "zettlab", by: "triage" })).status).toBe(503)
    down = false
    expect(await tk.runPeerTakeover({ taskId: ID, version: VERSION, repo: "claude-companion", host: "zettlab", by: "triage" }))
      .toMatchObject({ status: 200, body: { ok: true, detail: { session: NAME } } })
    await tk.takeoverIdle()
  })
})
