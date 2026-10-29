import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getPending } from "../lib/pty-manager"
import { listLearned, recordAllow, useLearnedAllowDb } from "../lib/learned-allow"
import { getSessionByKey, listSessions } from "../lib/sessions"
import { isSuperAuto, setSuperAutoInMemoryForTests } from "../lib/super-auto"

// brain-v2 hook security (routes/hooks.ts): the brain — identified by its
// X-Companion-Task-Id header first — gets brainToolVerdict and nothing else.
// SUPER, learned allows and the phone can never widen it.

let handleHookRoute: (req: Request, url: URL) => Promise<Response | null>
let compactTargetFor: typeof import("../wiring/auto-compact").compactTargetFor
const superWas = isSuperAuto()
const BRAIN = { "x-companion-task-id": "brain" }

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-brain-"))
  process.env.COMPANION_DB_PATH ??= join(dir, "test.db")
  useLearnedAllowDb(join(dir, "learned.db"))
  await import("../wiring/events")
  handleHookRoute = (await import("./hooks")).handleHookRoute
  compactTargetFor = (await import("../wiring/auto-compact")).compactTargetFor
})
afterAll(() => setSuperAutoInMemoryForTests(superWas))

function post(path: string, body: unknown, headers: Record<string, string> = BRAIN): [Request, URL] {
  const url = new URL(`http://localhost:4245${path}`)
  return [new Request(url.href, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), url]
}

async function decision(path: string, body: Record<string, unknown>, headers: Record<string, string> = BRAIN): Promise<string | undefined> {
  const res = await handleHookRoute(...post(path, body, headers))
  const j = await res!.json() as { hookSpecificOutput?: { permissionDecision?: string; decision?: { behavior?: string } } }
  return j.hookSpecificOutput?.permissionDecision ?? j.hookSpecificOutput?.decision?.behavior
}

test("Edit with SUPER on → deny (SUPER never reaches the brain)", async () => {
  setSuperAutoInMemoryForTests(true)
  try {
    expect(await decision("/hooks/pre-tool-use", { session_id: "sb-1", tool_name: "Edit", tool_input: { file_path: "/srv/x.ts" }, cwd: "/tmp/brain-sb" })).toBe("deny")
    expect(await decision("/hooks/pre-tool-use", { session_id: "sb-1", tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: "/tmp/brain-sb" })).toBe("deny")
  } finally {
    setSuperAutoInMemoryForTests(false)
  }
})

test("a learned allow never applies to the brain → deny", async () => {
  const cmd = "zz-brain-learned --go"
  recordAllow("Bash", { command: cmd })
  expect(listLearned().length).toBeGreaterThan(0)
  expect(await decision("/hooks/pre-tool-use", { session_id: "sb-2", tool_name: "Bash", tool_input: { command: cmd }, cwd: "/tmp/brain-sb" })).toBe("deny")
  // Not the brain: the same learned command is still allowed for everyone else.
  expect(await decision("/hooks/pre-tool-use", { session_id: "sb-other", tool_name: "Bash", tool_input: { command: cmd }, cwd: "/tmp/not-brain" }, {})).toBe("allow")
})

test("dispatch.sh and bin/propose → allow, with no phone round-trip", async () => {
  expect(await decision("/hooks/pre-tool-use", { session_id: "sb-3", tool_name: "Bash", tool_input: { command: "~/.claude/tools/dispatch.sh 0123 queued" }, cwd: "/tmp/brain-sb" })).toBe("allow")
  expect(await decision("/hooks/pre-tool-use", { session_id: "sb-3", tool_name: "Bash", tool_input: { command: "bin/propose --turn t --note n --prompt p" }, cwd: "/tmp/brain-sb" })).toBe("allow")
  expect(getPending().some((r) => r.sessionId === "sb-3")).toBe(false)
})

test("PermissionRequest Edit → deny, never a phone card", async () => {
  expect(await decision("/hooks/permission-request", { session_id: "sb-4", tool_name: "Edit", tool_input: { file_path: "/x" }, cwd: "/tmp/brain-sb" })).toBe("deny")
  expect(getPending().some((r) => r.sessionId === "sb-4")).toBe(false)
})

test("no cwd in the payload (no session) → still the brain by header → deny", async () => {
  expect(await decision("/hooks/pre-tool-use", { session_id: "sb-5", tool_name: "Write", tool_input: { file_path: "/x" } })).toBe("deny")
  expect(await decision("/hooks/permission-request", { session_id: "sb-5", tool_name: "MultiEdit", tool_input: {} })).toBe("deny")
})

test("brain Stop: no waiting badge, no global auto-compact target, the reply lands in the brain thread", async () => {
  const res = await handleHookRoute(...post("/hooks/stop", { session_id: "sb-stop", cwd: "/tmp/brain-stop", transcript_path: "/tmp/brain-stop/t.jsonl", last_assistant_message: "brain reply sb-stop" }))
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
