import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getPending, resolveApproval, setDefaultApprovalExpiryMs } from "../lib/pty-manager"
import { listLearned, useLearnedAllowDb } from "../lib/learned-allow"
import { listSessions, recordSession } from "../lib/sessions"
import { isSuperAuto, setSuperAutoInMemoryForTests } from "../lib/super-auto"
import { clients } from "../state"

// Route-level, approvals (batch 1a): an approval that nobody decided — expired,
// hook gone, answered at the terminal, turn ended — must come back as NO
// decision (`{}`), never an allow, and must never be learned.

let handleHookRoute: (req: Request, url: URL) => Promise<Response | null>
// SUPER mode is read from the host's flag file at import; these tests need the
// normal phone path, so it is forced off in memory and restored after.
const superWas = isSuperAuto()
const frames: Array<Record<string, unknown>> = []
const fake = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Parameters<typeof clients.add>[0]

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-appr-"))
  process.env.COMPANION_DB_PATH = join(dir, "companion.db")
  // Whatever test file opened the learned table first, this one is isolated.
  useLearnedAllowDb(join(dir, "learned.db"))
  await import("../wiring/events")
  handleHookRoute = (await import("./hooks")).handleHookRoute
  clients.add(fake)
  setSuperAutoInMemoryForTests(false)
})
afterAll(() => {
  setSuperAutoInMemoryForTests(superWas)
  clients.delete(fake)
  setDefaultApprovalExpiryMs(null)
})

// Unlisted and learnable (`bash:zz-appr-unlisted`) — so a wrongful recordAllow
// would show up as a row.
const CMD = "zz-appr-unlisted --flag"

function post(path: string, body: unknown, opts: { signal?: AbortSignal; headers?: Record<string, string> } = {}): [Request, URL] {
  const url = new URL(`http://localhost:4245${path}`)
  const req = new Request(url.href, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  return [req, url]
}

async function waitPending(sessionId: string) {
  for (let i = 0; i < 200; i++) {
    const r = getPending().find((x) => x.sessionId === sessionId)
    if (r) return r
    await Bun.sleep(5)
  }
  throw new Error("approval never reached the phone")
}

const resolvedFor = (id: string) => frames.filter((f) => f.type === "resolved" && f.id === id).map((f) => f.decision)

test("expiry → `{}` (terminal prompt), resolved 'expired', no learned row", async () => {
  setDefaultApprovalExpiryMs(30)
  try {
    const res = handleHookRoute(...post("/hooks/pre-tool-use", { session_id: "ap-exp", tool_name: "Bash", tool_input: { command: CMD }, cwd: "/tmp/ap-exp" }))
    const r = await waitPending("ap-exp")
    expect(await (await res)!.json()).toEqual({})
    expect(resolvedFor(r.id)).toEqual(["expired"])
    expect(listLearned()).toEqual([])
    // A late tap finds nothing.
    expect(resolveApproval(r.id, "allow")).toBe(false)
  } finally {
    setDefaultApprovalExpiryMs(null)
  }
})

test("PermissionRequest expiry → `{}` too, never an allow", async () => {
  setDefaultApprovalExpiryMs(30)
  try {
    const res = handleHookRoute(...post("/hooks/permission-request", { session_id: "ap-pexp", tool_name: "Bash", tool_input: { command: CMD }, cwd: "/tmp/ap-pexp" }))
    const r = await waitPending("ap-pexp")
    const body = await (await res)!.json()
    expect(body).toEqual({})
    expect(JSON.stringify(body)).not.toContain("allow")
    expect(resolvedFor(r.id)).toEqual(["expired"])
    expect(listLearned()).toEqual([])
  } finally {
    setDefaultApprovalExpiryMs(null)
  }
})

test("hook connection aborted → `{}`, resolved 'elsewhere', no learned row", async () => {
  const ctrl = new AbortController()
  const res = handleHookRoute(...post("/hooks/pre-tool-use", { session_id: "ap-abort", tool_name: "Bash", tool_input: { command: CMD }, cwd: "/tmp/ap-abort" }, { signal: ctrl.signal }))
  const r = await waitPending("ap-abort")
  ctrl.abort()
  expect(await (await res)!.json()).toEqual({})
  expect(resolvedFor(r.id)).toEqual(["elsewhere"])
  expect(listLearned()).toEqual([])
})

test("PostToolUse for the same call (answered at the terminal) → elsewhere; a parallel call keeps its card", async () => {
  const sid = "ap-post"
  const one = handleHookRoute(...post("/hooks/permission-request", { session_id: sid, tool_name: "Bash", tool_input: { command: `${CMD} one` }, cwd: "/tmp/ap-post" }))
  const r1 = await waitPending(sid)
  const two = handleHookRoute(...post("/hooks/permission-request", { session_id: sid, tool_name: "Bash", tool_input: { command: `${CMD} two` }, cwd: "/tmp/ap-post" }))
  for (let i = 0; i < 200 && getPending().filter((x) => x.sessionId === sid).length < 2; i++) await Bun.sleep(5)
  const r2 = getPending().find((x) => x.sessionId === sid && x.id !== r1.id)!
  await handleHookRoute(...post("/hooks/post-tool-use", { session_id: sid, tool_name: "Bash", tool_input: { command: `${CMD} one` }, tool_response: {}, cwd: "/tmp/ap-post" }))
  expect(await (await one)!.json()).toEqual({})
  expect(resolvedFor(r1.id)).toEqual(["elsewhere"])
  expect(getPending().some((x) => x.id === r2.id)).toBe(true)
  // Stop for the session ends the rest.
  await handleHookRoute(...post("/hooks/stop", { session_id: sid, cwd: "/tmp/ap-post", last_assistant_message: "done" }))
  expect(await (await two)!.json()).toEqual({})
  expect(resolvedFor(r2.id)).toEqual(["elsewhere"])
  expect(listLearned()).toEqual([])
})

test("phone deny is a deny and is not learned; phone allow is an allow and IS learned (control)", async () => {
  const d = handleHookRoute(...post("/hooks/pre-tool-use", { session_id: "ap-deny", tool_name: "Bash", tool_input: { command: CMD }, cwd: "/tmp/ap-deny" }))
  expect(resolveApproval((await waitPending("ap-deny")).id, "deny")).toBe(true)
  const db = await (await d)!.json() as { hookSpecificOutput: { permissionDecision: string } }
  expect(db.hookSpecificOutput.permissionDecision).toBe("deny")
  expect(listLearned()).toEqual([])

  const a = handleHookRoute(...post("/hooks/pre-tool-use", { session_id: "ap-allow", tool_name: "Bash", tool_input: { command: CMD }, cwd: "/tmp/ap-allow" }))
  expect(resolveApproval((await waitPending("ap-allow")).id, "allow")).toBe(true)
  const ab = await (await a)!.json() as { hookSpecificOutput: { permissionDecision: string } }
  expect(ab.hookSpecificOutput.permissionDecision).toBe("allow")
  expect(listLearned().map((e) => e.pattern)).toEqual(["bash:zz-appr-unlisted"])
})

test("SessionEnd removes only the session that ended — never its cwd/tty/pane siblings", async () => {
  recordSession({ cwd: "/tmp/se-shared", sessionId: "se-a", tty: "/dev/pts/191" })
  recordSession({ cwd: "/tmp/se-shared", sessionId: "se-b", tty: "/dev/pts/192" })
  const inCwd = () => listSessions().filter((s) => s.cwd === "/tmp/se-shared").map((s) => s.sessionId).sort()
  expect(inCwd()).toEqual(["se-a", "se-b"])
  // Unknown session id, no pid: nothing goes (it used to wipe the whole cwd).
  await handleHookRoute(...post("/hooks/session-end", { session_id: "se-zzz", cwd: "/tmp/se-shared" }))
  expect(inCwd()).toEqual(["se-a", "se-b"])
  // A headless child carrying se-b's tty ends: se-b stays, only se-a goes.
  await handleHookRoute(...post("/hooks/session-end", { session_id: "se-a", cwd: "/tmp/se-shared" }, { headers: { "x-companion-tty": "/dev/pts/192" } }))
  expect(inCwd()).toEqual(["se-b"])
})
