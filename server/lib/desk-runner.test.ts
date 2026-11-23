import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DeskDeps, QUEUE_CAP, createDeskRunner, deskEnv, deskStateFile } from "./desk-runner"
import type { SpawnWorkerOpts } from "./worker-spawn"
import type { Session } from "./sessions"

// Fake spawn + timers, a temp HOME for the state file. Covers Verify 1: the
// lease, the queue cap, the refusals, boot restore, and interrupt vs the queue.

interface Spawned { opts: SpawnWorkerOpts; pid: number; kills: NodeJS.Signals[] }

function harness(over: Partial<DeskDeps> = {}) {
  const home = mkdtempSync(join(tmpdir(), "desk-"))
  const spawned: Spawned[] = []
  const frames: Record<string, unknown>[] = []
  const records: Array<Partial<Session>> = []
  const timers: Array<{ fn: () => void; ms: number; done: boolean }> = []
  const exits: string[] = []
  let nextPid = 5000
  const alive = new Set<number>()
  const deps: Partial<DeskDeps> = {
    stateFile: deskStateFile(home),
    spawn: (opts) => {
      const s: Spawned = { opts, pid: nextPid++, kills: [] }
      alive.add(s.pid)
      spawned.push(s)
      return { pid: s.pid, kill: (sig) => s.kills.push(sig) }
    },
    isAlive: (pid) => alive.has(pid),
    identity: (pid) => (alive.has(pid) ? `id:${pid}` : null),
    kill: (pid, sig) => { spawned.find((s) => s.pid === pid)?.kills.push(sig) },
    env: async () => ({ PATH: "/usr/bin" }),
    transcriptExists: () => true,
    terminalHolds: () => false,
    runnerOwns: () => false,
    record: (meta) => { records.push(meta); return { key: `${meta.agent}:sid:${meta.sessionId}`, ...meta } as Session },
    broadcast: (f) => { frames.push(f) },
    onTurnExit: (sid) => { exits.push(sid) },
    setTimer: (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t },
    clearTimer: (t) => { (t as { done: boolean }).done = true },
    ...over,
  }
  const runner = createDeskRunner(deps)
  const exit = (i: number, code = 0, accepted = true): void => {
    const s = spawned[i]!
    alive.delete(s.pid)
    if (accepted) runner.noteAccepted(sid(s))
    s.opts.onExit(code, null)
  }
  const sid = (s: Spawned): string => {
    const a = s.opts.args
    return a[a.indexOf("--resume") + 1] ?? a[a.indexOf("--session-id") + 1]!
  }
  const fire = (ms: number): void => { for (const t of timers) if (!t.done && t.ms === ms) { t.done = true; t.fn() } }
  return { home, runner, spawned, frames, records, exits, exit, fire, alive, deps }
}

const SID = "11111111-2222-3333-4444-555555555555"
const send = (h: ReturnType<typeof harness>, text: string, extra: Record<string, unknown> = {}) =>
  h.runner.send({ sid: SID, agent: "claude", cwd: "/repo", text, ...extra })
const tick = () => Bun.sleep(0)

test("a send runs one claude -p --resume turn with the prompt tool and no terminal env", async () => {
  const h = harness()
  expect(send(h, "hello")).toEqual({ ok: true, queued: false })
  await tick()
  expect(h.spawned).toHaveLength(1)
  const { cmd, args, cwd } = h.spawned[0]!.opts
  expect([cmd, cwd]).toEqual(["claude", "/repo"])
  expect(args.slice(0, 2)).toEqual(["-p", "--output-format"])
  expect(args).toContain("--resume")
  expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "default"])
  expect(args.slice(-4)).toEqual(["--permission-prompt-tool", "stdio", "--", "hello"])
  expect(h.records.at(-1)).toMatchObject({ sessionId: SID, herdrPane: `headless:desk:${SID}`, agentStatus: "busy" })
  h.exit(0)
  expect(h.records.at(-1)).toMatchObject({ agentStatus: "idle" })
  expect(h.exits).toEqual([SID])
  expect(h.frames).toEqual([])
})

test("lease: a second send queues and runs at exit; the 6th queued is queue_full", async () => {
  const h = harness()
  send(h, "first")
  await tick()
  for (let i = 0; i < QUEUE_CAP; i++) expect(send(h, `q${i}`)).toEqual({ ok: true, queued: true })
  expect(send(h, "too many")).toEqual({ ok: false, status: 409, error: "queue_full" })
  expect(h.spawned).toHaveLength(1)
  h.exit(0)
  await tick()
  expect(h.spawned).toHaveLength(2)
  expect(h.spawned[1]!.opts.args.at(-1)).toBe("q0")
  expect(JSON.parse(readFileSync(h.deps.stateFile!, "utf8")).turns[0].queue).toHaveLength(QUEUE_CAP - 1)
})

test("an idempotency key is deduped against the running turn and the queue", async () => {
  const h = harness()
  send(h, "a", { idemKey: "k1" })
  await tick()
  expect(send(h, "a", { idemKey: "k1" })).toEqual({ ok: true, queued: false, replayed: true })
  send(h, "b", { idemKey: "k2" })
  expect(send(h, "b", { idemKey: "k2" })).toEqual({ ok: true, queued: true, replayed: true })
  expect(JSON.parse(readFileSync(h.deps.stateFile!, "utf8")).turns[0].queue).toEqual([expect.objectContaining({ text: "b", idemKey: "k2" })])
})

test("refusals before any spawn: terminal_owned, runner_owned, target_gone, unsupported_agent", () => {
  expect(send(harness({ terminalHolds: () => true }), "x")).toEqual({ ok: false, status: 409, error: "terminal_owned" })
  expect(send(harness({ runnerOwns: () => true }), "x")).toEqual({ ok: false, status: 409, error: "runner_owned" })
  expect(send(harness({ transcriptExists: () => false }), "x")).toEqual({ ok: false, status: 410, error: "target_gone" })
  const h = harness()
  expect(h.runner.send({ sid: SID, agent: "kimi", cwd: "/repo", text: "x" })).toEqual({ ok: false, status: 409, error: "unsupported_agent" })
  expect(h.spawned).toHaveLength(0)
})

test("terminal_owned: a live ~/.claude/sessions pid file names the sid; our own turn's pid never does", async () => {
  const { defaultTerminalHolds } = await import("./desk-runner")
  const home = mkdtempSync(join(tmpdir(), "desk-home-"))
  await Bun.write(join(home, ".claude", "sessions", "4242.json"), JSON.stringify({ sessionId: SID, pid: 4242 }))
  const live = (pid: string) => pid === "4242"
  expect(defaultTerminalHolds(SID, new Set(), home, live)).toBe(true)
  expect(defaultTerminalHolds(SID, new Set([4242]), home, live)).toBe(false)
  expect(defaultTerminalHolds(SID, new Set(), home, () => false)).toBe(false)
  expect(defaultTerminalHolds("other", new Set(), home, live)).toBe(false)
})

test("interrupt: SIGINT to the group, SIGKILL after 3 s, queue cleared, exit pops nothing", async () => {
  const h = harness()
  send(h, "long")
  await tick()
  send(h, "next")
  expect(h.runner.interrupt(SID)).toBe(true)
  expect(h.spawned[0]!.kills).toEqual(["SIGINT"])
  h.fire(3_000)
  expect(h.spawned[0]!.kills).toEqual(["SIGINT", "SIGKILL"])
  h.exit(0, 130, false)
  await tick()
  expect(h.spawned).toHaveLength(1)
  expect(h.frames).toEqual([])
  expect(h.runner.running(SID)).toBe(false)
  expect(h.runner.interrupt(SID)).toBe(false)
  // The next send resumes cleanly.
  expect(send(h, "after")).toEqual({ ok: true, queued: false })
})

test("a turn that exits before its UserPromptSubmit → async turn_failed; a queued send expires at 540 s", async () => {
  const h = harness()
  send(h, "lost")
  await tick()
  send(h, "waiting")
  h.fire(540_000)
  expect(h.frames).toEqual([{ type: "inject_error", error: "queue_expired", key: `claude:sid:${SID}`, cwd: "/repo", text: "waiting" }])
  h.exit(0, 1, false)
  expect(h.frames.at(-1)).toEqual({ type: "inject_error", error: "turn_failed", key: `claude:sid:${SID}`, cwd: "/repo", text: "lost" })
  await tick()
  expect(h.spawned).toHaveLength(1)
})

test("a reply on stdout also counts as accepted (no UserPromptSubmit seen): no turn_failed", async () => {
  const h = harness()
  send(h, "hi")
  await tick()
  h.spawned[0]!.opts.onStdoutLine('{"type":"result","subtype":"success","is_error":false,"result":"ok"}')
  h.exit(0, 0, false)
  expect(h.frames).toEqual([])
})

test("a dequeue-time guard that fails drops that send", async () => {
  const h = harness()
  send(h, "a")
  await tick()
  send(h, "canvas", { guard: () => false })
  send(h, "phone")
  h.exit(0)
  await tick()
  expect(h.spawned.map((s) => s.opts.args.at(-1))).toEqual(["a", "phone"])
})

test("create: a fresh sid starts with --session-id, then resumes", async () => {
  const h = harness({ transcriptExists: () => false })
  const row = h.runner.create("claude", "/repo")!
  const sid = row.sessionId!
  expect(row).toMatchObject({ herdrPane: `headless:desk:${sid}`, agentStatus: "idle" })
  h.runner.send({ sid, agent: "claude", cwd: "/repo", text: "seed" })
  await tick()
  expect(h.spawned[0]!.opts.args).toContain("--session-id")
  h.exit(0)
})

test("codex: exec resume, model from setModel; adopt makes an idle desk row", async () => {
  const h = harness()
  h.runner.setModel(SID, "o3")
  h.runner.send({ sid: SID, agent: "codex", cwd: "/repo", text: "hi" })
  await tick()
  expect(h.spawned[0]!.opts.cmd).toBe("codex")
  expect(h.spawned[0]!.opts.args).toEqual(["exec", "resume", "--json", "--skip-git-repo-check", "-m", "o3", "--", SID, "hi"])
  expect(h.runner.adopt({ agent: "gemini", sessionId: SID, cwd: "/x" })).toBeNull()
  expect(h.runner.adopt({ agent: "claude", sessionId: "s2", cwd: "/x" })).toMatchObject({ herdrPane: "headless:desk:s2", agentStatus: "idle" })
})

test("boot restore keeps a live pid's lease (no second writer) and runs a dead one's queue", async () => {
  const h = harness()
  h.alive.add(42)
  await Bun.write(h.deps.stateFile!, JSON.stringify({
    turns: [
      { sid: SID, agent: "claude", cwd: "/repo", pid: 42, pidStart: "id:42", queue: [{ text: "later", at: Date.now() }] },
      { sid: "dead", agent: "claude", cwd: "/repo", pid: 43, pidStart: "id:43", queue: [{ text: "queued", at: Date.now() }] },
    ],
    models: { [SID]: "claude-sonnet-5-5" },
    rows: [{ sid: "row1", agent: "claude", cwd: "/r", title: "Chat", at: Date.now() }, { sid: "old", agent: "claude", cwd: "/r", title: "", at: 0 }],
  }))
  h.runner.restore()
  await tick()
  expect(h.runner.running(SID)).toBe(true)
  expect(send(h, "now")).toEqual({ ok: true, queued: true })
  expect(h.spawned.map((s) => s.opts.args.at(-1))).toEqual(["queued"])
  expect(h.runner.modelFor(SID)).toBe("claude-sonnet-5-5")
  expect(h.records.some((r) => r.sessionId === "row1" && r.title === "Chat")).toBe(true)
  expect(h.records.some((r) => r.sessionId === "old")).toBe(false)
  // The watched pid exits: its queue runs, on this server.
  h.alive.delete(42)
  h.fire(2_000)
  await tick()
  expect(h.spawned.map((s) => s.opts.args.at(-1))).toEqual(["queued", "later"])
})

test("deskEnv: secrets in, terminal / worker markers and DB credentials out", () => {
  const env = deskEnv({ PATH: "/bin", TMUX: "/tmp/t,1,0", TMUX_PANE: "%3", HERDR_PANE_ID: "p", TERM_PROGRAM: "ghostty", DISPATCH_HEADLESS: "1", COMPANION_TASK_ID: "t", TURSO_AUTH_TOKEN: "x" }, { GH_TOKEN: "g" })
  expect(env.GH_TOKEN).toBe("g")
  expect(env.CLAUDE_NO_AGENT_ENV).toBe("1")
  for (const k of ["TMUX", "TMUX_PANE", "HERDR_PANE_ID", "TERM_PROGRAM", "DISPATCH_HEADLESS", "COMPANION_TASK_ID", "TURSO_AUTH_TOKEN"]) expect(env[k]).toBeUndefined()
})
