import { test, expect, describe } from "bun:test"
import { parseDialog } from "./dialogs"
import {
  choicesFrom, confirmKeyFor, isModelPicker, openRefusal, setKeys,
} from "./model-control"
import type { Session } from "./sessions"

// Captured verbatim off a real pane, 2026-09-13, Claude Code 2.1.270.
const MODEL_PANE = `
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions.
     1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks
   ❯ 2. Opus (1M context) ✔    Opus 5 with 1M context · Best for everyday, complex tasks
     3. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks
     4. Sonnet                 Sonnet 5 · Efficient for routine tasks
     5. Haiku                  Haiku 4.5 · Fastest for quick answers
   ◉ xHigh effort ←/→ to adjust
   Enter to set as default · s to use this session only · Esc to cancel
`

const MCP_PANE = `
   Manage MCP servers
   18 servers
   ❯ birds-n-clubs-store · ✘ failed
     blender · ✔ connected · 22 tools
   Enter to view details · Esc to close
`

const dialog = () => parseDialog(MODEL_PANE)!
const mcp = () => parseDialog(MCP_PANE)!

function session(over: Partial<Session> = {}): Session {
  return {
    key: "claude:tty:/dev/ttys004", agent: "claude", label: "companion", title: "",
    sidConfirmed: true, agentStatus: "waiting", waitingFor: "", cwd: "/x", sessionId: "sid",
    termProgram: "", tty: "/dev/ttys004", iTermSessionId: "", tmuxPane: "%12", taskId: "",
    waitingSince: 0, waitingKind: "", waitingRef: "", waitingReasons: [],
    pid: "1", firstSeenAt: 0, lastSeenAt: 0, model: "",
    ...over,
  } as Session
}

test("the real picker parses into choices with the current one marked", () => {
  const choices = choicesFrom(dialog())
  expect(choices).toHaveLength(5)
  expect(choices[0]?.text).toStartWith("Default (recommended)")
  expect(choices[3]?.text).toStartWith("Sonnet")
  expect(choices[2]?.text).toContain("Fable 5.1")
  // Rows keep their index, which is what /api/dialog/pick takes.
  expect(choices.map((c) => c.index)).toEqual([0, 1, 2, 3, 4])

  const current = choices.filter((c) => c.current)
  expect(current).toHaveLength(1)
  expect(current[0]?.text).toStartWith("Opus (1M context)")
})

test("only the model picker is recognised as one", () => {
  expect(isModelPicker(dialog())).toBe(true)
  // Every Claude Code list parses the same way; the title is what stops us
  // driving arrow keys into somebody else's list.
  expect(isModelPicker(mcp())).toBe(false)
  expect(isModelPicker(null)).toBe(false)
})

describe("scope comes from the picker's own footer", () => {
  test("default scope confirms with Enter", () => {
    expect(confirmKeyFor(dialog(), "default")).toBe("Enter")
  })

  test("session scope finds the 's' hint by its label, not by hardcoding the key", () => {
    expect(confirmKeyFor(dialog(), "session")).toBe("s")
  })

  test("a picker without the session-only hint refuses session scope", () => {
    const d = dialog()
    d.hints = d.hints.filter((h) => !/this session only/i.test(h.label))
    expect(confirmKeyFor(d, "session")).toBeNull()
  })
})

describe("setKeys walks from the cursor row and then confirms", () => {
  test("down to Sonnet, then Enter for the default scope", () => {
    // cursor sits on index 1 (Opus), Sonnet is index 3
    expect(setKeys(dialog(), 3, "default")).toEqual(["Down", "Down", "Enter"])
  })

  test("up to the first row, then s for this session only", () => {
    expect(setKeys(dialog(), 0, "session")).toEqual(["Up", "s"])
  })

  test("picking the row already under the cursor sends only the confirm", () => {
    expect(setKeys(dialog(), 1, "default")).toEqual(["Enter"])
  })

  test("an out-of-range index refuses instead of arrowing into nothing", () => {
    expect(setKeys(dialog(), 9, "default")).toEqual({ error: "no_such_model" })
    expect(setKeys(dialog(), -1, "default")).toEqual({ error: "no_such_model" })
  })

  test("session scope on a picker with no such hint refuses", () => {
    const d = dialog()
    d.hints = []
    expect(setKeys(d, 3, "session")).toEqual({ error: "not_a_picker" })
  })
})

describe("openRefusal keeps the picker off a session that can't take one", () => {
  test("an idle tmux session is fine", () => {
    expect(openRefusal(session(), null)).toBeNull()
  })

  test("no tmux pane, nothing to drive", () => {
    expect(openRefusal(session({ tmuxPane: "" }), null)).toEqual({ error: "no_pane" })
    expect(openRefusal(null, null)).toEqual({ error: "no_pane" })
  })

  test("mid-turn refuses — a modal over the user's own work", () => {
    expect(openRefusal(session({ agentStatus: "busy" }), null)).toEqual({ error: "busy" })
  })

  test("another dialog up refuses rather than stacking on it", () => {
    expect(openRefusal(session(), mcp())).toEqual({ error: "other_dialog" })
  })

  test("the model picker already being open is not a refusal — it's the goal", () => {
    expect(openRefusal(session(), dialog())).toBeNull()
    // and it stays fine even if the session went busy behind it
    expect(openRefusal(session({ agentStatus: "busy" }), dialog())).toBeNull()
  })

  test("a CLI with no status file reports '' — treated as free, not blocked", () => {
    expect(openRefusal(session({ agentStatus: "" }), null)).toBeNull()
  })
})
