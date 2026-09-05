import { test, expect } from "bun:test"
import { createDialogWatcher, type SessionStatus } from "./dialog-watch"
import type { Session } from "./sessions"
import type { Dialog } from "./dialogs"

const MODEL_PANE = `
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Select model
   ❯ 1. Default (recommended) ✔  Opus 5
     2. Opus (1M context)        Opus 5
   Enter to set as default · s to use this session only · Esc to cancel
`
const IDLE_PANE = `
────────────────────────
❯ 
────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`

function session(over: Partial<Session> = {}): Session {
  return {
    key: "claude:tty:/dev/pts/8", agent: "claude", label: "aubut · pts8", title: "", sidConfirmed: true,
    cwd: "/home/aubut", sessionId: "sid", termProgram: "", tty: "/dev/pts/8", iTermSessionId: "",
    tmuxPane: "%8", pid: "100", firstSeenAt: 0, lastSeenAt: 0, agentStatus: "", waitingFor: "", ...over,
  }
}

interface H {
  sessions: Session[]
  pane: string | null
  status: SessionStatus | null
  pendingQuestion: boolean
  opened: [string, Dialog][]
  closed: string[]
  statuses: [string, SessionStatus][]
}

function harness(): { h: H; w: ReturnType<typeof createDialogWatcher> } {
  const h: H = {
    sessions: [session()], pane: IDLE_PANE, status: { status: "idle", waitingFor: "" },
    pendingQuestion: false, opened: [], closed: [], statuses: [],
  }
  const w = createDialogWatcher({
    sessions: () => h.sessions,
    capture: async () => h.pane,
    sessionStatus: async () => h.status,
    hasPendingQuestion: () => h.pendingQuestion,
    onDialog: (k, d) => h.opened.push([k, d]),
    onDialogClosed: (k) => h.closed.push(k),
    onStatus: (k, st) => h.statuses.push([k, st]),
    pollMs: 10,
  })
  return { h, w }
}

test("status gate: no capture while idle; dialog mirrored once when waiting, closed when gone", async () => {
  const { h, w } = harness()
  await w.tick()
  expect(h.opened).toEqual([])
  expect(h.statuses).toEqual([["claude:tty:/dev/pts/8", { status: "idle", waitingFor: "" }]])
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = MODEL_PANE
  await w.tick()
  await w.tick() // same dialog → no second emit
  expect(h.opened).toHaveLength(1)
  expect(h.opened[0]![1].title).toBe("Select model")
  expect(Object.keys(w.current())).toEqual(["claude:tty:/dev/pts/8"])
  h.pane = IDLE_PANE
  await w.tick()
  expect(h.closed).toEqual(["claude:tty:/dev/pts/8"])
  expect(w.current()).toEqual({})
  expect(h.statuses).toHaveLength(2) // status change reported once
})

test("no status file (older CLI): capture anyway", async () => {
  const { h, w } = harness()
  h.status = null
  h.pane = MODEL_PANE
  await w.tick()
  expect(h.opened).toHaveLength(1)
})

test("a question the hooks already routed is not mirrored", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = MODEL_PANE
  h.pendingQuestion = true
  await w.tick()
  expect(h.opened).toEqual([])
})

test("cursor movement re-emits (signature changes); session vanishing closes", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = MODEL_PANE
  await w.tick()
  h.pane = MODEL_PANE.replace("❯ 1.", "  1.").replace("  2.", "❯ 2.")
  await w.tick()
  expect(h.opened).toHaveLength(2)
  expect(h.opened[1]![1].items[1]!.cursor).toBe(true)
  h.sessions = []
  await w.tick()
  expect(h.closed).toEqual(["claude:tty:/dev/pts/8"])
})
