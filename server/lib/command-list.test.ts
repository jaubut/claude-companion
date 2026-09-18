import { test, expect, describe } from "bun:test"
import { filterCommands, helpTab, mergePages, parseHelpPage, scrapeHelpTab, type HelpTab } from "./command-list"

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

// A /help list as the pane renders it, for a terminal that can show `rows`
// command rows at once. Scrolling matches what was measured on a real dialog:
// the cursor walks down inside the window, and only once it is on the last
// visible row does a further Down scroll the list by one.
class FakeHelpPane {
  top = 0
  cursor = 0
  downs = 0
  constructor(readonly names: string[], readonly rows: number, readonly tab: HelpTab) {}

  render(): string {
    const out = [
      "   Help  General   Commands   Custom commands",
      `   Browse ${this.tab} commands`,
    ]
    const last = Math.min(this.top + this.rows, this.names.length)
    for (let i = this.top; i < last; i++) {
      const marker = i === this.cursor ? "❯" : i === last - 1 && last < this.names.length ? "↓" : " "
      out.push(`   ${marker} ${this.names[i]}`)
      out.push(`       Description number ${i}`)
    }
    out.push("   For more help: https://code.claude.com/docs/en/overview", "   Esc to cancel")
    return out.join("\n")
  }

  down(n: number): void {
    for (let k = 0; k < n; k++) {
      this.downs++
      if (this.cursor < this.names.length - 1) this.cursor++
      if (this.cursor > this.top + this.rows - 1) this.top = this.cursor - this.rows + 1
    }
  }
}

describe("scrapeHelpTab", () => {
  const names = Array.from({ length: 73 }, (_, i) => `/cmd-${String(i).padStart(3, "0")}`)

  async function scrape(rows: number, opts: { aborted?: () => boolean } = {}) {
    const pane = new FakeHelpPane(names, rows, "default")
    const res = await scrapeHelpTab({
      tab: "default",
      capture: async () => pane.render(),
      pageDown: async (n) => pane.down(n),
      aborted: opts.aborted,
    })
    return { res, pane }
  }

  // The bug: PAGE_ROWS was a constant 17, so a detached 80x24 tmux pane (5
  // rows of /help) was stepped 17 rows at a time and 12 of every 17 commands
  // were never rendered — 208 of 356 found on the Linux host. Stepping by the
  // rows actually on screen has to give the same list at any pane size.
  test("finds every command at 80x24 (5 rows) and at 220x60 (17 rows)", async () => {
    const small = await scrape(5)
    const large = await scrape(17)
    expect(small.res.commands.map((c) => c.name)).toEqual(names)
    expect(large.res.commands.map((c) => c.name)).toEqual(names)
    expect(small.res.rowsPerPage).toBe(5)
    expect(large.res.rowsPerPage).toBe(17)
    // Same list, more round trips on the cramped pane — that cost is the
    // reason spawn-session now sizes detached panes at 220x60.
    expect(small.res.pages).toBeGreaterThan(large.res.pages)
  })

  test("descriptions survive the paging, and nothing is duplicated", async () => {
    const { res } = await scrape(5)
    expect(res.commands).toHaveLength(names.length)
    expect(res.commands[0]).toEqual({ name: "/cmd-000", description: "Description number 0", kind: "default" })
    expect(res.commands.at(-1)?.description).toBe(`Description number ${names.length - 1}`)
  })

  test("a list shorter than one page still terminates", async () => {
    const pane = new FakeHelpPane(names.slice(0, 3), 17, "default")
    const res = await scrapeHelpTab({
      tab: "default",
      capture: async () => pane.render(),
      pageDown: async (n) => pane.down(n),
    })
    expect(res.commands.map((c) => c.name)).toEqual(names.slice(0, 3))
    expect(res.pages).toBeLessThanOrEqual(3)
  })

  test("the wrong tab bails instead of mislabelling rows", async () => {
    const pane = new FakeHelpPane(names, 17, "custom")
    const res = await scrapeHelpTab({
      tab: "default",
      capture: async () => pane.render(),
      pageDown: async (n) => pane.down(n),
    })
    expect(res.wrongTab).toBe(true)
    expect(res.commands).toEqual([])
    expect(pane.downs).toBe(0)
  })

  test("an abort stops the paging and reports what it had", async () => {
    let abort = false
    const { res, pane } = await scrape(5, { aborted: () => abort })
    expect(res.commands).toHaveLength(names.length)

    abort = true
    const stopped = await scrape(5, { aborted: () => abort })
    expect(stopped.res.aborted).toBe(true)
    expect(stopped.pane.downs).toBe(0)
    expect(pane.downs).toBeGreaterThan(0)
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
