import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getPendingQuestions, resolveQuestion } from "../lib/questions"

// Route-level: the PermissionRequest hook must answer in PermissionRequest
// shape (it passed "PreToolUse" until 2026-09-25, which Claude Code ignores),
// and a question answered at the terminal must clear the phone card.

let handleHookRoute: (req: Request, url: URL) => Promise<Response | null>

beforeAll(async () => {
  // Keep the route's transitive stores off the real ~/.claude-companion.
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "hooks-q-")), "test.db")
  handleHookRoute = (await import("./hooks")).handleHookRoute
})

const question = { header: "Color", question: "Which color route test?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }

function post(path: string, body: unknown): [Request, URL] {
  const url = new URL(`http://localhost:4245${path}`)
  const req = new Request(url.href, {
    method: "POST",
    headers: { "content-type": "application/json", "x-companion-tty": "/dev/pts/88", "x-companion-tmux-pane": "%88888" },
    body: JSON.stringify(body),
  })
  return [req, url]
}

async function waitPending(sessionId: string) {
  for (let i = 0; i < 100; i++) {
    const q = getPendingQuestions().find((r) => r.sessionId === sessionId)
    if (q) return q
    await Bun.sleep(5)
  }
  throw new Error("question never reached the phone")
}

test("POST /hooks/permission-request answers a question in PermissionRequest shape with updatedInput", async () => {
  const sessionId = "route-q-1"
  const res = handleHookRoute(...post("/hooks/permission-request", {
    session_id: sessionId, tool_name: "AskUserQuestion", tool_input: { questions: [question] }, cwd: "/tmp/route-q-1",
  }))
  const q = await waitPending(sessionId)
  expect(resolveQuestion(q.id, [{ selected: ["Red"] }])).toBe(true)
  expect(await (await res)!.json()).toEqual({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions: [question], answers: { "Which color route test?": "Red" } } },
    },
  })
})

test("PostToolUse of the question tool (answered at the terminal) ends the pending question; hook passes through", async () => {
  const sessionId = "route-q-2"
  const res = handleHookRoute(...post("/hooks/permission-request", {
    session_id: sessionId, tool_name: "AskUserQuestion", tool_input: { questions: [question] }, cwd: "/tmp/route-q-2",
  }))
  await waitPending(sessionId)
  await handleHookRoute(...post("/hooks/post-tool-use", {
    session_id: sessionId, tool_name: "AskUserQuestion", tool_input: { questions: [question] }, tool_response: {}, cwd: "/tmp/route-q-2",
  }))
  expect(getPendingQuestions().some((r) => r.sessionId === sessionId)).toBe(false)
  expect(await (await res)!.json()).toEqual({})
})

// headless-desk Verify 1b fixture: the PreToolUse body a `claude -p --resume
// --permission-prompt-tool stdio` turn sent (CC 2.1.327, captured 2026-11-18,
// paths shortened). No tty, no pane: a desk row. The phone's answer goes back
// as PreToolUse allow + updatedInput.answers — the exact reply that turn took
// (tool_result "…"Which color do you prefer?"="Blue"…", reply CHOSEN=Blue).
const DESK_PRETOOLUSE = {
  session_id: "3f7c4b90-6165-49ef-b8ab-0b783e078513",
  transcript_path: "/Users/x/.claude/projects/-tmp-v1b-cwd/3f7c4b90-6165-49ef-b8ab-0b783e078513.jsonl",
  cwd: "/tmp/v1b/cwd", prompt_id: "0e06a9fd-6b22-460e-8ad6-c00700f68435", permission_mode: "default", effort: { level: "medium" },
  hook_event_name: "PreToolUse", tool_name: "AskUserQuestion",
  tool_input: { questions: [{ question: "Which color do you prefer?", header: "Color", options: [{ label: "Red", description: "Choose Red" }, { label: "Blue", description: "Choose Blue" }], multiSelect: false }] },
  tool_use_id: "toolu_01GQSCNrXFqemwoYvAFry2zM",
}

test("a desk turn's AskUserQuestion is held for the phone and answered through PreToolUse updatedInput.answers", async () => {
  const { recordSession } = await import("../lib/sessions")
  recordSession({ cwd: DESK_PRETOOLUSE.cwd, agent: "claude", sessionId: DESK_PRETOOLUSE.session_id, herdrPane: `headless:desk:${DESK_PRETOOLUSE.session_id}` }, { sessionIdConfirmed: true })
  const url = new URL("http://localhost:4245/hooks/pre-tool-use")
  const res = handleHookRoute(new Request(url.href, { method: "POST", headers: { "content-type": "application/json", "x-companion-tty": "", "x-companion-pid": "" }, body: JSON.stringify(DESK_PRETOOLUSE) }), url)
  const q = await waitPending(DESK_PRETOOLUSE.session_id)
  expect(q.sessionKey).toBe(`claude:sid:${DESK_PRETOOLUSE.session_id}`)
  expect(resolveQuestion(q.id, [{ selected: ["Blue"] }])).toBe(true)
  expect(await (await res)!.json()).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "Answered via Claude Companion",
      updatedInput: { ...DESK_PRETOOLUSE.tool_input, answers: { "Which color do you prefer?": "Blue" } },
    },
  })
})
