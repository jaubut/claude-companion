import { describe, test, expect } from "bun:test"
import { injectRefusal, paneExcerpt, paneNotReady } from "./inject-guard"
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

// F1 — a pane the companion's own flow would not hand back.
test("a pane we could not take back refuses with busy_flow", () => {
  const r = injectRefusal({ lookup: "tty:/dev/ttys004", target: session(), paneFree: false, dialog: null })
  expect(r?.error).toBe("busy_flow")
})

test("busy_flow outranks the dialog check — with the flow held, `dialog` is a lie", () => {
  // While the /help scrape holds the pane, dialog-watch deliberately skips
  // that session, so `current()` has no entry even though our modal is on
  // screen. If busy_flow fell through to dialog_open's `dialog == null`, the
  // inject would proceed and type into the help list.
  const r = injectRefusal({ lookup: "tty:/dev/ttys004", target: session(), paneFree: false, dialog: null })
  expect(r?.error).not.toBe("dialog_open")
  expect(r?.error).toBe("busy_flow")
  // A freed pane is business as usual.
  expect(injectRefusal({ lookup: "tty:/dev/ttys004", target: session(), paneFree: true, dialog: null })).toBeNull()
  // And an unregistered target still refuses first.
  expect(injectRefusal({ lookup: "tty:/dev/ttys999", target: null, paneFree: false })?.error).toBe("target_gone")
})

test("a dialog on a session the caller did not address does not refuse", () => {
  // The caller passes the dialog for `target` only; a bystander's dialog never
  // reaches here. Guards the call sites against passing the wrong map entry.
  expect(injectRefusal({ lookup: "", target: null, dialog: null })).toBeNull()
})

// ── pane_not_ready — the pane itself, not the dialog record ──────────────────
//
// Audit 2026-09-24: three injects into Zettlab pane %89 logged "delivered
// (tmux)" with no UserPromptSubmit and nothing in the transcript. Each state
// below captures keys without dialog-watch ever recording a Dialog.

const DIV = "─".repeat(60)
const FOOTER = "  ⏵⏵ auto mode on (shift+tab to cycle)"
const STATUS = "  🤖 👀 idle · Opus 5 (1M context) · cmd"
const pane = (...lines: string[]) => lines.join("\n")

// Real shape (dialog-watch.test.ts IDLE_PANE, command-menu.test.ts MENU).
const IDLE = pane("● Done — all tests pass.", "", DIV, "❯\u00a0", DIV, FOOTER, STATUS, "")
// The idle box as `capture-pane -e` returns it with a predicted reply in it:
// dim text, cursor at column 2.
const IDLE_PREDICTION = pane(
  "● Done — all tests pass.", "",
  `\x1b[38;5;244m${DIV}\x1b[39m`,
  "\x1b[1m❯\x1b[22m\u00a0\x1b[2mcommit this and open a PR\x1b[0m",
  `\x1b[38;5;244m${DIV}\x1b[39m`,
  FOOTER, STATUS, "",
)
const IDLE_PLACEHOLDER = pane(DIV, '❯ Try "write a test for <filepath>"', DIV, FOOTER)
const TYPED = pane(DIV, "❯ deploy the thing", DIV, FOOTER)
const TYPED_MULTILINE = pane(DIV, "❯ ", "  second line the user typed", DIV, FOOTER)
// Left on an empty prompt: focus leaves the box for the agents panel, which
// draws its own key hints under it. Synthesised from the audit description —
// no verbatim capture exists yet; the check keys on the hint line, not on the
// panel's wording.
const AGENTS_PANEL = pane(
  DIV, "❯ ", DIV,
  "  ◀ main   ● build-api (running)   ● research (done)",
  "  ←/→ to select · Enter to view · Esc to close",
)
// Variant where the panel replaces the input box outright.
const AGENTS_PANEL_REPLACING = pane(
  DIV,
  "  Agents",
  "   ❯ build-api        running · 2m",
  "     research         done",
  "  ↑/↓ to select · Enter to view · Esc to go back",
)
// "?" on an empty prompt.
const SHORTCUTS = pane(
  DIV, "❯ ", DIV,
  "  ! for bash mode        double tap esc to clear input      ctrl + _ to undo",
  "  / for commands         shift + tab to auto-accept edits    ctrl + z to suspend",
  "  @ for file paths       ctrl + o for verbose output         cmd + v to paste images",
  "  # to memorize          ctrl + t to show todos",
)
// /help General tab, captured 2026-09-18, Claude Code 2.1.270
// (command-list.test.ts GENERAL). Painted late: dialog-watch had not seen it.
const HELP = pane(
  "   Help  General   Commands   Custom commands",
  "",
  "   Claude Code v2.1.270",
  "",
  "   Shortcuts:",
  "     Ctrl+C          Cancel the current generation",
  "     Ctrl+D          Exit Claude Code",
  "     Shift+Tab       Cycle permission modes",
  "",
  "   For more help: https://code.claude.com/docs/en/overview",
  "   Esc to cancel",
)

describe("paneNotReady — parser fixtures", () => {
  test("idle, empty box: ready", () => {
    expect(paneNotReady(IDLE)).toBeNull()
    expect(paneNotReady(IDLE_PLACEHOLDER)).toBeNull()
  })

  test("a dim predicted reply in the box is still an empty box", () => {
    expect(paneNotReady(IDLE_PREDICTION)).toBeNull()
  })

  test("the idle footer's own '? for shortcuts' hint is not the overlay", () => {
    expect(paneNotReady(pane(DIV, "❯ ", DIV, "  ? for shortcuts"))).toBeNull()
  })

  test("agents panel: key hints under the box", () => {
    expect(paneNotReady(AGENTS_PANEL)).toBe("panel_open")
  })

  test("agents panel replacing the box: no prompt line", () => {
    expect(paneNotReady(AGENTS_PANEL_REPLACING)).toBe("no_prompt")
  })

  test("shortcuts overlay", () => {
    expect(paneNotReady(SHORTCUTS)).toBe("shortcuts_overlay")
  })

  test("/help overlay", () => {
    expect(paneNotReady(HELP)).toBe("help_overlay")
  })

  test("non-empty input", () => {
    expect(paneNotReady(TYPED)).toBe("input_not_empty")
    expect(paneNotReady(TYPED_MULTILINE)).toBe("input_not_empty")
  })

  test("a prompt line outside the input box frame", () => {
    expect(paneNotReady(pane("some output", "❯ ", DIV))).toBe("prompt_unframed")
    expect(paneNotReady(pane(DIV, "❯ "))).toBe("prompt_unframed")
  })

  test("a failed capture", () => {
    expect(paneNotReady(null)).toBe("capture_failed")
  })

  test("the excerpt is the unstyled bottom of the pane", () => {
    const ex = paneExcerpt(IDLE_PREDICTION)
    expect(ex).not.toContain("\x1b")
    expect(ex).toContain("commit this and open a PR")
    expect(ex.split("\n").length).toBeLessThanOrEqual(8)
  })
})

describe("injectRefusal — pane_not_ready", () => {
  const at = { lookup: "tty:/dev/ttys004", target: session(), dialog: null, paneFree: true }

  test("an idle pane proceeds, prediction or not", () => {
    expect(injectRefusal({ ...at, pane: IDLE })).toBeNull()
    expect(injectRefusal({ ...at, pane: IDLE_PREDICTION })).toBeNull()
  })

  test("no capture to check (no tmux pane) proceeds as before", () => {
    expect(injectRefusal({ ...at, pane: undefined })).toBeNull()
  })

  const cases: Array<[string, string | null, string]> = [
    ["agents panel", AGENTS_PANEL, "panel_open"],
    ["agents panel replacing the box", AGENTS_PANEL_REPLACING, "no_prompt"],
    ["shortcuts overlay", SHORTCUTS, "shortcuts_overlay"],
    ["late /help", HELP, "help_overlay"],
    ["non-empty input", TYPED, "input_not_empty"],
    ["failed capture", null, "capture_failed"],
  ]
  for (const [name, p, reason] of cases) {
    test(`${name} refuses with pane_not_ready + excerpt`, () => {
      const r = injectRefusal({ ...at, pane: p })
      expect(r?.error).toBe("pane_not_ready")
      expect(r?.reason).toBe(reason as never)
      expect(r?.excerpt).toBe(paneExcerpt(p))
      if (p) expect(r!.excerpt!.length).toBeGreaterThan(0)
    })
  }

  test("a recorded dialog outranks the pane check — the phone can drive it", () => {
    const d = dialog()
    const r = injectRefusal({ ...at, dialog: d, pane: HELP })
    expect(r?.error).toBe("dialog_open")
    expect(r?.dialog).toBe(d)
  })

  test("earlier refusals still come first", () => {
    expect(injectRefusal({ ...at, target: null, lookup: "tty:/dev/ttys999", pane: HELP })?.error).toBe("target_gone")
    expect(injectRefusal({ ...at, target: session({ tty: "" }), pane: HELP })?.error).toBe("target_idle")
    expect(injectRefusal({ ...at, paneFree: false, pane: HELP })?.error).toBe("busy_flow")
  })
})
