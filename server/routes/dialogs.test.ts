import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addQuestionRequest, getPendingQuestions } from "../lib/questions"
import { recordSession, type Session } from "../lib/sessions"
import { clients } from "../state"

// Esc on a pending question (Canvas Cancel / phone Esc → /api/dialog/key):
// Claude Code fires no hook for the rejected call, so the route ends the card
// itself. The pane sits on a throwaway tmux socket with no server: the route
// spawns the real send-keys and does not gate on its exit code.

type Route = (req: Request, url: URL) => Promise<Response | null>
let handleDialogRoute: Route
let stopWatcher: () => void
const dir = mkdtempSync(join(tmpdir(), "dialog-key-"))
const socket = join(dir, "tmux.sock")
const frames: Array<Record<string, unknown>> = []
const fake = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Parameters<typeof clients.add>[0]
let session: Session

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(dir, "test.db")
  await import("../wiring/events")
  handleDialogRoute = (await import("./dialogs")).handleDialogRoute
  const { dialogWatcher } = await import("../wiring/dialogs")
  stopWatcher = () => dialogWatcher.stop()
  clients.add(fake)
  session = recordSession({ cwd: "/tmp/dialog-key-esc", agent: "claude", sessionId: "esc-sid", tmuxPane: "%91919", tmuxSocket: socket, tty: "/dev/pts/9191" })!
})
afterAll(() => {
  stopWatcher()
  clients.delete(fake)
})

function post(body: unknown): [Request, URL] {
  const url = new URL("http://localhost:4245/api/dialog/key")
  return [new Request(url.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), url]
}

const questions = [{ header: "Color", question: "Esc color?", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }]
const pendingHere = () => getPendingQuestions().filter((q) => q.sessionKey === session.key)

test("Escape for a session with a pending question ends it: resolved frame, pending map empty", async () => {
  const answer = addQuestionRequest({ sessionId: "esc-sid", cwd: session.cwd, questions, sessionKey: session.key }, { expiryMs: 60_000 })
  const id = pendingHere()[0]!.id
  const res = await handleDialogRoute(...post({ key: session.key, name: "Escape" }))
  expect(await res!.json()).toEqual({ ok: true })
  expect(pendingHere()).toEqual([])
  expect(frames).toContainEqual({ type: "resolved", id, decision: "expired" })
  expect(await answer).toEqual([])
})

test("other keys leave a pending question alone", async () => {
  void addQuestionRequest({ sessionId: "esc-sid", cwd: session.cwd, questions, sessionKey: session.key }, { expiryMs: 60_000 })
  const res = await handleDialogRoute(...post({ key: session.key, name: "Down" }))
  expect(await res!.json()).toEqual({ ok: true })
  expect(pendingHere()).toHaveLength(1)
  await handleDialogRoute(...post({ key: session.key, name: "Escape" }))
  expect(pendingHere()).toEqual([])
})
