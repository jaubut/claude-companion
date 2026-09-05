import { test, expect } from "bun:test"
import { parseDialog, parseHints, pickKeys } from "./dialogs"

const MODEL = `
 ▐▛███▛█   Claude Code v2.1.261
▝▜██████▀  Opus 5 (1M context) with xhigh effort · Claude Max
⚠ 3 MCP servers need authentication · run /mcp
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Select model
   Switch between Claude models. Your pick becomes the default for new
   sessions. For other/previous model names, specify with --model.
   ❯ 1. Default (recommended) ✔  Opus 5 with 1M context · Best for everyday,
                                 complex tasks
   ↓ 2. Opus (1M context)        Opus 5 with 1M context · Best for everyday,
                                 complex tasks
      … +3 models
   ◉ xHigh effort ←/→ to adjust
   Use /fast to turn on Fast mode (Opus 5).
   Enter to set as default · s to use this session only · Esc to cancel
`

const MCP = `
   Manage MCP servers
   18 servers
     User MCPs (/Users/jeremieaubut/.claude.json)
   ❯ birds-n-clubs-store · ✘ failed
     blender · ✔ connected · 22 tools
     chrome-devtools · ✔ connected · 29 tools
     claude.ai
     claude.ai Coros · △ needs authentication
     ↓ 10 more below
   ※ Run claude --debug to see error logs
   https://code.claude.com/docs/en/mcp for help
   ↑/↓ to navigate · Enter to confirm · Esc to cancel
`

const QUESTION = `
❯ Use the AskUserQuestion tool right now
────────────────────────────────────────────────────────────────────────────────
←  ☐ Color  ☐ Toppings  ✔ Submit  →
Pick one color
❯ 1. Red
     Red
  2. Green
     Green
  3. Blue
     Blue
  4. Type something.
────────────────────────────────────────────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`

const IDLE = `
⚠ 2 MCP servers need authentication · run /mcp
                                                             ◉ xhigh · /effort
────────────────────────────────────────────────────────────────────────────────
❯ Try "how does <filepath> work?"
────────────────────────────────────────────────────────────────────────────────
  🤖 👀 idle · Opus 5 (1M context) · dlg-untrusted-19518       /rc connecting…
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent
`

test("/model picker: title, body, numbered rows with continuation, notes, hints", () => {
  const d = parseDialog(MODEL)!
  expect(d).not.toBeNull()
  expect(d.title).toBe("Select model")
  expect(d.body).toContain("Switch between Claude models.")
  expect(d.numbered).toBe(true)
  expect(d.items.map((i) => [i.number, i.cursor, i.selected])).toEqual([[1, true, true], [2, false, false]])
  expect(d.items[0]!.text).toBe("Default (recommended) Opus 5 with 1M context · Best for everyday, complex tasks")
  expect(d.items[1]!.text).toBe("Opus (1M context) Opus 5 with 1M context · Best for everyday, complex tasks")
  expect(d.more).toBe("… +3 models")
  expect(d.body).toContain("xHigh effort")
  expect(d.hints).toEqual([
    { key: "Enter", label: "set as default" },
    { key: "s", label: "use this session only" },
    { key: "Escape", label: "cancel" },
  ])
})

test("/mcp list: un-numbered rows, cursor, more marker, arrow hints", () => {
  const d = parseDialog(MCP)!
  expect(d).not.toBeNull()
  expect(d.title).toBe("Manage MCP servers")
  expect(d.numbered).toBe(false)
  expect(d.items[0]).toMatchObject({ index: 0, cursor: true, text: "birds-n-clubs-store · ✘ failed" })
  expect(d.items.map((i) => i.text)).toContain("claude.ai Coros · △ needs authentication")
  expect(d.more).toBe("↓ 10 more below")
  expect(d.hints.map((h) => h.key)).toEqual(["Up", "Down", "Enter", "Escape"])
})

test("AskUserQuestion picker parses too (rows below the tab bar)", () => {
  const d = parseDialog(QUESTION)!
  expect(d).not.toBeNull()
  expect(d.numbered).toBe(true)
  expect(d.items.map((i) => i.number)).toEqual([1, 2, 3, 4, 5])
  expect(d.items[0]).toMatchObject({ cursor: true, text: "Red Red" })
  expect(d.hints.map((h) => h.key)).toEqual(["Enter", "Tab", "Escape"])
})

test("the idle input prompt is not a dialog", () => {
  expect(parseDialog(IDLE)).toBeNull()
  expect(parseDialog("")).toBeNull()
  expect(parseDialog("❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)")).toBeNull()
})

test("parseHints maps keys and splits combined arrows", () => {
  expect(parseHints("←/→ to adjust · y to confirm")).toEqual([
    { key: "Left", label: "adjust" }, { key: "Right", label: "adjust" }, { key: "y", label: "confirm" },
  ])
  expect(parseHints("nothing here")).toEqual([])
})

test("pickKeys moves the cursor with arrows from wherever it sits", () => {
  const d = parseDialog(MCP)!
  expect(pickKeys(d, 0)).toEqual([])
  expect(pickKeys(d, 3)).toEqual(["Down", "Down", "Down"])
  const moved = { ...d, items: d.items.map((it, i) => ({ ...it, cursor: i === 3 })) }
  expect(pickKeys(moved, 1)).toEqual(["Up", "Up"])
  expect(pickKeys(d, 99)).toBeNull()
  expect(pickKeys(d, -1)).toBeNull()
})
