import { test, expect, describe } from "bun:test"
import type { Herdr } from "./herdr"
import type { KeyGate } from "./key-gate"
import { herdrSessionPane, sessionPaneOf } from "./session-pane"
import { openRefusal } from "./model-control"
import { parseCommandMenu, suggestFromList, suggestRefusal } from "./command-menu"
import { createCommandLister } from "./command-offpane-cache"
import type { Session } from "./sessions"
import type { CommandEntry } from "./command-list"

// The 2.1.310 menu as herdr's `pane read --format ansi` returns it once
// herdrScreen has run (CRLF gone): pointer row + 4-space rows, styled.
const STYLED_MENU = [
  "  \x1b[0m\x1b[38;2;177;185;249m❯ /\x1b[0m\x1b[1m\x1b[38;2;177;185;249mmo\x1b[0m\x1b[38;2;177;185;249mdel                                                   Set the AI \x1b[0m\x1b[1m\x1b[38;2;177;185;249mmo\x1b[0m\x1b[38;2;177;185;249mdel for Claude Code (currently Opus 5.5)\x1b[0m",
  "  \x1b[0m\x1b[38;2;153;153;153m  /\x1b[0m\x1b[1mmo\x1b[0m\x1b[38;2;153;153;153mbile                                                  Show QR code to download the Claude \x1b[0m\x1b[1mmo\x1b[0m\x1b[38;2;153;153;153mbile app\x1b[0m",
  "\x1b[0m\x1b[38;2;136;136;136m────────────────────────────────────────\x1b[0m",
  "❯ /mo",
  "\x1b[0m\x1b[38;2;136;136;136m────────────────────────────────────────\x1b[0m",
].join("\n")

function fakeHerdr(screen: string | null = STYLED_MENU) {
  const calls: string[][] = []
  const h: Herdr = {
    async gate() { return null },
    async read() { return screen },
    async call(args) { calls.push(args); return {} },
  }
  return { h, calls }
}

// Runs every send at once and records which gate key it queued on.
function passGate() {
  const keys: string[] = []
  const gate: Pick<KeyGate, "send"> = {
    send(pane, _key, doSend) { keys.push(pane); return doSend(new AbortController().signal) },
  }
  return { gate, keys }
}

function session(over: Partial<Session> = {}): Session {
  return {
    key: "claude:tty:/dev/ttys009", agent: "claude", label: "s009", title: "",
    sidConfirmed: true, agentStatus: "idle", waitingFor: "", cwd: "/x", sessionId: "sid",
    termProgram: "", tty: "/dev/ttys009", iTermSessionId: "", tmuxPane: "", herdrPane: "w30:p1", taskId: "",
    waitingSince: 0, waitingKind: "", waitingRef: "", waitingReasons: [],
    pid: "1", firstSeenAt: 0, lastSeenAt: 0, model: "",
    ...over,
  } as Session
}

describe("herdrSessionPane: the suggest and model flows on a herdr pane", () => {
  test("a plain capture is the unstyled screen, and the 2.1.310 menu parses off it", async () => {
    const { h } = fakeHerdr()
    const pane = herdrSessionPane("w30:p1", h, passGate().gate)
    const plain = await pane.capture()
    expect(plain).not.toContain("\x1b")
    expect(parseCommandMenu(plain!).map((r) => r.name)).toEqual(["/model", "/mobile"])
  })

  test("an escapes capture keeps the styling", async () => {
    const pane = herdrSessionPane("w30:p1", fakeHerdr().h, passGate().gate)
    expect(await pane.capture(true)).toBe(STYLED_MENU)
  })

  test("an unreadable pane reads as null either way", async () => {
    const pane = herdrSessionPane("w30:p1", fakeHerdr(null).h, passGate().gate)
    expect(await pane.capture()).toBeNull()
    expect(await pane.capture(true)).toBeNull()
  })

  test("keys and text go to herdr through the pane's herdr gate key", async () => {
    const { h, calls } = fakeHerdr()
    const { gate, keys } = passGate()
    const pane = herdrSessionPane("w30:p1", h, gate)
    expect(await pane.literal("/model")).toBe(true)
    expect(await pane.key("Enter")).toBe(true)
    expect(await pane.key("Escape")).toBe(true)
    expect(await pane.key("C-u")).toBe(true)
    expect(calls).toEqual([
      ["pane", "send-text", "w30:p1", "/model"],
      ["pane", "send-keys", "w30:p1", "enter"],
      ["pane", "send-keys", "w30:p1", "esc"],
      ["pane", "send-keys", "w30:p1", "ctrl+u"],
    ])
    expect(new Set(keys)).toEqual(new Set(["herdr|w30:p1"]))
  })

  test("a failed herdr send reads as false, never throws", async () => {
    const h: Herdr = {
      async gate() { return null },
      async read() { return "" },
      async call() { throw Object.assign(new Error("pane_not_found"), { code: "pane_not_found" }) },
    }
    const pane = herdrSessionPane("w30:p1", h, passGate().gate)
    expect(await pane.key("Enter")).toBe(false)
    expect(await pane.literal("s")).toBe(false)
  })
})

describe("sessionPaneOf picks tmux, else herdr, else nothing", () => {
  test("herdr-only session (tmuxPane empty) is drivable", () => {
    expect(sessionPaneOf(session())).not.toBeNull()
  })
  test("neither pane: nothing to drive", () => {
    expect(sessionPaneOf(session({ herdrPane: "" }))).toBeNull()
    expect(sessionPaneOf(null)).toBeNull()
  })
  test("a tmux pane still wins", () => {
    expect(sessionPaneOf(session({ tmuxPane: "%3" }))).not.toBeNull()
  })
})

describe("the model picker accepts herdr sessions", () => {
  test("open is not refused for a herdr-only session", () => {
    expect(openRefusal(session(), null)).toBeNull()
  })
  test("still refused with neither pane", () => {
    expect(openRefusal(session({ herdrPane: "" }), null)).toEqual({ error: "no_pane" })
  })
  test("the other refusals still apply on herdr", () => {
    expect(openRefusal(session({ agentStatus: "busy" }), null)).toEqual({ error: "busy" })
  })
  test("suggest and model agree on what counts as a pane", () => {
    for (const s of [session(), session({ herdrPane: "" }), session({ tmuxPane: "%1", herdrPane: "" })]) {
      expect(openRefusal(s, null)?.error === "no_pane").toBe(suggestRefusal(s, null, "", "")?.error === "no_pane")
    }
  })
})

describe("the cached-list fallback for `/` suggest", () => {
  const ALL: CommandEntry[] = [
    { name: "/model", description: "Set the AI model", kind: "default" },
    { name: "/mobile", description: "QR code", kind: "default" },
    { name: "/remote-control", description: "Remote control", kind: "default" },
    { name: "/Morning", description: "brief", kind: "custom" },
  ]

  test("filters by name prefix, case-insensitively, as {name, description}", () => {
    expect(suggestFromList(ALL, "mo")).toEqual([
      { name: "/model", description: "Set the AI model" },
      { name: "/mobile", description: "QR code" },
      { name: "/Morning", description: "brief" },
    ])
    expect(suggestFromList(ALL, "remote-").map((c) => c.name)).toEqual(["/remote-control"])
  })

  test("an empty prefix is the whole list", () => {
    expect(suggestFromList(ALL, "")).toHaveLength(4)
  })

  test("peek answers only from the cache and never prepares or enumerates", async () => {
    let prepared = 0
    let runs = 0
    const l = createCommandLister({
      prepare: async () => {
        prepared++
        return { fingerprint: "v", enumerate: async () => { runs++; return { status: "ok" as const, commands: ALL, rowsPerPage: 10, session: "" } } }
      },
    })
    expect(l.peek("/p")).toBeNull()
    expect(prepared).toBe(0)
    await l.list("/p")
    expect(l.peek("/p")).toEqual(ALL)
    expect(l.peek("/other")).toBeNull()
    expect(prepared).toBe(1)
    expect(runs).toBe(1)
  })

  test("peek honours the TTL", async () => {
    let t = 0
    const l = createCommandLister({
      now: () => t,
      prepare: async () => ({ fingerprint: "v", enumerate: async () => ({ status: "ok" as const, commands: ALL, rowsPerPage: 10, session: "" }) }),
    })
    await l.list("/p")
    t += 25 * 3600_000
    expect(l.peek("/p")).toBeNull()
  })
})
