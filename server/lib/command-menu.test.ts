import { test, expect, describe } from "bun:test"
import { inputLine, mayClearLine, parseCommandMenu, suggestRefusal } from "./command-menu"
import type { Session } from "./sessions"
import type { Dialog } from "./dialogs"

// Captured verbatim off a real pane, 2026-09-14, Claude Code 2.1.270, after
// typing "/mo" into the input box.
const MENU = `

 ▐▛███▛█   Claude Code v2.1.270


  /model                                                     Set the AI model for Claude Code (currently Opus 5 (1M context))
  /mobile                                                    Show QR code to download the Claude mobile app
  /mood-board                                                This skill should be used when Jeremie wants to define the visual direction for a client website BEFORE going into Claude Design
                                                             (primary) or Stitch (fallback). Invoke when he says "mood board for [client]", "design direction for [client]", "what's the visual vibe …
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ /mo
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  🤖 👀 idle · Opus 5 (1M context) · cmd
`

function session(over: Partial<Session> = {}): Session {
  return {
    key: "claude:tty:/dev/ttys004", agent: "claude", label: "cmd", title: "",
    sidConfirmed: true, agentStatus: "idle", waitingFor: "", cwd: "/x", sessionId: "sid",
    termProgram: "", tty: "/dev/ttys004", iTermSessionId: "", tmuxPane: "%12", taskId: "",
    waitingSince: 0, waitingKind: "", waitingRef: "", waitingReasons: [],
    pid: "1", firstSeenAt: 0, lastSeenAt: 0, model: "",
    ...over,
  } as Session
}

const someDialog = { kind: "dialog", title: "Select model", body: "", items: [], more: "", hints: [], numbered: true } as Dialog

describe("parseCommandMenu reads Claude Code's own filtered list", () => {
  test("every row comes back with its description", () => {
    const rows = parseCommandMenu(MENU)
    expect(rows.map((r) => r.name)).toEqual(["/model", "/mobile", "/mood-board"])
    expect(rows[0]?.description).toBe("Set the AI model for Claude Code (currently Opus 5 (1M context))")
    expect(rows[1]?.description).toBe("Show QR code to download the Claude mobile app")
  })

  test("a wrapped description folds back into its row", () => {
    const rows = parseCommandMenu(MENU)
    // The second line of /mood-board's description is indented to the
    // description column; dropping it would truncate mid-sentence.
    expect(rows[2]?.description).toContain("BEFORE going into Claude Design")
    expect(rows[2]?.description).toContain("(primary) or Stitch (fallback)")
  })

  test("the startup header never folds into the last row", () => {
    const rows = parseCommandMenu(MENU)
    for (const r of rows) expect(r.description).not.toContain("Claude Code v2.1.270")
  })

  test("no menu open yields nothing rather than guessing", () => {
    expect(parseCommandMenu("\u276f\u00a0\n")).toEqual([])
    expect(parseCommandMenu("")).toEqual([])
  })
})

describe("inputLine reads what the user has typed", () => {
  test("returns the text after the prompt marker", () => {
    expect(inputLine(MENU)).toBe("/mo")
  })

  test("an empty box is an empty string, not null — null means no prompt at all", () => {
    expect(inputLine("\u276f\u00a0")).toBe("")
    expect(inputLine("no prompt here")).toBeNull()
  })
})

describe("suggestRefusal protects the user's own input line", () => {
  test("an idle session with an empty box is fine", () => {
    expect(suggestRefusal(session(), null, "", "")).toBeNull()
  })

  test("text the user typed themselves refuses — clearing it would destroy it", () => {
    expect(suggestRefusal(session(), null, "deploy the thing", "")).toEqual({ error: "input_busy" })
  })

  test("our own in-flight prefix does not count as the user's text", () => {
    // Second keystroke: the line already holds what we typed last time.
    expect(suggestRefusal(session(), null, "/mo", "/mo")).toBeNull()
  })

  test("mid-turn, dialog, and no-pane each refuse", () => {
    expect(suggestRefusal(session({ agentStatus: "busy" }), null, "", "")).toEqual({ error: "busy" })
    expect(suggestRefusal(session(), someDialog, "", "")).toEqual({ error: "other_dialog" })
    expect(suggestRefusal(session({ tmuxPane: "" }), null, "", "")).toEqual({ error: "no_pane" })
    expect(suggestRefusal(null, null, "", "")).toEqual({ error: "no_pane" })
  })
})

describe("the empty box is not blank on screen", () => {
  // Found by prod verify: a fresh session renders a rotating hint in the
  // input box. Reading it as the user's text made every suggestion refuse.
  test("Claude Code's placeholder reads as empty, not as user text", () => {
    expect(inputLine('❯ Try "write a test for <filepath>"')).toBe("")
    expect(inputLine('❯ Try "how do I log an error?"')).toBe("")
    expect(suggestRefusal(session(), null, inputLine('❯ Try "anything"'), "")).toBeNull()
  })

  test("real text that merely starts with Try is still the user's", () => {
    expect(inputLine("❯ Try the other approach")).toBe("Try the other approach")
  })
})

describe("inputLine on a styled capture (capture-pane -e)", () => {
  // Claude Code paints a predicted next reply into the empty box as DIM text
  // (SGR 2), cursor still at column 2. Plain capture-pane shows it as typed.
  const DIM_PREDICTION = "\x1b[1m❯\x1b[22m \x1b[2mrun the tests again and fix whatever fails\x1b[0m"

  test("dim-only input is an empty box", () => {
    expect(inputLine(DIM_PREDICTION)).toBe("")
    expect(inputLine(`────────────\n${DIM_PREDICTION}\n────────────`)).toBe("")
  })

  test("the same line captured without -e still reads as typed (why -e is needed)", () => {
    expect(inputLine("❯ run the tests again and fix whatever fails")).toBe("run the tests again and fix whatever fails")
  })

  test("a combined SGR that turns dim on counts too", () => {
    expect(inputLine("❯ \x1b[2;38;5;244mprediction\x1b[0m")).toBe("")
  })

  test("the 2 inside a truecolour/256-colour SGR is not dim", () => {
    expect(inputLine("❯ \x1b[38;2;255;2;2mhello\x1b[39m")).toBe("hello")
    expect(inputLine("❯ \x1b[38;5;2mhello\x1b[39m")).toBe("hello")
  })

  test("dim turned off again (SGR 22) is the user's text", () => {
    expect(inputLine("❯ \x1b[2mghost\x1b[22m typed")).toBe("typed")
  })

  test("an inverse fake cursor on the prediction's first char is still empty", () => {
    expect(inputLine("❯ \x1b[7mr\x1b[27m\x1b[2mun the tests\x1b[0m")).toBe("")
  })

  test("a real char under an inverse cursor, no ghost text, is typed", () => {
    expect(inputLine("❯ \x1b[7mx\x1b[27m")).toBe("x")
  })

  test("typed text with a dim completion suffix returns only the typed part", () => {
    expect(inputLine("❯ /mo\x1b[2mdel\x1b[0m")).toBe("/mo")
  })

  test("a dim placeholder is empty; a styled prompt marker still anchors", () => {
    expect(inputLine('\x1b[38;5;244m❯\x1b[39m \x1b[2mTry "write a test"\x1b[0m')).toBe("")
    expect(inputLine("\x1b[38;5;244m❯\x1b[39m ")).toBe("")
  })
})

// ── PR #55: never C-u a line the flow did not type ──

test("mayClearLine: empty or our own text only; unreadable never", () => {
  expect(mayClearLine("", ["/mo"])).toBe(true)
  expect(mayClearLine("/mo", ["/mo"])).toBe(true)
  expect(mayClearLine("/help", ["/help"])).toBe(true)
  expect(mayClearLine("done, service is running", ["/mo"])).toBe(false)
  expect(mayClearLine("/mod", ["/mo"])).toBe(false)
  expect(mayClearLine(null, ["/mo"])).toBe(false)
})

test("mayClearLine on a real -e capture: Claude Code's dim predicted reply counts as empty", () => {
  const div = "─".repeat(40)
  const ghost = `${div}\n❯ \x1b[2mdone, service is running\x1b[0m\n${div}\n  ⏸ manual mode on\n`
  const typed = `${div}\n❯ done, service is running\n${div}\n  ⏸ manual mode on\n`
  expect(mayClearLine(inputLine(ghost), ["/help"])).toBe(true)
  expect(mayClearLine(inputLine(typed), ["/help"])).toBe(false)
})

test("suggestRefusal: an unreadable input line refuses instead of reading as empty", () => {
  const session = { tmuxPane: "%1", agentStatus: "idle" } as unknown as Parameters<typeof suggestRefusal>[0]
  expect(suggestRefusal(session, null, null, "/mo")).toEqual({ error: "input_busy" })
  expect(suggestRefusal(session, null, "", "/mo")).toBeNull()
})
