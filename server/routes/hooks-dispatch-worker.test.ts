import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getPending, resolveApproval, setDefaultApprovalExpiryMs } from "../lib/pty-manager"
import { useLearnedAllowDb } from "../lib/learned-allow"
import { listSessions } from "../lib/sessions"
import { isSuperAuto, setSuperAutoInMemoryForTests } from "../lib/super-auto"
import { flushAutoHistory } from "../lib/approval-history-auto"
import { registerToken } from "../lib/push-tokens"
import { resetDispatchWorkerCache } from "../lib/dispatch-worker"
import { getPendingQuestions } from "../lib/questions"

// Route-level, herdr dispatch workers (WP6). The herdr runner runs the worker's
// claude interactive in a pane, so — unlike `claude -p` — it has a tty and fires
// every hook. Marker: DISPATCH_WORKER=1 in the claude process env, which the
// server reads from the pid the hook scripts already send (X-Companion-Pid).
// A worker must be invisible to the phone: no session, no Stop push, no
// PermissionRequest / approval / question card. A non-worker beside it (the
// control) is unchanged.

let handleHookRoute: (req: Request, url: URL) => Promise<Response | null>
// Real processes carry the marker, but some hosts (a sandboxed macOS shell) forbid reading another
// process's env — so the route reads it through a fake keyed on the process's own argv0 marker,
// and one test below uses the real reader when the host allows it.
const marked = new Set<string>()
const unreadable = new Set<string>()
const superWas = isSuperAuto()
const pushes: Array<Record<string, unknown>> = []
let broker: ReturnType<typeof Bun.serve>
const procs: Array<ReturnType<typeof Bun.spawn>> = []

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-worker-"))
  process.env.COMPANION_DB_PATH = join(dir, "test.db")
  useLearnedAllowDb(join(dir, "learned.db"))
  delete process.env.DISPATCH_WORKER
  // A fake push broker: a push the server sends lands here and is counted.
  broker = Bun.serve({ port: 0, async fetch(req) { pushes.push(await req.json() as Record<string, unknown>); return Response.json({ ok: true }) } })
  process.env.BROKER_URL = `http://127.0.0.1:${broker.port}/`
  process.env.BROKER_TOKEN = "t"
  registerToken("aa".repeat(32), "sandbox", "test-phone")
  await import("../wiring/events")
  const { setWorkerEnvReaderForTests } = await import("../lib/worker-hook-gate")
  handleHookRoute = (await import("./hooks")).handleHookRoute
  setWorkerEnvReaderForTests(async (pid) => (unreadable.has(pid) ? null : marked.has(pid) ? ["HOME=/h", "DISPATCH_WORKER=1", "DISPATCH_TASK_ID=t1"] : ["HOME=/h"]))
  setSuperAutoInMemoryForTests(false)
})
afterAll(() => {
  setSuperAutoInMemoryForTests(superWas)
  setDefaultApprovalExpiryMs(null)
  broker.stop(true)
  for (const p of procs) p.kill()
  delete process.env.BROKER_URL
  delete process.env.BROKER_TOKEN
})

// A live process with (or without) the worker marker in its environment.
// Named `claude`: the session registry prunes a pid whose command is not an agent.
let claudeBin = ""
function proc(worker: boolean): string {
  if (!claudeBin) {
    claudeBin = join(mkdtempSync(join(tmpdir(), "hooks-worker-bin-")), "claude")
    symlinkSync(Bun.which("sleep")!, claudeBin)
  }
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  delete env.DISPATCH_WORKER
  if (worker) env.DISPATCH_WORKER = "1"
  const p = Bun.spawn([claudeBin, "120"], { env, stdout: "ignore", stderr: "ignore" })
  procs.push(p)
  if (worker) marked.add(String(p.pid))
  return String(p.pid)
}

function post(path: string, body: unknown, pid: string): [Request, URL] {
  const url = new URL(`http://localhost:4245${path}`)
  return [new Request(url.href, {
    method: "POST",
    headers: { "content-type": "application/json", "x-companion-pid": pid, "x-companion-tty": "/dev/pts/9" },
    body: JSON.stringify(body),
  }), url]
}

const hook = async (path: string, body: unknown, pid: string) => (await handleHookRoute(...post(path, body, pid)))!
const sessionsFor = (sid: string) => listSessions().filter((s) => s.sessionId === sid)
const settle = () => Bun.sleep(150)

test("Stop: a worker pushes nothing and registers nothing; a normal session pushes (control)", async () => {
  const w = proc(true), n = proc(false)
  const before = pushes.length
  const r = await hook("/hooks/stop", { session_id: "dw-stop-w", cwd: "/tmp/dw-stop-w", last_assistant_message: "done" }, w)
  expect(await r.json()).toEqual({})
  await settle()
  expect(pushes.length).toBe(before)
  expect(sessionsFor("dw-stop-w")).toEqual([])

  await hook("/hooks/stop", { session_id: "dw-stop-n", cwd: "/tmp/dw-stop-n", last_assistant_message: "done" }, n)
  await settle()
  expect(pushes.length).toBe(before + 1) // the harness really observes pushes
  expect(sessionsFor("dw-stop-n").length).toBe(1)
})

test("PermissionRequest: a worker gets a passthrough, no phone card, no session; a normal one waits on the phone", async () => {
  const w = proc(true), n = proc(false)
  const res = await hook("/hooks/permission-request", { session_id: "dw-perm-w", tool_name: "Bash", tool_input: { command: "zz-dw-unlisted --x" }, cwd: "/tmp/dw-perm-w" }, w)
  expect(await res.json()).toEqual({})
  expect(getPending().filter((x) => x.sessionId === "dw-perm-w")).toEqual([])
  expect(sessionsFor("dw-perm-w")).toEqual([])

  const normal = handleHookRoute(...post("/hooks/permission-request", { session_id: "dw-perm-n", tool_name: "Bash", tool_input: { command: "zz-dw-unlisted --x" }, cwd: "/tmp/dw-perm-n" }, n))
  for (let i = 0; i < 100 && !getPending().some((x) => x.sessionId === "dw-perm-n"); i++) await Bun.sleep(5)
  const card = getPending().find((x) => x.sessionId === "dw-perm-n")
  expect(card).toBeDefined()
  resolveApproval(card!.id, "deny")
  await normal
})

test("PreToolUse: an 'ask' for a worker is not routed to the phone (passthrough, no card, no activity session)", async () => {
  const w = proc(true)
  const res = await hook("/hooks/pre-tool-use", { session_id: "dw-pre-ask", tool_name: "Bash", tool_input: { command: "zz-dw-unlisted --x" }, cwd: "/tmp/dw-pre-ask" }, w)
  expect(await res.json()).toEqual({})
  expect(getPending().filter((x) => x.sessionId === "dw-pre-ask")).toEqual([])
  expect(sessionsFor("dw-pre-ask")).toEqual([])
})

test("PreToolUse: auto-allow still answers for a worker (it keeps the worker unblocked, as under `-p`) and is audited", async () => {
  const w = proc(true)
  flushAutoHistory()
  const res = await hook("/hooks/pre-tool-use", { session_id: "dw-pre-ok", tool_name: "Bash", tool_input: { command: "ls -la" }, cwd: "/tmp/dw-pre-ok", tool_use_id: "tu-dw-1" }, w)
  const body = await res.json() as { hookSpecificOutput?: { permissionDecision?: string } }
  expect(body.hookSpecificOutput?.permissionDecision).toBe("allow")
  expect(flushAutoHistory()).toBeGreaterThanOrEqual(1)
  expect(sessionsFor("dw-pre-ok")).toEqual([])
})

test("PreToolUse: a worker's AskUserQuestion is not a phone question", async () => {
  const w = proc(true)
  const res = await hook("/hooks/pre-tool-use", { session_id: "dw-q", tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "which?", header: "h", options: [{ label: "a", description: "a" }, { label: "b", description: "b" }] }] }, cwd: "/tmp/dw-q" }, w)
  expect(await res.json()).toEqual({})
  expect(getPendingQuestions().filter((q) => q.sessionId === "dw-q")).toEqual([])
})

test("SessionStart / UserPromptSubmit / PostToolUse / SessionEnd: a worker registers nothing", async () => {
  const w = proc(true)
  const cwd = "/tmp/dw-misc"
  for (const [path, body] of [
    ["/hooks/session-start", { session_id: "dw-misc", cwd, source: "startup" }],
    ["/hooks/user-prompt-submit", { session_id: "dw-misc", cwd, prompt: "hi" }],
    ["/hooks/post-tool-use", { session_id: "dw-misc", cwd, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {} }],
    ["/hooks/session-end", { session_id: "dw-misc", cwd }],
  ] as const) {
    expect((await hook(path, body, w)).status).toBe(200)
  }
  expect(sessionsFor("dw-misc")).toEqual([])
})

test("a pid whose env is unreadable or unmarked is not a worker (fail open to the old behaviour)", async () => {
  resetDispatchWorkerCache()
  const n = proc(false)
  await hook("/hooks/session-start", { session_id: "dw-open-n", cwd: "/tmp/dw-open-n", source: "startup" }, n)
  expect(sessionsFor("dw-open-n").length).toBe(1)
  const x = proc(true)
  unreadable.add(x) // marked, but the host will not show its env
  await hook("/hooks/session-start", { session_id: "dw-open-x", cwd: "/tmp/dw-open-x", source: "startup" }, x)
  expect(sessionsFor("dw-open-x").length).toBe(1)
})

test("real env reader: a spawned DISPATCH_WORKER=1 process is a worker, an unmarked one is not (skipped where the host hides process env)", async () => {
  const { processEnvEntries } = await import("../lib/discover")
  const { isDispatchWorkerPid } = await import("../lib/dispatch-worker")
  const w = proc(true), n = proc(false)
  const readable = ((await processEnvEntries(w)) ?? []).length > 0
  if (!readable) { console.log("process env unreadable on this host — real-reader check skipped"); return }
  resetDispatchWorkerCache()
  expect(await isDispatchWorkerPid(w, processEnvEntries)).toBe(true)
  expect(await isDispatchWorkerPid(n, processEnvEntries)).toBe(false)
})
