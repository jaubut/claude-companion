import { test, expect } from "bun:test"
import { QUESTION_ORPHAN_MS, createDialogWatcher, type DialogWatchDeps, type SessionStatus } from "./dialog-watch"
import type { Session } from "./sessions"
import { ANSWER_GRACE_MS, addQuestionRequest, getPendingQuestions, questionAnsweredRecently, resolveQuestion } from "./questions"
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
    tmuxPane: "%8", tmuxSocket: "", taskId: "", waitingSince: 0, waitingKind: "", waitingRef: "", waitingReasons: [],
    pid: "100", firstSeenAt: 0, lastSeenAt: 0, model: "",
    agentStatus: "", waitingFor: "", ...over,
  }
}

// What the companion's own /help scrape puts on the pane (routes/command.ts).
// It parses as a perfectly good dialog — which is exactly why the watcher has
// to be told it is ours.
const HELP_PANE = `
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Help  General   Commands   Custom commands
   Browse default commands
   ❯ /add-dir
       Add a new working directory
   Esc to cancel
`

interface H {
  sessions: Session[]
  pane: string | null
  status: SessionStatus | null
  pendingQuestion: boolean
  pendingApproval: boolean
  scraping: boolean
  captures: number
  opened: [string, Dialog][]
  closed: string[]
  statuses: [string, SessionStatus][]
  // Seams for the race in F3: run something INSIDE one of check()'s awaits.
  duringStatus: (() => Promise<void>) | null
  duringCapture: (() => Promise<void>) | null
}

function harness(over: Partial<DialogWatchDeps> = {}): { h: H; w: ReturnType<typeof createDialogWatcher> } {
  const h: H = {
    sessions: [session()], pane: IDLE_PANE, status: { status: "idle", waitingFor: "" },
    pendingQuestion: false, pendingApproval: false, scraping: false, captures: 0, opened: [], closed: [], statuses: [],
    duringStatus: null, duringCapture: null,
  }
  const w = createDialogWatcher({
    sessions: () => h.sessions,
    capture: async () => { h.captures++; if (h.duringCapture) await h.duringCapture(); return h.pane },
    sessionStatus: async () => { if (h.duringStatus) await h.duringStatus(); return h.status },
    hasPendingQuestion: () => h.pendingQuestion,
    hasPendingApproval: () => h.pendingApproval,
    isScraping: () => h.scraping,
    onDialog: (k, d) => h.opened.push([k, d]),
    onDialogClosed: (k) => h.closed.push(k),
    onStatus: (k, st) => h.statuses.push([k, st]),
    pollMs: 10,
    ...over,
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

test("codex session: a picker-looking pane emits no dialog (no Codex status source)", async () => {
  const { h, w } = harness()
  h.sessions = [session({ key: "codex:tty:/dev/pts/9", agent: "codex" })]
  h.status = null
  h.pane = MODEL_PANE
  await w.tick()
  expect(h.opened).toEqual([])
  expect(h.captures).toBe(0)
  expect(w.current()).toEqual({})
})

const QUESTION_PANE = `
❯ ask me
────────────────────────
←  ☐ Color  ✔ Submit  →
Pick one color
❯ 1. Red
  2. Green
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`

test("a fresh question picker with no card is not mirrored (driver may still be typing)", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = QUESTION_PANE
  await w.tick()
  expect(h.opened).toEqual([])
})

test("an orphaned question picker (no card past QUESTION_ORPHAN_MS) is mirrored once, closed when answered", async () => {
  let t = 1_000_000
  const { h, w } = harness({ now: () => t })
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = QUESTION_PANE
  await w.tick()
  t += QUESTION_ORPHAN_MS - 1
  await w.tick()
  expect(h.opened).toEqual([])
  t += 2
  await w.tick()
  await w.tick()
  expect(h.opened).toHaveLength(1)
  expect(h.opened[0]![1].kind).toBe("question")
  expect(h.opened[0]![1].items.map((i) => i.text)).toEqual(["Red", "Green"])
  h.status = { status: "busy", waitingFor: "" }
  await w.tick()
  expect(h.closed).toEqual([h.sessions[0]!.key])
})

test("a question picker with a pending phone card never starts the orphan clock", async () => {
  let t = 1_000_000
  const { h, w } = harness({ now: () => t })
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = QUESTION_PANE
  h.pendingQuestion = true
  await w.tick()
  t += QUESTION_ORPHAN_MS * 30
  await w.tick()
  expect(h.opened).toEqual([])
  // Card lapses: the clock starts now, not when the picker first appeared.
  h.pendingQuestion = false
  await w.tick()
  expect(h.opened).toEqual([])
  t += QUESTION_ORPHAN_MS + 1
  await w.tick()
  expect(h.opened).toHaveLength(1)
})

test("a picker answered from the phone is not mirrored while the driver types it (grace window)", async () => {
  // Zettlab 2026-09-10: resolveQuestion dropped the card, the picker stayed up
  // ~20 s while the driver typed, and after QUESTION_ORPHAN_MS it lit a dialog.
  const key = session().key
  let t = Date.now()
  const { h, w } = harness({
    now: () => t,
    hasPendingQuestion: (s) => getPendingQuestions().some((q) => q.sessionKey === s.key),
    questionAnsweredRecently: (s) => questionAnsweredRecently(s.key, t),
  })
  void addQuestionRequest({ sessionId: "sid", cwd: "/home/aubut", sessionKey: key, questions: [] }, { expiryMs: 60_000 })
  const id = getPendingQuestions().find((q) => q.sessionKey === key)!.id
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = QUESTION_PANE
  await w.tick()
  expect(resolveQuestion(id, [{ selected: ["Red"] }])).toBe(true)
  const answeredAt = t
  while (t + 2_000 < answeredAt + ANSWER_GRACE_MS) { t += 2_000; await w.tick() } // 2 s poll
  expect(h.opened).toEqual([])
  // Past the grace a still-stuck picker is an orphan again.
  t = answeredAt + ANSWER_GRACE_MS + 1_000 // resolveQuestion stamped real Date.now(), a hair after t
  await w.tick()
  t += QUESTION_ORPHAN_MS + 1
  await w.tick()
  expect(h.opened).toHaveLength(1)
})

test("the answer grace only holds back question screens — a real dialog still mirrors", async () => {
  const { h, w } = harness({ questionAnsweredRecently: () => true })
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = MODEL_PANE
  await w.tick()
  expect(h.opened).toHaveLength(1)
})

test("an orphaned question picker is re-raised as a structured card when possible (no dialog mirror)", async () => {
  let t = 1_000_000
  const raised: string[] = []
  const gone: string[] = []
  const { h, w } = harness({ now: () => t, raiseOrphanQuestion: (s) => { raised.push(s.key); return true }, onQuestionPickerGone: (k) => gone.push(k) })
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = QUESTION_PANE
  await w.tick()
  t += QUESTION_ORPHAN_MS + 1
  await w.tick()
  expect(raised).toEqual([h.sessions[0]!.key])
  expect(h.opened).toEqual([])
  h.status = { status: "idle", waitingFor: "" }
  await w.tick()
  expect(gone).toContain(h.sessions[0]!.key)
})

test("an orphan that can't be re-raised falls back to the dialog mirror", async () => {
  let t = 1_000_000
  const { h, w } = harness({ now: () => t, raiseOrphanQuestion: () => false })
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = QUESTION_PANE
  await w.tick()
  t += QUESTION_ORPHAN_MS + 1
  await w.tick()
  expect(h.opened).toHaveLength(1)
})

test("a review screen parseDialog can't see still starts the orphan clock and gets re-raised", async () => {
  let t = 1_000_000
  const raised: string[] = []
  const { h, w } = harness({ now: () => t, isQuestionScreen: () => true, raiseOrphanQuestion: (s) => { raised.push(s.key); return true } })
  h.status = { status: "waiting", waitingFor: "input needed" }
  h.pane = "Review your answers\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel\n"
  await w.tick()
  t += QUESTION_ORPHAN_MS + 1
  await w.tick()
  expect(raised).toEqual([h.sessions[0]!.key])
  expect(h.opened).toEqual([])
})

test("a question the hooks already routed is not mirrored", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = MODEL_PANE
  h.pendingQuestion = true
  await w.tick()
  expect(h.opened).toEqual([])
})

test("an approval the hooks already routed is not mirrored as a second (dialog) card; closes an open one", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = MODEL_PANE
  await w.tick()
  expect(h.opened.length).toBe(1)
  h.pendingApproval = true
  await w.tick()
  expect(h.closed).toEqual([h.sessions[0]!.key])
  expect(h.opened.length).toBe(1)
})

// The bug this fixes: the companion's /help scrape drives the session's own
// pane, the watcher mirrored the resulting overlay to the phone as a dialog,
// marked the session waiting-on-a-dialog, and every inject then refused with
// "has a dialog open" — for a dialog the companion itself had opened. On an
// 80x24 pane the scrape ran ~2 minutes, so from the phone the session looked
// unusable.
test("the companion's own /help scrape is never mirrored as a dialog", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = HELP_PANE
  h.scraping = true
  const capturesBefore = h.captures
  await w.tick()
  await w.tick()
  expect(h.opened).toEqual([])
  expect(w.current()).toEqual({})
  // Skipped before the capture: a scraping pane is read tens of times a second
  // by the scrape itself, no reason to add to it.
  expect(h.captures).toBe(capturesBefore)
})

test("a real dialog opened while scraping is picked up as soon as the scrape releases the pane", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = HELP_PANE
  h.scraping = true
  await w.tick()
  expect(h.opened).toEqual([])
  h.scraping = false
  h.pane = MODEL_PANE
  await w.tick()
  expect(h.opened).toHaveLength(1)
  expect(h.opened[0]![1].title).toBe("Select model")
})

// F3 — isScraping() was only tested at the TOP of check(), before the two
// awaits. A scrape claiming the pane during either of them still got one Help
// card published; every later tick then skipped the session, so nothing ever
// closed that card and the false "dialog open" stuck for the whole scrape
// (and kept every inject refusing).
test("a scrape that starts during the capture await publishes nothing", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = HELP_PANE
  // The claim lands after the status check, while the capture is in flight.
  h.duringCapture = async () => { h.scraping = true }
  await w.tick()
  expect(h.opened).toEqual([])
  expect(w.current()).toEqual({})
})

test("a scrape that starts during the status await publishes neither status nor dialog", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = HELP_PANE
  h.duringStatus = async () => { h.scraping = true }
  await w.tick()
  expect(h.opened).toEqual([])
  // "waiting / dialog open" here is OUR overlay: reporting it marks the
  // session blocked on the phone for the length of the scrape.
  expect(h.statuses).toEqual([])
  expect(w.current()).toEqual({})
})

test("a card already on screen is closed when the scrape claims the pane, not left to stick", async () => {
  const { h, w } = harness()
  h.status = { status: "waiting", waitingFor: "dialog open" }
  h.pane = MODEL_PANE
  await w.tick()
  expect(h.opened).toHaveLength(1)
  // The scrape starts mid-tick; without the re-check the entry would survive
  // every subsequent (skipped) tick.
  h.duringCapture = async () => { h.scraping = true }
  await w.tick()
  expect(h.closed).toEqual(["claude:tty:/dev/pts/8"])
  expect(w.current()).toEqual({})
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
