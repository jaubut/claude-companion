import { test, expect, describe } from "bun:test"
import { CLEAN_CONFIRM_GAP_MS, CLEAR_SETTLE_MS, closeHelpOverlay, ESC_SETTLE_MS, filterCommands, HELP_CLOSE_OPEN_WAIT_MS, HELP_PAINT_MS, helpOverlayVisible, helpTab, listIncomplete, mergePages, pageBudget, parseHelpPage, scrapeHelpTab, type HelpTab } from "./command-list"
import { SCRAPE_ABORT_WAIT_MS } from "./command-scrape"

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
    expect(stopped.res.incomplete).toBe(true)
    expect(stopped.pane.downs).toBe(0)
    expect(pane.downs).toBeGreaterThan(0)
  })
})

// F2 — the page CAP had the same bug as the row STEP: a constant read off one
// terminal. MAX_PAGES = 40 is ten screens on a Mac and a third of the list on
// an 80x24 pane, where the real 356 commands need 72 pages at 5 rows. The
// scrape returned 196 and reported success, so routes/command.ts cached a
// truncated list for an hour. The cap is now expressed in COMMANDS and
// divided by the rows this pane can actually show.
describe("scrapeHelpTab page budget", () => {
  // The real count measured on the Zettlab host, 2026-09-18.
  const names356 = Array.from({ length: 356 }, (_, i) => `/cmd-${String(i).padStart(3, "0")}`)

  async function scrape356(rows: number, over: { maxPages?: number; maxCommands?: number } = {}) {
    const pane = new FakeHelpPane(names356, rows, "default")
    const res = await scrapeHelpTab({
      tab: "default",
      capture: async () => pane.render(),
      pageDown: async (n) => pane.down(n),
      ...over,
    })
    return { res, pane }
  }

  test("the budget scales with the pane: 356 commands come back whole at 5 AND at 17 rows", async () => {
    const small = await scrape356(5)
    const large = await scrape356(17)
    expect(small.res.commands.map((c) => c.name)).toEqual(names356)
    expect(large.res.commands.map((c) => c.name)).toEqual(names356)
    expect(small.res.incomplete).toBe(false)
    expect(large.res.incomplete).toBe(false)
    // The old constant: 40 pages could never have reached the end at 5 rows.
    expect(small.res.pages).toBeGreaterThan(40)
    expect(large.res.pages).toBeLessThan(40)
  })

  test("pageBudget: enough pages for the whole list at any height, always capped", () => {
    expect(pageBudget(5, 356)).toBeGreaterThanOrEqual(72)
    expect(pageBudget(17, 356)).toBeGreaterThanOrEqual(21)
    expect(pageBudget(17, 356)).toBeLessThan(pageBudget(5, 356))
    // A pane that parses nothing must not page forever.
    expect(pageBudget(0, 356)).toBeGreaterThan(0)
    expect(pageBudget(1, 1_000_000)).toBeLessThanOrEqual(400)
  })

  test("a budget that runs out reports incomplete instead of reporting success", async () => {
    // Exactly the old behaviour, forced: 40 pages against a 5-row pane.
    const { res } = await scrape356(5, { maxPages: 40 })
    expect(res.pages).toBe(40)
    expect(res.commands.length).toBeLessThan(names356.length)
    // The bit routes/command.ts keys the "do not cache this" decision on.
    expect(res.incomplete).toBe(true)
    expect(res.aborted).toBe(false)
  })

  test("a complete scrape is never flagged incomplete", async () => {
    const { res } = await scrape356(17)
    expect(res.incomplete).toBe(false)
    expect(res.commands).toHaveLength(356)
  })
})

// F4 — an abort can land between typing /help+Enter and Claude Code painting
// the dialog. An Escape sent THEN hits nothing, the dialog paints a moment
// later, and endFlow hands the pane back with a modal up: the inject that
// asked for the pane types straight into the help list. Closing is a bounded
// poll for the overlay, then Escape, then a check that the input line really
// is empty.
describe("closeHelpOverlay", () => {
  const HELP = [
    "   Help  General   Commands   Custom commands",
    "   Browse default commands",
    "   ❯ /add-dir",
    "       Add a new working directory",
    "   Esc to cancel",
  ].join("\n")
  const IDLE = ["────────────", "❯ ", "────────────"].join("\n")
  const TYPED = ["────────────", "❯ /help", "────────────"].join("\n")
  // What /help ACTUALLY opens on: the General tab. No "Browse … commands"
  // line anywhere on it — captured 2026-09-18, Claude Code 2.1.270.
  const GENERAL = [
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
  ].join("\n")
  // tmux read the pane between two frames: the overlay is gone from the
  // capture and the prompt has not been drawn back yet.
  const BLANK = ["", "", ""].join("\n")

  interface Rig {
    // Virtual clock. Both the deadlines AND the chord-settle windows are real
    // durations, so a test that ran on Date.now() with instant sleeps could
    // only ever spin: the loop would poll millions of times waiting for 250ms
    // of wall clock. Owning the clock makes the suite instant AND makes "no
    // key inside the window" assertable at all.
    t: number
    pane: string
    escapes: number
    clears: number
    captures: number
    slept: number
    // Every key sent, with the virtual time it went out — the timeline the
    // ESC_SETTLE_MS rule is checked against.
    keys: Array<{ key: "Escape" | "C-u"; at: number }>
    // Every capture, same clock: the verdict capture must also be outside the
    // window, not just the next key.
    captureAt: number[]
  }

  function newRig(pane = IDLE): Rig {
    return { t: 0, pane, escapes: 0, clears: 0, captures: 0, slept: 0, keys: [], captureAt: [] }
  }

  // Full deps on the rig's clock. Overrides get the rig and run BEFORE the
  // bookkeeping is read, exactly like the real pane reacting to the key.
  function deps(r: Rig, o: {
    capture?: () => string | null
    onEscape?: () => void
    onClear?: () => void
    openWaitMs?: number
    clearWaitMs?: number
    pollMs?: number
    enterAt?: number
    paintMs?: number
  } = {}): Parameters<typeof closeHelpOverlay>[0] {
    return {
      capture: async () => { r.captures++; r.captureAt.push(r.t); return o.capture ? o.capture() : r.pane },
      escape: async () => { r.escapes++; r.keys.push({ key: "Escape", at: r.t }); o.onEscape?.() },
      clearLine: async () => { r.clears++; r.keys.push({ key: "C-u", at: r.t }); o.onClear?.() },
      sleep: async (ms: number) => { r.slept++; r.t += ms },
      now: () => r.t,
      openWaitMs: o.openWaitMs ?? 2_000,
      clearWaitMs: o.clearWaitMs ?? 2_000,
      pollMs: o.pollMs ?? 120,
      enterAt: o.enterAt ?? -HELP_PAINT_MS,   // the paint window is already over unless a test says otherwise
      paintMs: o.paintMs ?? HELP_PAINT_MS,
    }
  }

  // The gap between every key and whatever came next — key or capture.
  function shortestGapAfterEscape(r: Rig): number {
    let worst = Infinity
    for (const k of r.keys) {
      if (k.key !== "Escape") continue
      const nextEvent = [
        ...r.keys.filter((x) => x.at > k.at).map((x) => x.at),
        ...r.captureAt.filter((a) => a > k.at),
      ].sort((a, b) => a - b)[0]
      if (nextEvent !== undefined) worst = Math.min(worst, nextEvent - k.at)
    }
    return worst
  }

  function rig(script: (r: Rig) => void): { r: Rig; run: () => ReturnType<typeof closeHelpOverlay> } {
    const r = newRig()
    const run = () => closeHelpOverlay(deps(r, { onEscape: () => script(r), onClear: () => script(r) }))
    return { r, run }
  }

  test("waits for the overlay to paint before Escaping it", async () => {
    // The abort beat the redraw: /help has been typed and entered, the dialog
    // is still three polls away.
    const r = newRig(TYPED)
    let escapedAtPoll = -1
    const res = await closeHelpOverlay(deps(r, {
      capture: () => { if (r.captures === 4 && !r.escapes) r.pane = HELP; return r.pane },
      onEscape: () => { escapedAtPoll = r.captures; r.pane = TYPED },
      onClear: () => { if (r.pane === TYPED) r.pane = IDLE },
    }))
    expect(res).toEqual({ sawOverlay: true, clean: true })
    // The Escape waited for the dialog instead of firing at a pane that had
    // not painted it yet — the bug: an early Escape does nothing and the
    // modal then opens behind the released flow.
    expect(escapedAtPoll).toBe(4)
    expect(r.escapes).toBe(1)
  })

  test("Escapes an overlay that is already up, then confirms the line is empty", async () => {
    const { r, run } = rig((rr) => { rr.pane = IDLE })
    r.pane = HELP
    const res = await run()
    expect(res).toEqual({ sawOverlay: true, clean: true })
    expect(r.escapes).toBe(1)
  })

  test("text Escape left behind is cleared before the pane is released", async () => {
    // Escape closes the menu and KEEPS the typed text; only C-u kills it.
    const r = newRig(HELP)
    const res = await closeHelpOverlay(deps(r, {
      onEscape: () => { r.pane = TYPED },
      onClear: () => { if (r.pane === TYPED) r.pane = IDLE },
    }))
    expect(res).toEqual({ sawOverlay: true, clean: true })
    expect(r.pane).toBe(IDLE)
    // …and the C-u did NOT ride the Escape's coat-tails. Sent back to back the
    // terminal reads ESC+C-u as one meta chord: the Escape never fires, the
    // overlay stays up, and the C-u is swallowed.
    expect(r.keys.map((k) => k.key)).toEqual(["Escape", "C-u"])
    expect(r.keys[1]!.at - r.keys[0]!.at).toBeGreaterThanOrEqual(ESC_SETTLE_MS)
  })

  test("a pane that never comes clean is reported, not assumed", async () => {
    const r = newRig(HELP)
    const res = await closeHelpOverlay(deps(r, {
      capture: () => r.pane,   // stuck on the overlay
      openWaitMs: 300, clearWaitMs: 1_500,
    }))
    expect(res.sawOverlay).toBe(true)
    expect(res.clean).toBe(false)
    // It kept trying the matching key rather than giving up after one.
    expect(r.escapes).toBeGreaterThan(1)
    // Every retry Escape kept its own quiet window too.
    expect(shortestGapAfterEscape(r)).toBeGreaterThanOrEqual(ESC_SETTLE_MS)
  })

  // G2 — the overlay was detected with helpTab(), which only matches
  // "Browse default|custom commands". /help opens on the GENERAL tab, which
  // has no such line: an abort landing in the open window saw no overlay to
  // Escape, and the clean-check `!helpTab(text)` then passed with Help still
  // on screen. The title line is on every tab, so that is what to look for.
  test("the General tab IS the overlay — the tab matcher cannot see it", () => {
    expect(helpTab(GENERAL)).toBeNull()          // the old detector: blind
    expect(helpOverlayVisible(GENERAL)).toBe(true)
    // Still true for the tabs that do have a Browse line.
    expect(helpOverlayVisible(HELP)).toBe(true)
    expect(helpOverlayVisible(IDLE)).toBe(false)
  })

  test("a /help sitting on General is waited for, Escaped, and confirmed gone", async () => {
    const r = newRig(TYPED)
    const res = await closeHelpOverlay(deps(r, {
      // The abort beat the paint: the General tab appears on the 3rd poll.
      capture: () => { if (r.captures === 3 && !r.escapes) r.pane = GENERAL; return r.pane },
      onEscape: () => { r.pane = TYPED },
      onClear: () => { if (r.pane === TYPED) r.pane = IDLE },
    }))
    expect(res).toEqual({ sawOverlay: true, clean: true })
    expect(r.escapes).toBe(1)
  })

  test("a blank capture is NOT clean — no prompt line is no evidence", async () => {
    const r = newRig(HELP)
    const res = await closeHelpOverlay(deps(r, {
      // Escape closes the overlay; the pane is then mid-repaint forever.
      onEscape: () => { r.pane = BLANK },
      openWaitMs: 300, clearWaitMs: 600,
    }))
    expect(res).toEqual({ sawOverlay: true, clean: false })
    // It polled the blank pane instead of calling the first one clean — the
    // old check only asked "is there text on the prompt line", which a missing
    // prompt answers "no".
    expect(r.captures).toBeGreaterThan(2)
  })

  test("repaint then prompt: the blank frames are polled through, the end is clean", async () => {
    const r = newRig(HELP)
    let cleanAtCapture = -1
    const res = await closeHelpOverlay(deps(r, {
      // 1: HELP (open-wait). 2-4: blank, still repainting. 5: prompt back.
      capture: () => { if (r.escapes && r.captures >= 5) r.pane = IDLE; return r.pane },
      onEscape: () => { r.pane = BLANK },
      onClear: () => { cleanAtCapture = r.captures },
    }))
    expect(res).toEqual({ sawOverlay: true, clean: true })
    expect(r.captures).toBeGreaterThanOrEqual(5)
    expect(cleanAtCapture).toBeGreaterThan(0)
  })

  // ── R3 — Escape is a chord prefix, and the hand-off typed inside it ───────
  //
  // Post-deploy E2E, Zettlab 2026-09-18, 3/3: spawn → POST /api/command/list
  // force → POST /api/inject "ping" at ~7s. The inject answered 200 "delivered
  // (tmux)" and the pane showed "❯ ing" — the "p" AND the Enter gone, no
  // UserPromptSubmit hook, and the next scrape refused with input_busy because
  // "ing" was sitting in the box. Raw-tmux experiments on the same host found
  // why: a byte arriving a few ms after ESC is a META CHORD (ESC p = opt+p,
  // "switch model"; ESC C-u = an unknown chord), so the Escape does not act as
  // Escape and the byte after it is swallowed. 100ms+ always delivered.
  test("R3: no key is ever sent inside an Escape's chord window", async () => {
    const r = newRig(HELP)
    const res = await closeHelpOverlay(deps(r, {
      // A stubborn overlay: the first Escape does nothing (it was a chord, in
      // the world this guards against), the second closes it and leaves text.
      onEscape: () => { r.pane = r.escapes >= 2 ? TYPED : HELP },
      onClear: () => { if (r.pane === TYPED) r.pane = IDLE },
    }))
    expect(res.clean).toBe(true)
    expect(r.escapes).toBeGreaterThan(1)
    expect(shortestGapAfterEscape(r)).toBeGreaterThanOrEqual(ESC_SETTLE_MS)
  })

  test("R3: the clean verdict needs a quiet keyboard, not just a quiet pane", async () => {
    const r = newRig(HELP)
    const res = await closeHelpOverlay(deps(r, { onEscape: () => { r.pane = IDLE } }))
    expect(res).toEqual({ sawOverlay: true, clean: true })
    // The capture the verdict rests on was taken outside every key's window —
    // this is the assertion the regression would have failed: the old code
    // returned clean 10-40ms after its last Escape, endFlow released, and the
    // inject typed into the tail of the chord.
    const verdictAt = r.captureAt.at(-1)!
    const lastKeyAt = r.keys.at(-1)!.at
    expect(verdictAt - lastKeyAt).toBeGreaterThanOrEqual(ESC_SETTLE_MS)
  })

  test("R3: one good frame is not a settled pane — two, a gap apart, are", async () => {
    const r = newRig(HELP)
    // The pane flickers clean for exactly one capture, then the dialog is back:
    // a repaint caught mid-flight. One capture would have released on it.
    let cleanFrames = 0
    const res = await closeHelpOverlay(deps(r, {
      capture: () => {
        if (r.escapes && cleanFrames < 1) { cleanFrames++; return IDLE }
        return HELP
      },
      openWaitMs: 300, clearWaitMs: 900,
    }))
    expect(res.clean).toBe(false)
  })

  // R2 — the open wait was SHORTER than the paint.
  //
  // The route waited 1.5s for the overlay against an 1.8s paint. An abort
  // landing at ~300ms found a pane with no overlay and — because the Enter had
  // already submitted /help and emptied the input line — a perfectly clean
  // prompt. It polled that, gave up, Escaped a dialog that did not exist yet,
  // read the same clean prompt and released the flow CLEAN. The dialog painted
  // 300ms later onto a pane nobody was holding, and the phone's next message
  // went into the help list.
  //
  // Fixture throughout: Enter at t=0, abort at t=300, Claude Code paints at
  // t=1800. Virtual clock, so the 1.8s costs the suite nothing.
  function paintingPane(paintAt = 1_800) {
    let t = 300
    let state: "pending" | "open" | "closed" = "pending"
    const r = { captures: 0, escapes: 0, clears: 0, escapedAt: -1 }
    const advance = (ms: number): void => {
      t += ms
      if (state === "pending" && t >= paintAt) state = "open"
    }
    return {
      r,
      advance,
      state: () => state,
      deps: {
        capture: async () => { r.captures++; return state === "open" ? GENERAL : IDLE },
        // An Escape sent before the dialog exists hits nothing — and does not
        // stop it from opening a moment later. That is the whole bug.
        escape: async () => { r.escapes++; r.escapedAt = t; if (state === "open") state = "closed" },
        clearLine: async () => { r.clears++ },   // the Enter already emptied the line
        sleep: async (ms: number) => { advance(ms) },
        now: () => t,
        enterAt: 0,
        paintMs: 1_800,
        pollMs: 120,
      },
    }
  }

  test("R2: an abort inside the paint window waits the dialog out instead of calling the pane clean", async () => {
    const f = paintingPane()
    const res = await closeHelpOverlay({ ...f.deps, openWaitMs: HELP_CLOSE_OPEN_WAIT_MS, clearWaitMs: 1_500 })
    expect(res).toEqual({ sawOverlay: true, clean: true })
    // The Escape hit a dialog that had actually painted, and the pane handed
    // over is the one that was looked at AFTER it closed.
    expect(f.r.escapedAt).toBeGreaterThanOrEqual(1_800)
    expect(f.state()).toBe("closed")
  })

  test("R2: an open wait that expires before the paint is UNVERIFIED, so the pane is released dirty", async () => {
    const f = paintingPane()
    // The old shape: give up before a dialog that paints at t=1800. The wait is
    // sized so that even the Escape's settle does not carry us past the paint —
    // the point of the test is the pane nobody has evidence about.
    const res = await closeHelpOverlay({ ...f.deps, openWaitMs: 800, clearWaitMs: 200 })
    // No overlay ever seen and the paint window never waited out: "clean" here
    // would be an absence of evidence. clean:false → endFlow(key,{clean:false})
    // → both inject paths answer busy_flow.
    expect(res).toEqual({ sawOverlay: false, clean: false })
    // And refusing was right: the dialog lands a moment after the release.
    f.advance(300)
    expect(f.state()).toBe("open")
  })

  test("R2: past the paint window a clean prompt is taken at its word — no extra second per close", async () => {
    let t = 5_000
    const r = { captures: 0, escapes: 0 }
    const res = await closeHelpOverlay({
      capture: async () => { r.captures++; return IDLE },
      escape: async () => { r.escapes++ },
      clearLine: async () => { /* nothing to clear */ },
      sleep: async (ms: number) => { t += ms },
      now: () => t,
      enterAt: 0,
      paintMs: HELP_PAINT_MS,
      openWaitMs: HELP_CLOSE_OPEN_WAIT_MS,
      clearWaitMs: 1_500,
      pollMs: 120,
    })
    expect(res).toEqual({ sawOverlay: false, clean: true })
    // One capture leaves the open wait immediately — the longer wait still
    // costs nothing when the overlay is already gone. What it now costs is the
    // chord window: the Escape's 250ms settle, the C-u's 50ms, then polls until
    // the keyboard has been quiet for ESC_SETTLE_MS and two captures a gap
    // apart agree. Sub-second, and it is the price of not eating the first
    // character of the message the phone is about to send.
    expect(r.captures).toBe(5)
    expect(t - 5_000).toBe(660)
    expect(t - 5_000).toBeLessThan(1_000)
  })

  test("R2/R3: the open wait outlasts the paint, and the whole close fits the abort budget", () => {
    expect(HELP_CLOSE_OPEN_WAIT_MS).toBeGreaterThan(HELP_PAINT_MS)
    // The route's clear wait is 1.5s; an inject aborting the scrape gives up at
    // SCRAPE_ABORT_WAIT_MS, and must be answered before it does. The settles
    // are part of that budget now: open wait + one Escape + one C-u + clear
    // wait, and then yieldPane's own settle after the release.
    const worstClose = HELP_CLOSE_OPEN_WAIT_MS + ESC_SETTLE_MS + CLEAR_SETTLE_MS + 1_500
    expect(worstClose + ESC_SETTLE_MS).toBeLessThan(SCRAPE_ABORT_WAIT_MS)
    // The chord floor measured on the host was 100ms; the settle has to clear
    // it with room for a loaded box, and the confirm gap is a whole frame.
    expect(ESC_SETTLE_MS).toBeGreaterThanOrEqual(100)
    expect(CLEAN_CONFIRM_GAP_MS).toBeGreaterThanOrEqual(100)
  })
})

// G3 — a tab that bailed on `wrongTab` returned zero commands and was left OUT
// of the incomplete test, so a run where the custom tab never opened cached a
// default-only list: no skills, no project commands, for an hour, on every
// phone pointed at that host.
describe("listIncomplete", () => {
  const ok = { aborted: false, wrongTab: false, incomplete: false }

  test("both tabs read to the end → cacheable", () => {
    expect(listIncomplete([ok, ok])).toBe(false)
  })

  test("a tab that bailed on the wrong tab is incomplete, so it is not cached", () => {
    expect(listIncomplete([ok, { aborted: false, wrongTab: true, incomplete: false }])).toBe(true)
    // …even when it is the FIRST tab that bailed.
    expect(listIncomplete([{ aborted: false, wrongTab: true, incomplete: false }, ok])).toBe(true)
  })

  test("a budget-exhausted tab is incomplete too", () => {
    expect(listIncomplete([ok, { aborted: false, wrongTab: false, incomplete: true }])).toBe(true)
  })

  test("an aborted tab is the route's 409, not a caching decision", () => {
    expect(listIncomplete([{ aborted: true, wrongTab: false, incomplete: true }])).toBe(false)
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
