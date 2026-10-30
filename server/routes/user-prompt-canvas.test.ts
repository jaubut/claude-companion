import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchSubmit } from "../lib/submit-confirm"

// canvas-note-refs: the UserPromptSubmit hook output. With X-Companion-Hook-Output the route answers
// the hook's exact stdout — the fromPhone note plus the notes linked to that session (or to the
// brain) — or 204; without it, an older installed script still gets {fromPhone}. Real canvas store
// on a temp companion.db, real sessions table.

let handleHookRoute: (req: Request, url: URL) => Promise<Response | null>
let canvas: typeof import("../wiring/canvas")
let listSessions: typeof import("../lib/sessions").listSessions

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "prompt-canvas-")), "test.db")
  handleHookRoute = (await import("./hooks")).handleHookRoute
  canvas = await import("../wiring/canvas")
  listSessions = (await import("../lib/sessions")).listSessions
})

async function submit(sessionId: string, tty: string, opts: { header?: boolean; taskId?: string } = {}): Promise<Response> {
  const url = new URL("http://localhost:4245/hooks/user-prompt-submit")
  const headers: Record<string, string> = { "content-type": "application/json", "x-companion-tty": tty }
  if (opts.header !== false) headers["x-companion-hook-output"] = "claude"
  if (opts.taskId) headers["x-companion-task-id"] = opts.taskId
  const req = new Request(url.href, { method: "POST", headers, body: JSON.stringify({ session_id: sessionId, prompt: "hi", cwd: "/tmp/cc-canvas" }) })
  return (await handleHookRoute(req, url))!
}

// The canvas store is one lazy connection per process: leave the board as found for later files.
afterAll(() => {
  for (const id of ["cv-agent", "cv-spec", "cv-sticky", "brain", "cv-brain-note"]) canvas.canvasStore.removeNode(id)
})

const context = async (res: Response): Promise<string> =>
  ((await res.json()) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput.additionalContext
const box = { x: 0, y: 0, w: 1, h: 1 }

test("nothing linked, not from the phone → 204; without the header → {fromPhone} as before", async () => {
  expect((await submit("cv-a", "/dev/pts/701")).status).toBe(204)
  expect(await (await submit("cv-a", "/dev/pts/701", { header: false })).json()).toEqual({ fromPhone: false })
})

test("a linked agent gets its references on every prompt, live; a new session id on that tty does not", async () => {
  await submit("cv-b", "/dev/pts/702") // records the session
  const key = listSessions().find((s) => s.sessionId === "cv-b")!.key
  canvas.canvasStore.addNode({ id: "cv-agent", kind: "agent", ref: key, ...box, data: {} }, 1) // binds to cv-b
  canvas.canvasStore.addNode({ id: "cv-spec", kind: "turso_note", ref: "RES-CV01", ...box, data: { title: "Plan" } }, 2)
  canvas.canvasStore.addNode({ id: "cv-sticky", kind: "note", ref: "", ...box, data: { text: "ship friday" } }, 3)
  expect(canvas.canvasStore.addEdge({ kind: "context", from: "cv-spec", to: "cv-agent" }, 4).ok).toBe(true)
  expect(canvas.canvasStore.addEdge({ kind: "context", from: "cv-sticky", to: "cv-agent" }, 4).ok).toBe(true)

  const res = await submit("cv-b", "/dev/pts/702")
  expect(res.status).toBe(200)
  const text = await context(res)
  expect(text).toStartWith("Canvas references:")
  expect(text).toContain('Turso note RES-CV01 "Plan"')
  expect(text).toContain("«ship friday»")

  canvas.canvasStore.patchNode("cv-sticky", { data: { text: "ship monday" } }, 5)
  expect(await context(await submit("cv-b", "/dev/pts/702"))).toContain("«ship monday»")

  expect((await submit("cv-c", "/dev/pts/702")).status).toBe(204) // /clear: another agent on that tty
})

test("the brain reads the notes linked to the brain node; the phone note rides along", async () => {
  canvas.canvasStore.addNode({ id: "brain", kind: "brain", ref: "", ...box, data: {} }, 1)
  canvas.canvasStore.addNode({ id: "cv-brain-note", kind: "note", ref: "", ...box, data: { text: "priorities: canvas" } }, 2)
  canvas.canvasStore.addEdge({ kind: "reference", from: "cv-brain-note", to: "brain" }, 3)
  const watch = watchSubmit({ sessionId: "cv-brain", tty: "/dev/pts/703" })
  try {
    const text = await context(await submit("cv-brain", "/dev/pts/703", { taskId: "brain" }))
    expect(text).toStartWith("This prompt was sent from Jeremie's iPhone via Companion")
    expect(text).toContain("«priorities: canvas»")
  } finally {
    watch.close()
  }
  expect((await submit("cv-d", "/dev/pts/704")).status).toBe(204) // not the brain: nothing linked
})
