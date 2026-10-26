import { test, expect } from "bun:test"
import type { Herdr } from "./herdr"
import { createEndedStore, deleteEnded, endStatus, endedWire, resumable, resumeCommand, resumeInPane, type EndedSource } from "./ended-sessions"

// "Ended · Resume": an ended claude whose herdr pane is still open.

const SID = "51794d7b-cf0f-4f63-9eaf-7b06cab5047e"

// A fake herdr: panes by id → terminal id; `shellFront` = shell in front.
function fakeHerdr(panes: Record<string, string>, opts: { shellFront?: boolean } = {}) {
  const calls: string[][] = []
  const h: Herdr = {
    async call(args) {
      calls.push(args)
      const pane = args[2] ?? args[3] ?? ""
      if (args[0] === "pane" && args[1] === "get") {
        if (!(pane in panes)) throw Object.assign(new Error("pane_not_found"), { code: "pane_not_found" })
        return { pane: { pane_id: pane, terminal_id: panes[pane], workspace_id: "w3", tab_id: "w3:t1" } }
      }
      if (args[0] === "workspace" && args[1] === "get") return { workspace: { workspace_id: "w3", label: "cc-repo" } }
      if (args[0] === "tab" && args[1] === "get") return { tab: { tab_id: "w3:t1", label: "1" } }
      if (args[0] === "pane" && args[1] === "close") { delete panes[pane]; return {} }
      if (args[0] === "pane" && args[1] === "process-info") {
        const front = opts.shellFront ?? true
        return { process_info: { shell_pid: 600, foreground_process_group_id: front ? 600 : 700 } }
      }
      return {}
    },
    async read() { return null },
    async gate() { return null },
  }
  return { h, calls, panes }
}

const ended = (over: Partial<EndedSource> = {}): EndedSource => ({
  sessionId: SID, sidConfirmed: true, agent: "claude", title: "Reload the MCP servers", label: "repo · w3",
  cwd: "/Users/j/repo", herdrPane: "w3:p1", tmuxPane: "", ...over,
})

test("an ended session whose herdr pane is alive is kept, on the wire as agent ended", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" })
  const store = createEndedStore({ herdr: f.h, now: () => 1_000 })
  expect(await store.note(ended(), () => [])).toBe(true)
  const [e] = store.list()
  expect(e).toMatchObject({ key: `ended:${SID}`, herdrPane: "w3:p1", terminalId: "t-9", endedAt: 1_000 })
  expect(endedWire(e!)).toMatchObject({ key: `ended:${SID}`, agent: "ended", endedAgent: "claude", sessionId: SID, herdrPane: "w3:p1", title: "Reload the MCP servers" })
})

test("a dead pane: nothing kept at the end, and a kept row drops on the sweep", async () => {
  const f = fakeHerdr({})
  const store = createEndedStore({ herdr: f.h })
  expect(await store.note(ended(), () => [])).toBe(false)
  const g = fakeHerdr({ "w3:p1": "t-9" })
  const kept = createEndedStore({ herdr: g.h })
  await kept.note(ended(), () => [])
  delete g.panes["w3:p1"]
  expect(await kept.sweep(() => [])).toBe(true)
  expect(kept.list()).toEqual([])
})

test("the pane id reused by another workspace (terminal id changed) drops the row", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" })
  const store = createEndedStore({ herdr: f.h })
  await store.note(ended(), () => [])
  f.panes["w3:p1"] = "t-42"
  await store.sweep(() => [])
  expect(store.list()).toEqual([])
})

test("a live session back in the pane (resumed, or claude started again) drops the row; never kept while occupied", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" })
  const store = createEndedStore({ herdr: f.h })
  expect(await store.note(ended(), () => [{ herdrPane: "w3:p1" }])).toBe(false)
  await store.note(ended(), () => [])
  expect(await store.sweep(() => [{ herdrPane: "w3:p1" }])).toBe(true)
  expect(store.list()).toEqual([])
})

test("only resumable sessions: confirmed uuid id, herdr pane without tmux, not codex", () => {
  expect(resumable(ended())).toBe(true)
  expect(resumable(ended({ sidConfirmed: false }))).toBe(false)
  expect(resumable(ended({ sessionId: "x; rm -rf ~" }))).toBe(false)
  expect(resumable(ended({ agent: "codex" }))).toBe(false)
  expect(resumable(ended({ tmuxPane: "%3" }))).toBe(false)
  expect(resumable(ended({ herdrPane: "" }))).toBe(false)
})

test("one row per pane: a second end in the same pane replaces the first", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" })
  const store = createEndedStore({ herdr: f.h })
  await store.note(ended(), () => [])
  const other = "11111111-2222-3333-4444-555555555555"
  await store.note(ended({ sessionId: other }), () => [])
  expect(store.list().map((e) => e.sessionId)).toEqual([other])
})

function sends() {
  const typed: Array<[string, string]> = []
  return {
    typed,
    deps: {
      sendText: async (p: string, t: string) => { typed.push([p, t]); return true },
      sendKey: async (p: string, k: string) => { typed.push([p, `<${k}>`]); return true },
    },
  }
}

test("resume types `claude --resume <id>` then Enter into the same pane", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" })
  const store = createEndedStore({ herdr: f.h })
  await store.note(ended(), () => [])
  const s = sends()
  expect(await resumeInPane(store, `ended:${SID}`, { herdr: f.h, ...s.deps })).toEqual({ ok: true, via: "pane" })
  expect(s.typed).toEqual([["w3:p1", `claude --resume ${SID}`], ["w3:p1", "<Enter>"]])
})

test("resume: pane busy (something else in front) → refused, nothing typed", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" }, { shellFront: false })
  const store = createEndedStore({ herdr: f.h })
  await store.note(ended(), () => [])
  const s = sends()
  expect(await resumeInPane(store, `ended:${SID}`, { herdr: f.h, ...s.deps })).toEqual({ ok: false, error: "pane_busy" })
  expect(s.typed).toEqual([])
})

test("resume: pane gone → pane_gone (caller opens a new terminal), row dropped, nothing typed", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" })
  const store = createEndedStore({ herdr: f.h })
  await store.note(ended(), () => [])
  delete f.panes["w3:p1"]
  const s = sends()
  expect(await resumeInPane(store, `ended:${SID}`, { herdr: f.h, ...s.deps })).toEqual({ ok: false, error: "pane_gone" })
  expect(store.list()).toEqual([])
  expect(s.typed).toEqual([])
})

test("resume: unknown key → target_gone; a bad id is refused before any text is built", async () => {
  const f = fakeHerdr({})
  const store = createEndedStore({ herdr: f.h })
  expect(await resumeInPane(store, "ended:nope", { herdr: f.h, ...sends().deps })).toEqual({ ok: false, error: "target_gone" })
  expect(() => resumeCommand("x; rm -rf ~")).toThrow()
  expect(() => resumeCommand("--help")).toThrow()
  expect(resumeCommand(SID)).toBe(`claude --resume ${SID}`)
})

test("sheet fields: reason → status, model, herdr workspace and tab with labels", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" })
  const store = createEndedStore({ herdr: f.h })
  await store.note({ ...ended(), model: "claude-opus-5-5" } as EndedSource, () => [], "prompt_input_exit")
  expect(endedWire(store.list()[0]!)).toMatchObject({
    endReason: "prompt_input_exit", endStatus: "completed", model: "claude-opus-5-5",
    herdrWorkspace: { id: "w3", label: "cc-repo" }, herdrTab: { id: "w3:t1", label: "1" },
  })
  expect(endStatus("killed")).toBe("error")
  expect(endStatus("clear")).toBe("completed")
  expect(endStatus("")).toBe("completed")
})

const noWait = { sleep: async () => {} }

test("delete: our pane with its shell in front → the pane is closed and the row dropped", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" })
  const store = createEndedStore({ herdr: f.h })
  await store.note(ended(), () => [])
  expect(await deleteEnded(store, `ended:${SID}`, { herdr: f.h, ...noWait })).toEqual({ ok: true, closed: true })
  expect(f.calls.some((c) => c.join(" ") === "pane close w3:p1")).toBe(true)
  expect(store.list()).toEqual([])
})

test("delete: something running in the pane → refused, nothing closed, row kept", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" }, { shellFront: false })
  const store = createEndedStore({ herdr: f.h })
  await store.note(ended(), () => [])
  expect(await deleteEnded(store, `ended:${SID}`, { herdr: f.h, ...noWait })).toEqual({ ok: false, error: "pane_busy" })
  expect(f.calls.some((c) => c[1] === "close")).toBe(false)
  expect(store.list().length).toBe(1)
})

test("delete: the pane is now someone else's (terminal id changed) or gone → only the row goes", async () => {
  const f = fakeHerdr({ "w3:p1": "t-9" })
  const store = createEndedStore({ herdr: f.h })
  await store.note(ended(), () => [])
  f.panes["w3:p1"] = "t-other"
  expect(await deleteEnded(store, `ended:${SID}`, { herdr: f.h, ...noWait })).toEqual({ ok: true, closed: false })
  expect(f.calls.some((c) => c[1] === "close")).toBe(false)
  expect(store.list()).toEqual([])
  expect(await deleteEnded(store, `ended:${SID}`, { herdr: f.h, ...noWait })).toEqual({ ok: false, error: "target_gone" })
})
