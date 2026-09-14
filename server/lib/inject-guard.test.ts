import { test, expect } from "bun:test"
import { injectRefusal } from "./inject-guard"
import type { Dialog } from "./dialogs"
import type { Session } from "./sessions"

function session(over: Partial<Session> = {}): Session {
  return {
    key: "tty:/dev/ttys004",
    agent: "claude",
    label: "claude-companion",
    title: "",
    sidConfirmed: false,
    agentStatus: "waiting",
    waitingFor: "",
    cwd: "/Users/jeremieaubut/claude-companion",
    sessionId: "",
    termProgram: "iTerm.app",
    tty: "/dev/ttys004",
    iTermSessionId: "",
    tmuxPane: "%12",
    ...over,
  } as Session
}

function dialog(over: Partial<Dialog> = {}): Dialog {
  return {
    kind: "dialog",
    title: "Change effort level?",
    body: "This conversation is cached for the current effort level.",
    items: [
      { index: 0, number: 1, text: "Yes, switch to medium", cursor: true, selected: false },
      { index: 1, number: 2, text: "No, go back", cursor: false, selected: false },
    ],
    more: "",
    hints: [{ key: "Enter", label: "confirm" }],
    numbered: true,
    ...over,
  }
}

test("no dialog: the inject proceeds", () => {
  expect(injectRefusal({ lookup: "tty:/dev/ttys004", target: session(), dialog: null })).toBeNull()
  expect(injectRefusal({ lookup: "tty:/dev/ttys004", target: session() })).toBeNull()
})

test("an open dialog refuses and carries the dialog back", () => {
  const d = dialog()
  const r = injectRefusal({ lookup: "tty:/dev/ttys004", target: session(), dialog: d })
  expect(r?.error).toBe("dialog_open")
  // The client renders what is in the way instead of a bare code.
  expect(r?.dialog).toBe(d)
})

test("a question picker never refuses — the hooks own those end to end", () => {
  // question-driver.ts types into it and the phone has the structured card;
  // dialog-watch.ts already keeps this kind out of current(), so this is a
  // belt-and-braces case, not a live path.
  const r = injectRefusal({
    lookup: "tty:/dev/ttys004",
    target: session(),
    dialog: dialog({ kind: "question", title: "Which approach?" }),
  })
  expect(r).toBeNull()
})

test("a named target that isn't registered refuses before anything else", () => {
  const r = injectRefusal({ lookup: "tty:/dev/ttys999", target: null, dialog: dialog() })
  expect(r?.error).toBe("target_gone")
  expect(r?.dialog).toBeUndefined()
})

test("a target with no live tty refuses, and outranks the dialog", () => {
  const r = injectRefusal({
    lookup: "tty:/dev/ttys004",
    target: session({ tty: "" }),
    dialog: dialog(),
  })
  expect(r?.error).toBe("target_idle")
})

test("the frontmost fallback (no lookup, no target) is unchanged — it injects", () => {
  // Nothing was addressed, so there is no session whose dialog we could check.
  expect(injectRefusal({ lookup: "", target: null, dialog: dialog() })).toBeNull()
})

test("a dialog on a session the caller did not address does not refuse", () => {
  // The caller passes the dialog for `target` only; a bystander's dialog never
  // reaches here. Guards the call sites against passing the wrong map entry.
  expect(injectRefusal({ lookup: "", target: null, dialog: null })).toBeNull()
})
