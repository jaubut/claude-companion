import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getPending } from "../lib/pty-manager"
import { useLearnedAllowDb } from "../lib/learned-allow"
import { getSessionByKey, listSessions } from "../lib/sessions"
import { isSuperAuto, setSuperAutoInMemoryForTests } from "../lib/super-auto"

// brain-v2 hooks (routes/hooks.ts). The brain is a normal session — its tool
// calls take the normal path (SUPER, auto-judge → phone) like any session.
// Its Stop goes to the brain thread: no waiting badge, no global auto-compact,
// no push.

let handleHookRoute: (req: Request, url: URL) => Promise<Response | null>
let compactTargetFor: typeof import("../wiring/auto-compact").compactTargetFor
const superWas = isSuperAuto()
const BRAIN = { "x-companion-task-id": "brain" }
// Unlisted for the auto-judge: SUPER allows it, without SUPER the auto-judge asks the phone.
const CMD = "zz-brain-super-probe --go"

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-brain-"))
  process.env.COMPANION_DB_PATH ??= join(dir, "test.db")
  useLearnedAllowDb(join(dir, "learned.db"))
  await import("../wiring/events")
  handleHookRoute = (await import("./hooks")).handleHookRoute
  compactTargetFor = (await import("../wiring/auto-compact")).compactTargetFor
})
afterAll(() => setSuperAutoInMemoryForTests(superWas))

function post(path: string, body: unknown, headers: Record<string, string> = BRAIN, signal?: AbortSignal): [Request, URL] {
  const url = new URL(`http://localhost:4245${path}`)
  return [new Request(url.href, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal }), url]
}

async function waitPending(sessionId: string) {
  for (let i = 0; i < 200; i++) {
    const r = getPending().find((x) => x.sessionId === sessionId)
    if (r) return r
    await Bun.sleep(5)
  }
  return null
}

test("SUPER on: a brain call is auto-allowed like any session", async () => {
  setSuperAutoInMemoryForTests(true)
  try {
    const res = await handleHookRoute(...post("/hooks/pre-tool-use", { session_id: "sb-super", tool_name: "Bash", tool_input: { command: CMD }, cwd: "/tmp/brain-sb" }))
    const j = await res!.json() as { hookSpecificOutput?: { permissionDecision?: string } }
    expect(j.hookSpecificOutput?.permissionDecision).toBe("allow")
  } finally {
    setSuperAutoInMemoryForTests(false)
  }
})

test("SUPER off: a brain call takes the normal path — the auto-judge asks the phone", async () => {
  setSuperAutoInMemoryForTests(false)
  const ctrl = new AbortController()
  const res = handleHookRoute(...post("/hooks/pre-tool-use", { session_id: "sb-nosuper", tool_name: "Bash", tool_input: { command: CMD }, cwd: "/tmp/brain-sb" }, BRAIN, ctrl.signal))
  expect(await waitPending("sb-nosuper")).not.toBeNull()
  ctrl.abort()
  expect(await (await res)!.json()).toEqual({})
})

test("brain Stop: no waiting badge, no global auto-compact target, the adopted brain's reply lands in the brain thread", async () => {
  const { brainWiring } = await import("../wiring/brain")
  const headers = { ...BRAIN, "x-companion-herdr-pane": "p_brain_hooks" }
  brainWiring.setSpawnedPaneForTests("p_brain_hooks")
  await handleHookRoute(...post("/hooks/session-start", { session_id: "sb-stop", cwd: "/tmp/brain-stop", source: "startup" }, headers))
  const res = await handleHookRoute(...post("/hooks/stop", { session_id: "sb-stop", cwd: "/tmp/brain-stop", transcript_path: "/tmp/brain-stop/t.jsonl", last_assistant_message: "brain reply sb-stop" }, headers))
  expect(await res!.json()).toEqual({})
  const s = listSessions().find((x) => x.sessionId === "sb-stop")!
  expect(s.taskId).toBe("brain")
  expect(getSessionByKey(s.key)!.waitingReasons).toEqual([])
  expect(compactTargetFor(s, "/tmp/brain-stop/t.jsonl", "sb-stop")).toBeNull()
  expect(compactTargetFor({ ...s, taskId: "lead-tls" }, "/tmp/brain-stop/t.jsonl", "sb-stop")).toBeNull()
  expect(compactTargetFor({ ...s, taskId: "" }, "/tmp/brain-stop/t.jsonl", "sb-stop")).not.toBeNull()
  const { getThread } = await import("../lib/orchestrator-chat")
  for (let i = 0; i < 50 && !getThread("brain").some((t) => t.text === "brain reply sb-stop"); i++) await Bun.sleep(5)
  expect(getThread("brain").some((t) => t.role === "orchestrator" && t.text === "brain reply sb-stop")).toBe(true)
})
