import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExecFn, QueryFn, Row, SqlArg } from "../lib/turso"
import type { GhFn } from "../lib/triage-pr"
import type { ResolverConfig } from "../lib/resolver"

// The Opus resolver end to end through the REAL wiring: triage collectors →
// resolver (mock model only) → the guarded unblock / gh merge / gh close →
// Turso rows (task, dispatch ledger, resolver:* activity), orchestrator turns,
// GET /api/orchestrator/triage (`resolving[]`, `resolver`, ask_opus) and
// POST …/choose ask_opus. Same harness as triage.test.ts: isolated
// COMPANION_DB_PATH, "Turso" = in-memory bun:sqlite, a fake gh.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-resolver-")), "companion.db")

const savedHome = process.env.HOME
const tempHome = mkdtempSync(join(tmpdir(), "cc-resolver-home-"))
mkdirSync(join(tempHome, ".claude", "agents"), { recursive: true })
writeFileSync(join(tempHome, ".claude", "agents", "builder.md"), "---\n---\n")
const dispatchRun = join(tempHome, "dispatch-run.ts")
writeFileSync(dispatchRun, "const REPO_MAP = []\n")

let poller: typeof import("../lib/dispatch-poller")
let mirror: typeof import("../lib/dispatch-mirror")
let chat: typeof import("../lib/orchestrator-chat")
let channels: typeof import("../lib/orchestrator-channels")
let triageWiring: typeof import("../wiring/triage")
let triageRoute: typeof import("./triage")
let invLib: typeof import("../lib/body-investigate")

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
const row = (id: string) => turso.query("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, any>
// Other route test files share the companion.db (Bun's module cache): their pending proposals reach the
// resolver too (the mock fails them), so every assertion is scoped to this file's rows.
const activity = (action: string, target?: string) => (turso.query("SELECT * FROM agent_activity WHERE action = ? ORDER BY id").all(action) as Record<string, any>[])
  .filter((r) => target === undefined || r.target_id === target)
const promptFor = (needle: string) => prompts.find((p) => p.includes(needle)) ?? ""

let seq = 0
const hex = () => (++seq).toString(16).padStart(32, "e")
function blockedTask(text: string, blocker: string): string {
  const id = hex()
  turso.query("INSERT INTO tasks (id, note_id, text, description, assignee, dispatch_status, dispatch_blocker) VALUES (?, 'projects/dash', ?, 'Original brief', 'agent:builder', 'blocked', ?)").run(id, text, blocker)
  return id
}
function parkedPr(n: number, reason: string): { id: string; url: string } {
  const id = hex()
  const url = `https://github.com/jaubut/tls-review/pull/${n}`
  turso.query("INSERT INTO tasks (id, note_id, text, assignee, dispatch_status, dispatch_pr_url) VALUES (?, 'projects/dash', ?, 'agent:builder', 'pr', ?)").run(id, `PR task ${n}`, url)
  turso.query("INSERT INTO agent_activity (agent_slug, action, target_kind, target_id, summary, meta) VALUES ('pr-shepherd', 'pr:needs-human', 'task', ?, ?, ?)")
    .run(id, `tls-review#${n}: ${reason}`, JSON.stringify({ reason, url, pr: n, repo: "tls-review" }))
  return { id, url }
}

// ── fakes: gh + the model ────────────────────────────────────────────────────

const prFiles = new Map<string, string[]>()
const prState = new Map<string, string>()
const ghCalls: string[][] = []
const gh: GhFn = async (args) => {
  ghCalls.push(args)
  const url = args[2] ?? ""
  if (args[1] === "view" && args[4] === "state") return { code: 0, stdout: JSON.stringify({ state: prState.get(url) ?? "OPEN" }), stderr: "" }
  if (args[1] === "view") return { code: 0, stdout: JSON.stringify({ title: "PR", headRefName: "dispatch/ab12", baseRefName: "main", files: (prFiles.get(url) ?? []).map((path) => ({ path, additions: 3, deletions: 1 })) }), stderr: "" }
  if (args[1] === "diff") return { code: 0, stdout: "diff --git a/x b/x\n+change", stderr: "" }
  if (args[1] === "checks") return { code: 0, stdout: "test\tpass", stderr: "" }
  if (args[1] === "merge") prState.set(url, "MERGED")
  if (args[1] === "close") prState.set(url, "CLOSED")
  return { code: 0, stdout: "", stderr: "" }
}

/** The mock Opus: the reply for the first rule whose needle the prompt contains. */
let rules: { needle: string; reply: Record<string, unknown> }[] = []
const prompts: string[] = []
const reply = (o: Record<string, unknown>) => ({ analysis: "Evidence from the repo.", summary: "s", confidence: 0.95, needsJeremie: false, why: "none", category: "", action: { kind: "none" }, ...o })

const cfg: ResolverConfig = { enabled: true, model: "claude-opus-5-5", maxConcurrent: 10, maxPerDay: 100, timeoutMs: 60_000, queueMaxMs: 60_000, dryRun: false }

function makeHarness() {
  const w = poller.createDispatchWiring({
    query, exec, broadcast: () => {},
    appendTurn: (text, taskId, ch) => chat.appendTurn("orchestrator", text, taskId, ch),
    push: () => {}, pushEnabled: () => false,
    linkedNotes: channels.linkedNotes, getChannel: channels.getChannel,
    localQueue: () => ({ cap: 3, live: 0, queued: 0 }),
    liveIdentity: () => null, log: () => {}, mirror, generalChannel: "general",
  })
  const engine = triageWiring.createLiveTriage({
    dispatch: w, gh, model: async () => null, severity: async () => null,
    investigations: () => invLib.createInvestigationStore(new Database(":memory:")),
    body: { get: async () => ({ components: [] }) } as never, trips: null, broadcast: () => {},
    resolverLive: {
      db: new Database(":memory:"), config: () => cfg,
      overrides: {
        analyze: async (prompt) => {
          prompts.push(prompt)
          const hit = rules.find((r) => prompt.includes(r.needle))
          return hit ? { ok: true, text: JSON.stringify(hit.reply) } : { ok: false, error: "no mock for this item" }
        },
      },
    },
  })
  return { w, engine, handler: triageRoute.createTriageHandler(() => engine) }
}
let h: ReturnType<typeof makeHarness>

async function get() {
  const req = new Request("http://localhost/api/orchestrator/triage")
  return await (await h.handler(req, new URL(req.url)))!.json() as { items: any[]; resolving: any[] }
}
async function choose(id: string, payload: Record<string, unknown>) {
  const req = new Request(`http://localhost/api/orchestrator/triage/${encodeURIComponent(id)}/choose`, { method: "POST", body: JSON.stringify(payload) })
  const res = await h.handler(req, new URL(req.url))
  return { status: res!.status, json: await res!.json() as Record<string, any> }
}
async function until(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const sync = async () => { await h.w.poll(); await h.engine.refresh() }

beforeAll(async () => {
  process.env.HOME = tempHome
  process.env.COMPANION_DISPATCH_RUN = dispatchRun
  chat = await import("../lib/orchestrator-chat")
  channels = await import("../lib/orchestrator-channels")
  mirror = await import("../lib/dispatch-mirror")
  poller = await import("../lib/dispatch-poller")
  invLib = await import("../lib/body-investigate")
  triageWiring = await import("../wiring/triage")
  triageRoute = await import("./triage")
})

afterAll(() => {
  delete process.env.COMPANION_DISPATCH_RUN
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
})

beforeEach(() => {
  turso.exec("DELETE FROM tasks; DELETE FROM agent_activity; DELETE FROM notes")
  turso.query("INSERT INTO notes (id, folder, title, ref_code, status, body) VALUES ('projects/dash', 'projects', 'Dashboard', 'PRJ-WCLS', 'active', 'Decision 2026-09-30: invoices round per line.')").run()
  rules = []
  prompts.length = 0
  ghCalls.length = 0
  prFiles.clear()
  prState.clear()
  h = makeHarness()
})

describe("blocked task", () => {
  test("hidden while Opus works it; a confident answer goes through the guarded unblock, with activity + turn", async () => {
    const id = blockedTask("Invoice rounding", "Round per line or on the total?")
    rules = [{ needle: "Round per line or on the total?", reply: reply({ action: { kind: "answer", text: "Round per line (project note decision 2026-09-30)." }, summary: "Answered from the project note" }) }]
    await sync()
    const first = await get()
    expect(first.items.some((i) => i.refId === id)).toBe(false)
    expect(first.resolving.find((r) => r.id === `task:${id}`)).toMatchObject({ resolver: { status: "resolving", model: "claude-opus-5-5" } })
    await until(() => row(id).dispatch_status === "queued")
    expect(promptFor("Round per line or on the total?")).toContain("Decision 2026-09-30: invoices round per line.")
    expect(row(id).description).toContain("Round per line (project note decision 2026-09-30).")
    await until(() => activity("resolver:answer", id).length === 1)
    expect(activity("resolver:answer", id)[0]).toMatchObject({ agent_slug: "opus-resolver", target_kind: "task", target_id: id, summary: "Opus answered: Round per line (project note decision 2026-09-30)." })
    expect(activity("dispatch:queued", id)).toHaveLength(1)
    expect(chat.getThread(h.w.threadIdFor(h.w.cached(id)!)).some((t) => t.text.startsWith("🤖 Opus answered") && t.text.includes("Round per line"))).toBe(true)
    await sync()
    const after = await get()
    expect(after.items.some((i) => i.refId === id)).toBe(false)
    expect(after.resolving.some((r) => r.id === `task:${id}`)).toBe(false)
  })

  test("a preference → Opus's card (its answer recommended, Ask Opus last); ask_opus 'do it' then answers it", async () => {
    const id = blockedTask("Homepage tagline", "Which tagline: A or B?")
    rules = [
      { needle: 'instruction: "do it"', reply: reply({ action: { kind: "answer", text: "Tagline A" } }) },
      { needle: "Which tagline: A or B?", reply: reply({ action: { kind: "answer", text: "Tagline A" }, needsJeremie: true, why: "client_wording", confidence: 0.6, summary: "Client-facing wording: your call; A matches the brief" }) },
    ]
    await sync()
    await until(async () => { await h.engine.refresh(); return (await get()).items.some((i) => i.refId === id) })
    const card = (await get()).items.find((i) => i.refId === id)
    expect(card.resolver).toMatchObject({ status: "prepared", summary: "Client-facing wording: your call; A matches the brief", model: "claude-opus-5-5" })
    expect(card.options[0].action).toEqual({ kind: "answer", text: "Tagline A" })
    expect(card.options.at(-1)).toMatchObject({ id: "opus", action: { kind: "ask_opus" } })
    expect(row(id).dispatch_status).toBe("blocked")
    expect(activity("resolver:prepared", id)).toHaveLength(1)
    const res = await choose(`task:${id}`, { optionId: "opus", text: "do it" })
    expect(res).toMatchObject({ status: 200, json: { ok: true, detail: { resolver: "resolving" } } })
    await until(() => row(id).dispatch_status === "queued")
    expect(row(id).description).toContain("Tagline A")
  })
})

describe("parked PR", () => {
  test("sensitive: reviewed, never merged on its own; 'do it' on the card merges through the guarded merge", async () => {
    const pr = parkedPr(21, "touches server/lib/auth.ts — needs your review")
    prFiles.set(pr.url, ["server/lib/auth.ts"])
    const review = { whatChanged: "cookie flags", risk: "session fixation", prodFailure: "users logged out", testsCover: "auth.test.ts", problems: [], verdict: "safe" }
    rules = [{ needle: "pull/21", reply: reply({ action: { kind: "merge" }, category: "safe", review, summary: "safe to merge because auth.test.ts covers the cookie path" }) }]
    await sync()
    await until(async () => { await h.engine.refresh(); return (await get()).items.some((i) => i.id === "pr:jaubut/tls-review#21") })
    expect(ghCalls.some((c) => c[1] === "merge")).toBe(false)
    expect(promptFor("pull/21")).toContain("SENSITIVE: touches server/lib/auth.ts")
    const card = (await get()).items.find((i) => i.id === "pr:jaubut/tls-review#21")
    expect(card.resolver.summary).toBe("Opus reviewed: safe to merge because auth.test.ts covers the cookie path")
    expect(card.options[0].action.kind).toBe("merge")
    expect(card.context).toContain("Could fail in prod: users logged out")
    expect(await choose("pr:jaubut/tls-review#21", { optionId: "opus", text: "do it" })).toMatchObject({ status: 200 })
    await until(() => row(pr.id).done === 1)
    expect(prState.get(pr.url)).toBe("MERGED")
    expect(activity("outcome:merged", pr.id)).toHaveLength(1)
    await until(() => activity("resolver:merge", pr.id).length === 1)
  })

  test("stale, not sensitive: Opus comments why and closes it; the reason is recorded", async () => {
    const pr = parkedPr(22, "stale (no activity for 15 days)")
    prFiles.set(pr.url, ["src/uploads.ts"])
    rules = [{ needle: "pull/22", reply: reply({ action: { kind: "close_pr", reason: "stale: the upload rewrite in #30 replaced it" }, category: "stale" }) }]
    await sync()
    await until(() => prState.get(pr.url) === "CLOSED")
    expect(ghCalls.find((c) => c[1] === "comment")).toEqual(["pr", "comment", pr.url, "--body", "🤖 **Opus resolver** — closing this PR: stale: the upload rewrite in #30 replaced it"])
    expect(activity("outcome:rejected", pr.id)).toHaveLength(1)
    await until(() => activity("resolver:close_pr", pr.id).length === 1)
    expect(activity("resolver:close_pr", pr.id)[0]!.summary).toBe("Opus closed the PR: stale: the upload rewrite in #30 replaced it")
    await sync()
    expect((await get()).items.some((i) => i.id === "pr:jaubut/tls-review#22")).toBe(false)
  })
})

describe("fall-through", () => {
  test("an Opus failure → the normal card, marked failed; nothing lost", async () => {
    const id = blockedTask("Mystery", "What now?")
    await sync()
    await until(async () => { await h.engine.refresh(); return (await get()).items.some((i) => i.refId === id) })
    const card = (await get()).items.find((i) => i.refId === id)
    expect(card.resolver).toMatchObject({ status: "failed", summary: "Opus run failed: no mock for this item" })
    expect(card.options[0].action.kind).toBe("answer_custom")
    expect(activity("resolver:failed", id)).toHaveLength(1)
  })
})
