import { beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TraceRow } from "./brain-trace"
import type { SpawnWorkerOpts } from "./worker-supervisor"

// Headless worker progress → one live brain_trace card per turn (lib/worker-progress-trace.ts).

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-worker-progress-")), "test.db")

let mod: typeof import("./worker-progress-trace")
let sup: typeof import("./worker-supervisor")
let sqlite: typeof import("./orchestrator-db")["db"]

beforeAll(async () => {
  mod = await import("./worker-progress-trace")
  sup = await import("./worker-supervisor")
  sqlite = (await import("./orchestrator-db")).db
})
beforeEach(() => sqlite.exec("DELETE FROM brain_trace"))

function harness() {
  let clock = 1_700_000_000_000
  const cards: TraceRow[] = []
  const wakes: string[] = []
  const timers: Array<() => void> = []
  const progress = mod.createWorkerProgressTrace({ host: "zettlab", now: () => clock, trace: (rows) => cards.push(...rows), schedule: (fn) => { timers.push(fn) } })
  const home = mkdtempSync(join(tmpdir(), "cc-worker-progress-home-"))
  mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
  const spawned: SpawnWorkerOpts[] = []
  const supervisor = sup.createWorkerSupervisor({
    host: "zettlab", home, killGraceMs: 50, isPidAlive: () => false, now: () => clock, uuid: () => "eeee1111-2222-4333-8444-555555555555",
    trust: () => {}, reportJob: () => {},
    onTaskProgress: (t) => progress.update(t),
    onTaskTerminal: (t) => { progress.finish(t); wakes.push(mod.receiptText(t)) },
    sh: async (_cmd, args) => {
      if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
      return { ok: true, out: "origin/main\n", err: "", code: 0 }
    },
    spawnWorker: (opts) => { spawned.push(opts); return { pid: 9191, kill() {} } },
  })
  return { cards, wakes, timers, supervisor, spawned, home, tick: (ms: number) => { clock += ms } }
}

const cmd = (command: string): string => JSON.stringify({ type: "item.started", item: { type: "command_execution", command } })
const said = (text: string): string => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })

test("3 codex status updates, 2 identical → 2 card updates on one row, no brain wake", async () => {
  const h = harness()
  try {
    await h.supervisor.dispatchTask({ taskId: "prog-1", repo: "claude-companion", prompt: "Ship it", family: "codex" })
    const before = h.cards.length
    const out = h.spawned[0]!
    h.tick(11_000); out.onStdoutLine(cmd("bun test"))
    h.tick(11_000); out.onStdoutLine(cmd("bun test"))
    h.tick(11_000); out.onStdoutLine(said("Tests pass, opening the PR"))
    const updates = h.cards.slice(before)
    expect(updates).toHaveLength(2)
    expect(new Set(h.cards.map((r) => r.id))).toEqual(new Set(["headless:prog-1"]))
    expect(updates[1]).toMatchObject({ kind: "agent", status: "running", ref: { taskId: "prog-1", host: "zettlab" } })
    expect(updates[1]!.title).toContain("codex")
    expect(updates[1]!.detail).toContain("Tests pass, opening the PR")
    expect(updates[1]!.detail).toContain("33s")
    expect(h.wakes).toEqual([])
  } finally {
    rmSync(h.home, { recursive: true, force: true })
  }
})

test("throttle: a change inside 10 s waits for the trailing flush, which writes only the latest", async () => {
  const h = harness()
  try {
    await h.supervisor.dispatchTask({ taskId: "prog-2", repo: "claude-companion", prompt: "Ship it", family: "gemini" })
    const before = h.cards.length
    const out = h.spawned[0]!
    h.tick(2_000); out.onStdoutLine(cmd("bun test"))
    h.tick(2_000); out.onStdoutLine(cmd("bun run lint"))
    expect(h.cards.length).toBe(before)
    expect(h.timers).toHaveLength(1)
    h.tick(6_000); h.timers.shift()!()
    expect(h.cards.length).toBe(before + 1)
    expect(h.cards.at(-1)!.detail).toContain("lint")
  } finally {
    rmSync(h.home, { recursive: true, force: true })
  }
})

test("the card collapses into the receipt at the end; a pending flush can't reopen it", async () => {
  const h = harness()
  try {
    await h.supervisor.dispatchTask({ taskId: "prog-3", repo: "claude-companion", prompt: "Ship it", family: "claude" })
    const out = h.spawned[0]!
    h.tick(1_000); out.onStdoutLine(cmd("bun test"))
    out.onStdoutLine(JSON.stringify({ type: "result", result: "Done https://github.com/jaubut/claude-companion/pull/42" }))
    out.onExit(0, null)
    for (const fn of h.timers.splice(0)) fn()
    const last = h.cards.at(-1)!
    expect(last).toMatchObject({ id: "headless:prog-3", status: "done" })
    expect(last.detail).toStartWith("PR ready [prog-3]")
    expect(h.wakes).toHaveLength(1)
    expect(h.wakes[0]).toStartWith("PR ready [prog-3]")
    expect(h.cards.filter((r) => r.status === "done")).toHaveLength(1)
  } finally {
    rmSync(h.home, { recursive: true, force: true })
  }
})

test("a failed turn collapses to an error card with the blocked receipt; an interrupt closes the card too", async () => {
  const h = harness()
  try {
    await h.supervisor.dispatchTask({ taskId: "prog-4", repo: "claude-companion", prompt: "Ship it", family: "codex" })
    h.spawned[0]!.onExit(1, null)
    expect(h.cards.at(-1)).toMatchObject({ id: "headless:prog-4", status: "error" })
    expect(h.cards.at(-1)!.detail).toStartWith("blocked [prog-4]")

    await h.supervisor.dispatchTask({ taskId: "prog-5", repo: "claude-companion", prompt: "Ship it", family: "codex" })
    await h.supervisor.interruptTask("prog-5")
    expect(h.cards.at(-1)).toMatchObject({ id: "headless:prog-5", status: "error", detail: "Interrupted" })
    expect(h.wakes).toHaveLength(1)
  } finally {
    rmSync(h.home, { recursive: true, force: true })
  }
})
