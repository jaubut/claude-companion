import { test, expect, describe } from "bun:test"
import { filterCommands, helpTab, mergePages, parseHelpPage } from "./command-list"

// Shapes captured off real /help pages, 2026-09-16, Claude Code 2.1.270:
// cursor row renders "❯ /name", the last visible row of a page that has more
// below renders "↓ /name", custom names may contain a space.
const CUSTOM_PAGE = `
   Help  General   Commands   Custom commands
   Browse custom commands
     /agent development
       This skill should be used when the user asks to "create an agent", "add an agent", "write a subagent", "agent frontmatter", "when to use description", "agent examples", "agent tools", "…
     /ai-seo
       Optimize a site to be cited by AI search — ChatGPT, Claude, Perplexity, Gemini, Google AI Overviews, Copilot. Invoke when the user says "/ai-seo", "AI SEO for [client]", "get cited by C…
   ❯ /canary
       Post-deploy SRE monitor. Watches a Railway deployment for HTTP error rate spikes,…
   ↓ /caveman:caveman-review
       (caveman) Ultra-compressed code review comments. Cuts noise from PR feedback while preserving the actionable signal. Each comment is one line: location, problem, fix. Use when user says…
   For more help: https://code.claude.com/docs/en/overview
   Something else? Use /feedback to report bugs or request features.
   Esc to cancel
`

const DEFAULT_PAGE = `
   Browse default commands
     /add-dir
       Add a new working directory
     /advisor
       Let Claude consult a stronger model at key moments
     /mobile
       Show QR code to download the Claude mobile app
   ❯ /model
       Set the AI model for Claude Code (currently Opus 5 (1M context))
   For more help: https://code.claude.com/docs/en/overview
`

describe("parseHelpPage", () => {
  test("reads name + description pairs, through cursor and more-below markers", () => {
    const rows = parseHelpPage(CUSTOM_PAGE)
    expect(rows.map((r) => r.name)).toEqual([
      "/agent development", "/ai-seo", "/canary", "/caveman:caveman-review",
    ])
    expect(rows[2]?.description).toStartWith("Post-deploy SRE monitor.")
    // Truncation is Claude Code's, kept as-is rather than guessed at.
    expect(rows[3]?.description).toEndWith("…")
  })

  test("the footer never becomes a description", () => {
    const rows = parseHelpPage(DEFAULT_PAGE)
    expect(rows.at(-1)).toEqual({ name: "/model", description: "Set the AI model for Claude Code (currently Opus 5 (1M context))" })
    for (const r of rows) expect(r.description).not.toContain("For more help")
  })

  test("the tab is read off the header", () => {
    expect(helpTab(CUSTOM_PAGE)).toBe("custom")
    expect(helpTab(DEFAULT_PAGE)).toBe("default")
    expect(helpTab("nothing here")).toBeNull()
  })
})

describe("mergePages", () => {
  test("dedupes across the scroll overlap and keeps first-seen order", () => {
    const p1 = parseHelpPage(DEFAULT_PAGE)
    const p2 = [{ name: "/model", description: "" }, { name: "/rename", description: "Rename the session" }]
    const merged = mergePages([p1, p2], "default")
    expect(merged.map((c) => c.name)).toEqual(["/add-dir", "/advisor", "/mobile", "/model", "/rename"])
    // An empty description from a later page never overwrites a real one.
    expect(merged.find((c) => c.name === "/model")?.description).toContain("Set the AI model")
    expect(merged.every((c) => c.kind === "default")).toBe(true)
  })
})

describe("filterCommands", () => {
  const all = mergePages([parseHelpPage(DEFAULT_PAGE), parseHelpPage(CUSTOM_PAGE)], "default")

  test("empty query returns everything", () => {
    expect(filterCommands(all, "").length).toBe(all.length)
    expect(filterCommands(all, "/").length).toBe(all.length)
  })

  test("prefix beats substring beats description", () => {
    const names = filterCommands(all, "mo").map((c) => c.name)
    // /mobile and /model are prefix matches, in list order
    expect(names.slice(0, 2)).toEqual(["/mobile", "/model"])
    // "mo" also appears inside "/caveman:caveman-review"? no — but "monitor" is in /canary's description
    expect(names).toContain("/canary")
    expect(names.indexOf("/canary")).toBeGreaterThan(1)
  })

  test("case-insensitive, leading slash optional", () => {
    expect(filterCommands(all, "/AI-").map((c) => c.name)).toEqual(["/ai-seo"])
  })
})
