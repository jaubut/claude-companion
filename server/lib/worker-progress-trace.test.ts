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

test("throttle: a change inside 1 s waits for the trailing flush, which writes only the latest", async () => {
  const h = harness()
  try {
    await h.supervisor.dispatchTask({ taskId: "prog-2", repo: "claude-companion", prompt: "Ship it", family: "gemini" })
    const before = h.cards.length
    const out = h.spawned[0]!
    h.tick(200); out.onStdoutLine(cmd("bun test"))
    h.tick(200); out.onStdoutLine(cmd("bun run lint"))
    expect(h.cards.length).toBe(before)
    expect(h.timers).toHaveLength(1)
    h.tick(600); h.timers.shift()!()
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

test("plan events → done / total and the in-progress label: Claude TodoWrite, Codex todo_list, Gemini write_todos", async () => {
  const { parseStreamJsonLine } = await import("./worker-invocation")
  const todos = [
    { content: "Read the code", activeForm: "Reading the code", status: "completed" },
    { content: "Write the parser", activeForm: "Writing the parser", status: "in_progress" },
    { content: "Open the PR", activeForm: "Opening the PR", status: "pending" },
    { content: "Dropped", activeForm: "Dropping", status: "cancelled" },
  ]
  expect(parseStreamJsonLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos } }] } })))
    .toEqual({ step: "Updating plan", plan: { done: 1, total: 3, label: "Writing the parser", source: "todos" } })
  const items = [{ text: "Map the stream", completed: true }, { text: "Ship the bar", completed: false }]
  for (const type of ["item.started", "item.updated", "item.completed"]) {
    expect(parseStreamJsonLine(JSON.stringify({ type, item: { id: "i1", type: "todo_list", items } })))
      .toEqual({ plan: { done: 1, total: 2, label: "Ship the bar", source: "plan" } })
  }
  expect(parseStreamJsonLine(JSON.stringify({ type: "tool_use", tool_name: "write_todos", parameters: { todos: [{ description: "A", status: "completed" }, { description: "B", status: "completed" }] } })))
    .toEqual({ step: "Updating plan", plan: { done: 2, total: 2, label: "Wrapping up", source: "todos" } })
  // A codex item.updated that isn't a plan is ignored; an empty list is no plan.
  expect(parseStreamJsonLine(JSON.stringify({ type: "item.updated", item: { type: "command_execution", command: "ls" } }))).toBeNull()
  expect(parseStreamJsonLine(JSON.stringify({ type: "item.started", item: { type: "todo_list", items: [] } }))).toBeNull()
})

test("command labels: short, never a pipeline, an argument or a secret", async () => {
  const { STEP_LABEL_MAX, commandLabel } = await import("./worker-invocation")
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"
  const cases: Array<[string, string]> = [
    ["bun test server/lib/foo.test.ts 2>&1 | head -5; exit 0", "Running tests"],
    ["git add -A && git commit -m wip && git push -u origin HEAD", "Opening PR"],
    [`gh pr create --title x --body "$(cat <<'EOF'\nbody\nEOF\n)"`, "Opening PR"],
    [`GITHUB_TOKEN=${token} TURSO_AUTH_TOKEN=abc curl -H "Authorization: Bearer ${token}" https://api`, "Running: curl"],
    ["cd /home/a/repo && ls -la | grep x", "Running: ls"],
    ["/bin/bash -lc 'printf \"%s\\n\" \"' '\"; echo; ls server'", "Running: printf"],
    ["bun run lint 2>&1 | tail -20", "Running: bun run lint"],
    ["git status --short", "Running: git status"],
    ["export FOO=bar; ./scripts/deploy.sh --prod", "Running: deploy.sh"],
    [`export WEBHOOK=https://hooks.slack.com/services/T0/B0/${token} && ls`, "Running: ls"],
    [`env CRED=/home/a/${token} FOO=bar ./run.sh`, "Running: run.sh"],
    [`export A=/x/${token}`, "Running command"],
    ["$(echo secret)", "Running command"],
    ["", "Running command"],
  ]
  for (const [cmd, label] of cases) {
    const got = commandLabel(cmd)
    expect(got).toBe(label)
    expect(got.length).toBeLessThanOrEqual(STEP_LABEL_MAX)
    expect(got).not.toContain(token)
    expect(got).not.toMatch(/[|;&]/)
  }
  expect(commandLabel(["bash", "-lc", "cargo test -q"])).toBe("Running tests")
})

test("a TodoWrite plan drives step, pct, progress and the card; tool steps don't override it", async () => {
  const h = harness()
  try {
    await h.supervisor.dispatchTask({ taskId: "prog-6", repo: "claude-companion", prompt: "Ship it", family: "claude" })
    const out = h.spawned[0]!
    expect(out.env.CLAUDE_CODE_ENABLE_TASKS).toBe("0")
    const todo = (statuses: string[]) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite",
      input: { todos: statuses.map((status, i) => ({ content: `Step ${i}`, activeForm: `Doing step ${i}`, status })) } }] } })
    h.tick(2_000); out.onStdoutLine(todo(["completed", "in_progress", "pending", "pending"]))
    h.tick(2_000); out.onStdoutLine(cmd("TOKEN=x bun test | head"))
    const t = h.supervisor.getTask("prog-6")!
    expect(t.step).toBe("Doing step 1")
    expect(t.pct).toBe(25)
    expect(t.progress).toMatchObject({ done: 1, total: 4, label: "Doing step 1", source: "todos", elapsedMs: 4_000 })
    const card = h.cards.at(-1)!
    expect(card.ref.progress).toMatchObject({ done: 1, total: 4, source: "todos" })
    expect(card.detail).toStartWith("Doing step 1 (1/4)")
  } finally {
    rmSync(h.home, { recursive: true, force: true })
  }
})

test("no plan: progress is source none with the tool's human label", async () => {
  const h = harness()
  try {
    await h.supervisor.dispatchTask({ taskId: "prog-7", repo: "claude-companion", prompt: "Ship it", family: "codex" })
    h.tick(2_000); h.spawned[0]!.onStdoutLine(cmd("bash -lc 'cd /w && rg -n foo | head -5; exit 0'"))
    expect(h.supervisor.getTask("prog-7")!.progress).toMatchObject({ done: 0, total: 0, label: "Running: rg", source: "none" })
  } finally {
    rmSync(h.home, { recursive: true, force: true })
  }
})

test("throttleJobReports: one progress per job per second, the trailing send carries the latest; done drops a pending one", () => {
  let clock = 0
  const sent: Array<{ event: string; step: string | null }> = []
  const timers: Array<() => void> = []
  const report = mod.throttleJobReports((r) => sent.push({ event: r.event, step: r.step }), () => clock, (fn) => { timers.push(fn) })
  const r = (event: "task" | "progress" | "done", step: string) => ({ event, id: "j1", title: "T", builder: null, pct: null, step })
  report(r("task", "start"))
  clock = 300; report(r("progress", "a"))
  clock = 600; report(r("progress", "b"))
  expect(sent.map((s) => s.step)).toEqual(["start"])
  expect(timers).toHaveLength(1)
  clock = 1_000; timers.shift()!()
  expect(sent.map((s) => s.step)).toEqual(["start", "b"])
  clock = 2_500; report(r("progress", "c"))
  expect(sent.map((s) => s.step)).toEqual(["start", "b", "c"])
  clock = 2_700; report(r("progress", "d"))
  report(r("done", "PR ready"))
  for (const fn of timers.splice(0)) fn()
  expect(sent.map((s) => s.step)).toEqual(["start", "b", "c", "PR ready"])
  // A report past the window while a trailing timer is queued never jumps it: the late timer sends the latest, never a stale one.
  report(r("task", "start2"))
  clock = 3_000; report(r("progress", "e"))
  clock = 4_500; report(r("progress", "f"))
  expect(sent.map((s) => s.step)).toEqual(["start", "b", "c", "PR ready", "start2"])
  for (const fn of timers.splice(0)) fn()
  expect(sent.map((s) => s.step)).toEqual(["start", "b", "c", "PR ready", "start2", "f"])
  expect(mod.THROTTLE_MS).toBe(1_000)
})
