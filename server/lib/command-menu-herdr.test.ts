import { test, expect, describe } from "bun:test"
import { parseCommandMenu, unstyle } from "./command-menu"
import { herdrScreen } from "./herdr"

// Claude Code 2.1.310 changed the slash menu: the highlighted row now carries
// a "❯ " pointer and every other row is indented four spaces, not two. The
// 2.1.270 row shape (command-menu.test.ts MENU) still parses; these are the
// new shape, captured verbatim off a throwaway herdr pane (herdr 0.9.5,
// `pane read --source visible`, blank padding rows dropped), 2026-10-26.

// "/mo" typed, `--format ansi` (what realHerdr.read asks for), CRLF intact.
const HERDR_MO_ANSI: string = "\u001b[0m\u001b[38;2;215;119;87m ▐\u001b[0m\u001b[38;2;215;119;87m\u001b[48;2;0;0;0m▛███▛█   \u001b[0m\u001b[1mClaude Code \u001b[0m\u001b[38;2;153;153;153mv2.1.310\u001b[0m\r\n\u001b[0m\u001b[38;2;215;119;87m▝▜\u001b[0m\u001b[38;2;215;119;87m\u001b[48;2;0;0;0m█████\u001b[0m\u001b[38;2;215;119;87m█▀  \u001b[0m\u001b[38;2;153;153;153mOpus 5.5 · Claude Max\u001b[0m\r\n\u001b[0m\u001b[38;2;215;119;87m ▝▝   ▝▝   \u001b[0m\u001b[38;2;153;153;153m/private/tmp/x\u001b[0m\r\n\r\n  \u001b[0m\u001b[38;2;177;185;249m❯ /\u001b[0m\u001b[1m\u001b[38;2;177;185;249mmo\u001b[0m\u001b[38;2;177;185;249mdel                                                   Set the AI \u001b[0m\u001b[1m\u001b[38;2;177;185;249mmo\u001b[0m\u001b[38;2;177;185;249mdel for Claude Code (currently Opus 5.5)\u001b[0m\r\n  \u001b[0m\u001b[38;2;153;153;153m  /\u001b[0m\u001b[1mmo\u001b[0m\u001b[38;2;153;153;153mbile                                                  Show QR code to download the Claude \u001b[0m\u001b[1mmo\u001b[0m\u001b[38;2;153;153;153mbile app\u001b[0m\r\n  \u001b[0m\u001b[38;2;153;153;153m  /\u001b[0m\u001b[1mmo\u001b[0m\u001b[38;2;153;153;153mrning                                                 Render the user's \u001b[0m\u001b[1mmo\u001b[0m\u001b[38;2;153;153;153mrning brief as a styled HTML artifact, or set it up as a recurring\u001b[0m\r\n                                                             \u001b[0m\u001b[38;2;153;153;153mweekday task. Use only when the user explicitly asks to run, see, or set up their \u001b[0m\u001b[1mmo\u001b[0m\u001b[38;2;153;153;153mrnin…\u001b[0m\r\n\u001b[0m\u001b[38;2;136;136;136m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[0m\r\n❯ /mo\r\n\u001b[0m\u001b[38;2;136;136;136m────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\u001b[0m\r\n  \u001b[0m\u001b[38;2;153;153;153m🤖 👀 idle · Opus 5.5 · x\u001b[0m\r\n  \u001b[0m\u001b[38;2;255;193;7m⏵⏵ auto mode on\u001b[0m\u001b[38;2;153;153;153m (shift+tab to cycle)\u001b[0m"

// Same screen, `--format text`.
const HERDR_MO_TEXT: string = " ▐▛███▛█   Claude Code v2.1.310\n▝▜██████▀  Opus 5.5 · Claude Max\n ▝▝   ▝▝   /private/tmp/x\n\n  ❯ /model                                                   Set the AI model for Claude Code (currently Opus 5.5)\n    /mobile                                                  Show QR code to download the Claude mobile app\n    /morning                                                 Render the user's morning brief as a styled HTML artifact, or set it up as a recurring\n                                                             weekday task. Use only when the user explicitly asks to run, see, or set up their mornin…\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ /mo\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  🤖 👀 idle · Opus 5.5 · x\n  ⏵⏵ auto mode on (shift+tab to cycle)\n"

// "/" typed, `--format text`: the menu as it first opens.
const HERDR_SLASH_TEXT: string = " ▐▛███▛█   Claude Code v2.1.310\n▝▜██████▀  Opus 5.5 · Claude Max\n ▝▝   ▝▝   /private/tmp/x\n\n  ❯ /content-factory                                         Run the TLS content factory (content-inventory → content-spec ×N → weekly-scheduler):\n                                                             project backlog → weekly posting calendar. Invoke when the user says \"/content-factory\",…\n    /change                                                  Architect-gated change workflow for existing repos: regenerate the arch map, get a Change\n                                                             Plan from architect-change (contracts, owners, verify steps), then build to it with the …\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n❯ /\n────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n  🤖 👀 idle · Opus 5.5 · x\n  ⏵⏵ auto mode on (shift+tab to cycle)\n"

describe("parseCommandMenu reads the 2.1.310 menu (pointer row, 4-space rows)", () => {
  test("ANSI capture, unstyled the way the suggest route reads it", () => {
    const rows = parseCommandMenu(unstyle(herdrScreen(HERDR_MO_ANSI)))
    expect(rows.map((r) => r.name)).toEqual(["/model", "/mobile", "/morning"])
    expect(rows[0]?.description).toBe("Set the AI model for Claude Code (currently Opus 5.5)")
    expect(rows[1]?.description).toBe("Show QR code to download the Claude mobile app")
    expect(rows[2]?.description).toContain("set it up as a recurring weekday task")
  })

  test("plain text capture parses the same", () => {
    const rows = parseCommandMenu(herdrScreen(HERDR_MO_TEXT))
    expect(rows.map((r) => r.name)).toEqual(["/model", "/mobile", "/morning"])
  })

  test("the menu as it opens on a bare /", () => {
    const rows = parseCommandMenu(herdrScreen(HERDR_SLASH_TEXT))
    expect(rows.map((r) => r.name)).toEqual(["/content-factory", "/change"])
    expect(rows[1]?.description).toContain("Plan from architect-change")
  })

  test("the prompt line is never read as the pointer row", () => {
    for (const r of parseCommandMenu(herdrScreen(HERDR_MO_TEXT))) expect(r.name).not.toBe("/mo")
  })
})
