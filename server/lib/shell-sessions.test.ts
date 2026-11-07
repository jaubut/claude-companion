import { afterEach, test, expect, spyOn } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  closeShellSession, createShellStore, descends, linkClaude, parseProcTable, getShellSession, listShellSessions, parseShellList,
  readHerdrShells, readShellSessions, shellWire, spawnShellSession, startShellPoll, store, wireSessions, type ShellDeps, type ShellSession,
} from "./shell-sessions"
import { resolveSpawnCwd } from "./spawn-session"
import { endedStore } from "./ended-sessions"
import { SHELL_PANE_MARK } from "./herdr"
import { fakeHerdr } from "./herdr-fake.test-util"
import { herdrSessionGone } from "./herdr-workspace"
import type { Session } from "./sessions"
import type { DetachedDeps } from "./tmux-spawn-confirm"

// Phone-spawned terminal sessions: a login shell in a marked herdr pane, herdr
// itself as the record (Stage 2). tmux shells from before
// stay listed and closable, never created. A herdr shell closes only through
// closeShellPane, and only where a test says so (expectClosed).

test("parseShellList keeps only tagged sessions, oldest first, times in ms", () => {
  const out = parseShellList([
    "cc-repo\t\t%3\t/x/repo\t1700000100",
    "sh-b\t1\t%9\t/x/b\t1700000200",
    "sh-a\t1\t%7\t/x/a\t1700000050",
    "",
  ].join("\n"), "/tmp/tmux-501/cc")
  expect(out.map((s) => s.key)).toEqual(["shell:sh-a", "shell:sh-b"])
  expect(out[0]).toEqual({ key: "shell:sh-a", name: "sh-a", cwd: "/x/a", herdrPane: "", terminalId: "", tmuxPane: "%7", tmuxSocket: "/tmp/tmux-501/cc", createdAt: 1700000050000, panePid: 0, claudeKey: "" })
})

test("parseShellList: tmux's own socket_path wins over the fallback", () => {
  const out = parseShellList("sh-a\t1\t%7\t/x\t1\t/private/tmp/tmux-501/default\nsh-b\t1\t%8\t/y\t2\t\n", "/fallback")
  expect(out.map((s) => s.tmuxSocket)).toEqual(["/private/tmp/tmux-501/default", "/fallback"])
})

const A: ShellSession = { key: "shell:sh-a", name: "sh-a", cwd: "/x/a", herdrPane: "", terminalId: "", tmuxPane: "%7", tmuxSocket: "", createdAt: 1, panePid: 0, claudeKey: "" }
const H: ShellSession = { ...A, key: "shell:sh-h", name: "sh-h", herdrPane: "w9:p1", terminalId: "term_9", tmuxPane: "", panePid: 90 }

test("store emits on a real change only: added, cd'd, removed", () => {
  const s = createShellStore()
  let emits = 0
  s.on(() => { emits++ })
  expect(s.replace([A])).toBe(true)
  expect(s.replace([{ ...A }])).toBe(false)
  expect(s.replace([{ ...A, cwd: "/x/a/sub" }])).toBe(true)
  expect(s.get("shell:sh-a")?.cwd).toBe("/x/a/sub")
  expect(s.replace([])).toBe(true)
  expect(s.get("shell:sh-a")).toBeUndefined()
  expect(emits).toBe(3)
})

test("wire record: agent shell with its pane, the fields the phone decodes", () => {
  expect(shellWire(A)).toMatchObject({ key: "shell:sh-a", agent: "shell", label: "sh-a", cwd: "/x/a", tmuxPane: "%7", tmuxSocket: "", herdrPane: "", sessionId: "", firstSeenAt: 1 })
  expect(shellWire(H)).toMatchObject({ key: "shell:sh-h", agent: "shell", herdrPane: "w9:p1", tmuxPane: "", tmuxSocket: "", panePid: 90 })
})

test("wireSessions: no shells → the agent list itself; shells → appended after agents", () => {
  store.replace([])
  const agents = [{ key: "a" }]
  expect(wireSessions(agents)).toBe(agents)
  store.replace([A])
  expect(wireSessions(agents).map((s) => (s as { key: string }).key)).toEqual(["a", "shell:sh-a"])
  store.replace([])
})

// The invariant of this module: nothing in herdr closes unless a test expects
// that exact pane to. Every test here runs against the fake below, so this holds
// for every path, spawn included.
const destructive: string[][] = []
afterEach(() => {
  try { expect(destructive).toEqual([]) } finally { destructive.length = 0 }
})
const expectClosed = (panes: string[]) => {
  expect(destructive).toEqual(panes.map((p) => ["pane", "close", p]))
  destructive.length = 0
}

test("shell-sessions.ts: one `pane close`, inside closeShellPane, and no workspace or tab close", () => {
  const src = readFileSync(new URL("./shell-sessions.ts", import.meta.url), "utf8")
  expect(src.match(/"(pane|workspace|tab)", "close"/g)).toEqual(['"pane", "close"'])
  const fn = src.slice(src.indexOf("async function closeShellPane("))
  expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('"pane", "close"')
})

// A fake herdr holding `sh-*` workspaces: create adds one.
// Like the real one, workspace ids only go up and a split keeps its pane id.
function fakeShells(opts: {
  gate?: string | null; dies?: boolean; down?: boolean
  listDown?: () => boolean; onCreate?: () => void; markDown?: boolean; runDown?: boolean; noRoot?: boolean
  onMark?: (w: { term: string; split?: boolean }) => void
  onList?: () => void; getDown?: () => boolean; closeDown?: boolean; onClose?: () => void
} = {}) {
  const ws: Array<{ id: string; label: string; term: string; cwd: string; mark?: string; split?: boolean; agent?: string }> = []
  let created = 0
  const f = fakeHerdr({
    gate: opts.gate,
    reply(args) {
      const verb = args.slice(0, 2).join(" ")
      if (opts.down) throw new Error("herdr down")
      if ((verb === "workspace list" || verb === "pane list") && opts.listDown?.()) throw new Error("herdr blip")
      if (verb === "workspace create") {
        opts.onCreate?.()
        const id = `w${++created}`, label = args[args.indexOf("--label") + 1]!, cwd = args[args.indexOf("--cwd") + 1]!
        if (!opts.dies) ws.push({ id, label, cwd, term: `term_${id}` })
        return { workspace: { workspace_id: id }, ...(opts.noRoot ? {} : { root_pane: { pane_id: `${id}:p1`, terminal_id: `term_${id}` } }) }
      }
      if (verb === "workspace list") return { workspaces: ws.map((w) => ({ workspace_id: w.id, label: w.label })).concat({ workspace_id: "w0", label: "brain" }) }
      if (verb === "pane list") {
        opts.onList?.()
        const roots = ws.filter((w) => w.term).map((w) => ({ pane_id: `${w.id}:p1`, workspace_id: w.id, terminal_id: w.term, label: w.mark, cwd: w.cwd, foreground_cwd: `${w.cwd}/sub` }))
        const splits = ws.filter((w) => w.split).map((w) => ({ pane_id: `${w.id}:p2`, workspace_id: w.id, terminal_id: `split_${w.id}`, cwd: w.cwd, foreground_cwd: "" }))
        return { panes: [...splits, ...roots].sort((a, b) => a.workspace_id.localeCompare(b.workspace_id)).concat({ pane_id: "w0:p1", workspace_id: "w0", terminal_id: "term_b", cwd: "/b", foreground_cwd: "" }) }
      }
      if (verb === "pane get") {
        if (opts.getDown?.()) throw new Error("herdr blip")
        const root = ws.find((x) => args[2] === `${x.id}:p1` && x.term)
        if (root) return { pane: { pane_id: args[2], workspace_id: root.id, terminal_id: root.term, label: root.mark, agent: root.agent ?? "" } }
        const split = ws.find((x) => args[2] === `${x.id}:p2` && x.split)
        if (split) return { pane: { pane_id: args[2], workspace_id: split.id, terminal_id: `split_${split.id}`, agent: "" } }
        throw Object.assign(new Error("pane not found"), { code: "pane_not_found" })
      }
      if (verb === "workspace close" || verb === "pane close") destructive.push(args)
      if (verb === "pane close") {
        if (opts.closeDown) throw new Error("timeout")
        // The last pane takes its workspace with it; beside a split only the pane goes.
        const w = ws.find((x) => args[2] === `${x.id}:p1` && x.term)
        if (w?.split) w.term = ""
        else if (w) ws.splice(ws.indexOf(w), 1)
        opts.onClose?.()
      }
      if (verb === "pane rename") {
        if (opts.markDown) throw new Error("no such command")
        const w = ws.find((x) => args[2] === `${x.id}:p1`)
        if (!w) throw Object.assign(new Error("pane not found"), { code: "pane_not_found" })
        w.mark = args[3]!
        opts.onMark?.(w)
      }
      if (verb === "pane run" && opts.runDown) throw new Error("rejected")
      if (verb === "pane process-info") return { process_info: { shell_pid: 4242, foreground_process_group_id: 4242 } }
      return {}
    },
  })
  const noTmux: Pick<ShellDeps, "run" | "which" | "sleep"> = { which: () => null, sleep: async () => {}, run: async () => ({ code: 1, stdout: "", stderr: "" }) }
  return { ...f, ws, deps: { ...noTmux, h: f.h } as ShellDeps }
}

test("spawn shell: herdr unavailable → herdr_unavailable, nothing created, no tmux", async () => {
  const f = fakeShells({ gate: "version 0.9.9 not pinned" })
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r).toEqual({ ok: false, error: "herdr_unavailable: version 0.9.9 not pinned" })
  expect(f.calls).toEqual([])
})

test("spawn shell: happy path → sh-<dir> workspace, unfocused, listed, in the store", async () => {
  store.replace([])
  const f = fakeShells()
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.session).toMatchObject({ key: "shell:sh-repo", name: "sh-repo", herdrPane: "w1:p1", terminalId: "term_w1", cwd: "/x/repo/sub", panePid: 4242, tmuxPane: "" })
  expect(f.calls.find((c) => c[1] === "create")).toEqual(["workspace", "create", "--cwd", "/x/repo", "--label", "sh-repo", "--no-focus"])
  expect(getShellSession("shell:sh-repo")?.herdrPane).toBe("w1:p1")
  expect(listShellSessions().length).toBe(1)
  store.replace([])
})

test("spawn shell: a double tap gets two names, and a tmux shell's name is taken too", async () => {
  store.replace([])
  const f = fakeShells()
  const deps: ShellDeps = { ...f.deps, which: () => "/usr/bin/tmux", run: async () => ({ code: 0, stdout: "sh-repo\t1\t%1\t/x\t1\t/s\t1\n", stderr: "" }) }
  const [a, b] = await Promise.all([spawnShellSession("/x/repo", deps), spawnShellSession("/x/repo", deps)])
  expect([a, b].map((r) => (r.ok ? r.session.name : r.error))).toEqual(["sh-repo-2", "sh-repo-3"])
  store.replace([])
})

test("spawn shell with resume: `pane run` types claude --resume <id> into its pane", async () => {
  store.replace([])
  const f = fakeShells()
  const id = "51794d7b-cf0f-4f63-9eaf-7b06cab5047e"
  expect((await spawnShellSession("/x/repo", f.deps, id)).ok).toBe(true)
  expect(f.calls.filter((c) => c[1] === "run")).toEqual([["pane", "run", "w1:p1", `claude --resume ${id}`]])
  store.replace([])
})

test("spawn shell: the shell died at once → session_exited, no record", async () => {
  store.replace([])
  const f = fakeShells({ dies: true })
  expect(await spawnShellSession("/x/repo", f.deps)).toEqual({ ok: false, error: "session_exited" })
  expect(listShellSessions()).toEqual([])
})

test("herdr list: only a marked pane is a shell; a blip is null and keeps the rows", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/repo", f.deps)
  expect((await readHerdrShells(f.h))?.map((s) => s.name)).toEqual(["sh-repo"])
  const down = fakeShells({ down: true })
  expect(await readHerdrShells(down.h)).toBeNull()
  expect((await readShellSessions(down.deps)).map((s) => s.name)).toEqual(["sh-repo"])
  store.replace([])
})

test("herdr list: the pid and first-seen time stick to the terminal id, a restored terminal is read again", async () => {
  const f = fakeShells()
  store.replace([])
  await spawnShellSession("/x/repo", f.deps)
  const was = listShellSessions()[0]!
  const n = f.calls.length
  const [same] = (await readHerdrShells(f.h))!
  expect(same).toMatchObject({ createdAt: was.createdAt, panePid: was.panePid })
  expect(f.calls.slice(n).some((c) => c[1] === "process-info")).toBe(false)
  expect((await readHerdrShells(f.h, []))![0]!.panePid).toBe(4242)
  expect(f.calls.at(-1)![1]).toBe("process-info")
  store.replace([])
})

test("herdr list: an `sh-*` workspace with no marked pane is not a shell, whatever the count", async () => {
  const f = fakeShells()
  store.replace([])
  f.ws.push({ id: "w1", label: "sh-old", term: "t1", cwd: "/a" }, { id: "w2", label: "sh-human", term: "t2", cwd: "/b", split: true })
  expect(await readHerdrShells(f.h)).toEqual([])
  expect(await readHerdrShells(f.h, [])).toEqual([])
  expect(await closeShellSession("sh-old", [], () => undefined, f.deps)).toEqual({ ok: false, error: "unknown_shell" })
  expect(f.calls.some((c) => c[1] === "close")).toBe(false)
})

test("herdr list: a restart finds the marked pane among splits; the split is never a row", async () => {
  const f = fakeShells()
  store.replace([])
  f.ws.push({ id: "w1", label: "sh-kept", term: "t1", cwd: "/a", mark: SHELL_PANE_MARK, split: true })
  const rows = await readHerdrShells(f.h, []) // the fake lists a split first
  expect(rows).toMatchObject([{ name: "sh-kept", herdrPane: "w1:p1", terminalId: "t1" }])
  store.replace([])
})

test("herdr list: a shell that exits while Companion is down leaves no row: its split has no mark", async () => {
  const f = fakeShells()
  store.replace([])
  f.ws.push({ id: "w1", label: "sh-gone", term: "", cwd: "/a", split: true }) // only the split's pane is left
  expect(await readHerdrShells(f.h, [])).toEqual([])
  expect(await closeShellSession("sh-gone", [], () => undefined, f.deps)).toEqual({ ok: false, error: "unknown_shell" })
  expect(f.calls.some((c) => c[1] === "close")).toBe(false)
})

test("herdr list: a restore keeps the row: same marked pane, new terminal, a split changes nothing", async () => {
  const f = fakeShells()
  store.replace([])
  await spawnShellSession("/x/repo", f.deps)
  const w = f.ws[0]!
  w.split = true
  w.term = "term_restored"
  expect(await readHerdrShells(f.h)).toMatchObject([{ name: "sh-repo", herdrPane: "w1:p1", terminalId: "term_restored" }])
  store.replace([])
})

test("herdr list: a renamed workspace keeps its shell under the new name, and the split stays out when the shell exits", async () => {
  const f = fakeShells()
  store.replace([])
  await spawnShellSession("/x/repo", f.deps)
  const w = f.ws[0]!
  w.split = true
  w.label = "notes"
  expect(await readHerdrShells(f.h)).toMatchObject([{ name: "notes", herdrPane: "w1:p1" }])
  w.term = ""
  expect(await readHerdrShells(f.h)).toEqual([])
  store.replace([])
})

test("spawn shell: its root pane carries the mark; a mark herdr refuses fails the spawn, no record", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/repo", f.deps)
  expect(f.calls.filter((c) => c[1] === "rename")).toEqual([["pane", "rename", "w1:p1", SHELL_PANE_MARK]])
  store.replace([])
  const refused = fakeShells({ markDown: true })
  expect(await spawnShellSession("/x/repo", refused.deps)).toEqual({ ok: false, error: "herdr pane rename: no such command" })
  expect(refused.ws.length).toBe(1) // left, a ceiling
  expect(listShellSessions()).toEqual([])
})

test("herdr list: two marked panes under one label give no row, nothing is guessed", async () => {
  const f = fakeShells()
  store.replace([])
  f.ws.push({ id: "w1", label: "sh-dup", term: "t1", cwd: "/a", mark: SHELL_PANE_MARK }, { id: "w2", label: "sh-dup", term: "t2", cwd: "/b", mark: SHELL_PANE_MARK })
  f.ws.push({ id: "w3", label: "sh-one", term: "t3", cwd: "/c", mark: SHELL_PANE_MARK })
  const rows = await readHerdrShells(f.h)
  expect(rows!.map((s) => s.terminalId)).toEqual(["t3"])
  store.replace(rows!)
  expect(await closeShellSession("sh-dup", [], () => undefined, f.deps)).toEqual({ ok: false, error: "unknown_shell" })
  expect(f.calls.some((c) => c[1] === "close")).toBe(false)
  f.ws[1]!.label = "sh-dup-b" // unique again: both come back
  expect((await readHerdrShells(f.h))!.map((s) => s.terminalId)).toEqual(["t1", "t2", "t3"])
  store.replace([])
})

test("spawn shell: after pane id reuse a failed listing never hands out the cached row", async () => {
  let reads = 0
  const f = fakeShells({ listDown: () => reads++ >= 1 }) // the label read passes, every later list fails
  store.replace([{ ...H, key: "shell:sh-old", name: "sh-old", herdrPane: "w1:p1", terminalId: "term_old" }])
  expect(await spawnShellSession("/x/reuse", f.deps)).toEqual({ ok: false, error: "session_exited" })
  store.replace([])
})

test("spawn shell: another terminal on its ids is no match", async () => {
  store.replace([])
  const f = fakeShells({ onMark: (w) => { w.term = "term_other" } })
  expect(await spawnShellSession("/x/other", f.deps)).toEqual({ ok: false, error: "session_exited" })
  expect(f.ws.map((w) => w.term)).toEqual(["term_other"])
  store.replace([])
})

test("spawn shell: a create reply with no root pane fails, and the workspace stays", async () => {
  store.replace([])
  const f = fakeShells({ noRoot: true })
  expect(await spawnShellSession("/x/noroot", f.deps)).toEqual({ ok: false, error: "herdr workspace create: no root_pane" })
  expect(f.ws.length).toBe(1)
})

test("spawn shell: a failed listing never reuses a live label, nothing is created", async () => {
  store.replace([])
  const f = fakeShells({ listDown: () => true })
  f.ws.push({ id: "w9", label: "sh-repo", term: "t9", cwd: "/x" })
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r).toEqual({ ok: false, error: "herdr_unavailable: workspace list failed" })
  expect(f.calls.some((c) => c[1] === "create")).toBe(false)
  expect(f.ws.length).toBe(1)
})

test("spawn shell: resolves its own pane, never a shell that took the label in the gap", async () => {
  store.replace([])
  const f = fakeShells({ onCreate: () => f.ws.push({ id: "w0b", label: "sh-repo", term: "t9", cwd: "/x", mark: SHELL_PANE_MARK }) })
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r).toEqual({ ok: false, error: "session_exited" })
  expect(f.ws.map((w) => w.id)).toEqual(["w0b", "w1"])
  store.replace([])
})

test("spawn shell: a listing that fails after create fails the spawn, no record", async () => {
  store.replace([])
  let reads = 0
  const f = fakeShells({ listDown: () => reads++ >= 2 })
  expect(await spawnShellSession("/x/repo", f.deps)).toEqual({ ok: false, error: "session_exited" })
  expect(listShellSessions()).toEqual([])
})

test("spawn shell: a stale row under that name is never handed out when the listing fails", async () => {
  store.replace([])
  let reads = 0, down = false
  const f = fakeShells({ listDown: () => down && reads++ >= 2 })
  await spawnShellSession("/x/repo", f.deps)
  f.ws.length = 0
  down = true
  expect(await spawnShellSession("/x/repo", f.deps)).toEqual({ ok: false, error: "session_exited" })
  store.replace([])
})

const TMUX_ROW = "sh-repo\t1\t%1\t/x\t1\t/s\t1\n"
const tmuxAnswers = (deps: ShellDeps, code: number, stderr: string): ShellDeps => ({ ...deps, which: () => "/usr/bin/tmux", run: async () => ({ code, stdout: "", stderr }) })

test("spawn shell: tmux not answering keeps a live tmux shell's name taken", async () => {
  store.replace(parseShellList(TMUX_ROW, "/s"))
  const r = await spawnShellSession("/x/repo", tmuxAnswers(fakeShells().deps, -1, "timed out"))
  expect(r).toMatchObject({ ok: true, session: { name: "sh-repo-2" } })
  store.replace([])
})

test("tmux list: no answer keeps the rows, a server that isn't running has none", async () => {
  store.replace(parseShellList(TMUX_ROW, "/s"))
  const f = fakeShells()
  expect((await readShellSessions(tmuxAnswers(f.deps, -1, "timed out"))).map((s) => s.name)).toEqual(["sh-repo"])
  expect(await readShellSessions(tmuxAnswers(f.deps, 1, "no server running on /tmp/tmux-1000/default\n"))).toEqual([])
  store.replace([])
})

test("shell list: a herdr workspace renamed onto a tmux shell's name gives no row, on every refresh", async () => {
  store.replace([])
  const f = fakeShells()
  f.ws.push({ id: "w8", label: "sh-repo", term: "t8", cwd: "/x", mark: SHELL_PANE_MARK })
  const deps: ShellDeps = { ...f.deps, which: () => "/usr/bin/tmux", run: async () => ({ code: 0, stdout: TMUX_ROW, stderr: "" }) }
  expect((await readShellSessions(deps)).map((s) => s.tmuxPane)).toEqual(["%1"])
  await spawnShellSession("/x/other", deps)
  expect(listShellSessions().map((s) => s.name).sort()).toEqual(["sh-other", "sh-repo"])
  expect(listShellSessions().find((s) => s.name === "sh-repo")?.tmuxPane).toBe("%1")
  store.replace([])
})

test("spawn shell: a shell exits and its name is reused before the poll → a working new shell", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/repo", f.deps)
  f.ws.length = 0 // `exit`: the workspace is gone, the store still holds w1:p1
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r).toMatchObject({ ok: true, session: { name: "sh-repo", herdrPane: "w2:p1", terminalId: "term_w2" } })
  expect((await readHerdrShells(f.h))?.map((s) => s.terminalId)).toEqual(["term_w2"])
  store.replace([])
})

test("spawn shell: every workspace label is taken, shell or not", async () => {
  store.replace([])
  const f = fakeShells()
  f.ws.push({ id: "w8", label: "sh-repo", term: "t8", cwd: "/x", mark: SHELL_PANE_MARK, split: true })
  f.ws.push({ id: "w9", label: "sh-repo-2", term: "t9", cwd: "/x" })
  expect(await spawnShellSession("/x/repo", f.deps)).toMatchObject({ ok: true, session: { name: "sh-repo-3" } })
  store.replace([])
})

test("spawn shell: a resume that herdr refuses keeps the shell, and the error says it is open", async () => {
  store.replace([])
  const f = fakeShells({ runDown: true })
  const id = "51794d7b-cf0f-4f63-9eaf-7b06cab5047e"
  const r = await spawnShellSession("/x/kept", f.deps, id)
  expect(r).toMatchObject({ ok: false, error: "The terminal is open, but claude --resume didn't start: rejected", session: { name: "sh-kept", terminalId: "term_w1" } })
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-kept"])
  expect(f.ws.length).toBe(1)
  store.replace([])
})

test("exit: the row drops on the next poll, with no error, a split or not", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/alone", f.deps)
  await spawnShellSession("/x/beside", f.deps)
  f.ws[1]!.split = true
  const stop = startShellPoll(() => [], f.deps, 5)
  await Bun.sleep(15)
  expect(listShellSessions().length).toBe(2)
  f.ws.shift() // `exit` in the only pane: its workspace goes with it
  f.ws[0]!.term = "" // `exit` beside a split: the split stays
  await Bun.sleep(20)
  stop()
  expect(listShellSessions()).toEqual([])
})

// ── Close on a herdr shell: one fresh read, then closeShellPane ──

const poll = async (f: { h: ShellDeps["h"] }) => store.replace((await readHerdrShells(f.h))!)

test("close shell (herdr): a Claude linked or on its pane → claude_running before herdr is asked, nothing detached", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/c-linked", f.deps)
  const n = f.calls.length
  const detached: string[] = []
  const agent = { key: "c", pid: "", tmuxPane: "", herdrPane: "w1:p1" }
  expect(await closeShellSession("sh-c-linked", [agent], (k) => detached.push(k), f.deps)).toEqual({ ok: false, error: "claude_running" })
  store.replace(listShellSessions().map((s) => ({ ...s, claudeKey: "c" })))
  expect(await closeShellSession("sh-c-linked", [], (k) => detached.push(k), f.deps)).toEqual({ ok: false, error: "claude_running" })
  expect(detached).toEqual([])
  expect(f.calls.length).toBe(n)
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-c-linked"])
  store.replace([])
})

test("close shell (herdr): closes that pane only, drops the row, detaches after the close; a retry is gone:true", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/c-one", f.deps)
  const order: string[] = []
  const r = await closeShellSession("sh-c-one", [], (k) => order.push(`detach ${k} after ${destructive.length} close`), f.deps)
  expect(r).toEqual({ ok: true, gone: false })
  expect(order).toEqual(["detach shell:sh-c-one after 1 close"])
  expect(f.calls.filter((c) => c[1] === "get")).toEqual([["pane", "get", "w1:p1"]])
  expectClosed(["w1:p1"])
  expect(listShellSessions()).toEqual([])
  expect(await closeShellSession("sh-c-one", [], () => undefined, f.deps)).toEqual({ ok: true, gone: true })
})

test("close shell (herdr): a split survives, and no later poll or retry reaches it", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/c-split", f.deps)
  f.ws[0]!.split = true
  expect(await closeShellSession("sh-c-split", [], () => undefined, f.deps)).toEqual({ ok: true, gone: false })
  expectClosed(["w1:p1"])
  expect(f.ws).toMatchObject([{ id: "w1", label: "sh-c-split", term: "", split: true }])
  await poll(f)
  expect(listShellSessions()).toEqual([])
  expect(await closeShellSession("sh-c-split", [], () => undefined, f.deps)).toEqual({ ok: true, gone: true })
})

test("close shell (herdr): the last read sees an agent no hook reported → claude_running, pane untouched", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/c-agent", f.deps)
  f.ws[0]!.agent = "claude"
  const detached: string[] = []
  expect(await closeShellSession("sh-c-agent", [], (k) => detached.push(k), f.deps)).toEqual({ ok: false, error: "claude_running" })
  expect(detached).toEqual([])
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-c-agent"])
  store.replace([])
})

test("close shell (herdr): Claude starting during validation is seen by the last read → claude_running", async () => {
  store.replace([])
  let starts = false
  const f = fakeShells({ onList: () => { if (starts) f.ws[0]!.agent = "claude" } })
  await spawnShellSession("/x/c-starts", f.deps)
  starts = true
  expect(await closeShellSession("sh-c-starts", [], () => undefined, f.deps)).toEqual({ ok: false, error: "claude_running" })
  store.replace([])
})

test("close shell (herdr): an unreadable listing or last read closes nothing → herdr_unreadable, row stays", async () => {
  store.replace([])
  let listDown = false, getDown = false
  const f = fakeShells({ listDown: () => listDown, getDown: () => getDown })
  await spawnShellSession("/x/c-blip", f.deps)
  listDown = true
  expect(await closeShellSession("sh-c-blip", [], () => undefined, f.deps)).toEqual({ ok: false, error: "herdr_unreadable" })
  listDown = false
  getDown = true
  expect(await closeShellSession("sh-c-blip", [], () => undefined, f.deps)).toEqual({ ok: false, error: "herdr_unreadable" })
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-c-blip"])
  store.replace([])
})

test("close shell (herdr): a close then a failed listing is still recorded; a respawn gets a new name and the retry leaves it", async () => {
  store.replace([])
  let down = false
  const f = fakeShells({ listDown: () => down, onClose: () => { down = true } })
  await spawnShellSession("/x/c-lost", f.deps)
  expect(await closeShellSession("sh-c-lost", [], () => undefined, f.deps)).toEqual({ ok: true, gone: false })
  expectClosed(["w1:p1"])
  down = false
  expect(await spawnShellSession("/x/c-lost", f.deps)).toMatchObject({ ok: true, session: { name: "sh-c-lost-2" } })
  expect(await closeShellSession("sh-c-lost", [], () => undefined, f.deps)).toEqual({ ok: true, gone: true })
  expect(f.ws.map((w) => w.label)).toEqual(["sh-c-lost-2"])
  store.replace([])
})

test("close shell (herdr): a marked pane relabelled onto a closed name is never closed by a retry → name_reused", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/c-reuse", f.deps)
  expect((await closeShellSession("sh-c-reuse", [], () => undefined, f.deps)).ok).toBe(true)
  expectClosed(["w1:p1"])
  f.ws.push({ id: "w9", label: "sh-c-reuse", term: "t9", cwd: "/x", mark: SHELL_PANE_MARK })
  await poll(f)
  expect(await closeShellSession("sh-c-reuse", [], () => undefined, f.deps)).toEqual({ ok: false, error: "name_reused" })
  expect(f.ws.map((w) => w.term)).toEqual(["t9"])
  store.replace([])
})

test("close shell (herdr): a second marked pane under the label before Close → no row, nothing closed, both alive", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/c-dup", f.deps)
  f.ws.push({ id: "w9", label: "sh-c-dup", term: "t9", cwd: "/x", mark: SHELL_PANE_MARK })
  expect(await closeShellSession("sh-c-dup", [], () => undefined, f.deps)).toEqual({ ok: false, error: "unknown_shell" })
  expect(f.ws.map((w) => w.term)).toEqual(["term_w1", "t9"])
  expect(listShellSessions()).toEqual([])
})

test("close shell (herdr): a second marked pane appearing during the close is exposed, and the retry leaves it", async () => {
  store.replace([])
  const f = fakeShells({ onClose: () => f.ws.push({ id: "w9", label: "sh-c-dup2", term: "t9", cwd: "/x", mark: SHELL_PANE_MARK }) })
  await spawnShellSession("/x/c-dup2", f.deps)
  expect(await closeShellSession("sh-c-dup2", [], () => undefined, f.deps)).toEqual({ ok: true, gone: false })
  expectClosed(["w1:p1"])
  await poll(f)
  expect(listShellSessions().map((s) => s.terminalId)).toEqual(["t9"])
  expect(await closeShellSession("sh-c-dup2", [], () => undefined, f.deps)).toEqual({ ok: false, error: "name_reused" })
  expect(f.ws.map((w) => w.term)).toEqual(["t9"])
  store.replace([])
})

test("close shell (herdr): within 3 s of a restore the terminal changed → refused once, then a second Close closes it", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/c-restore", f.deps)
  f.ws[0]!.term = "term_restored" // the store still holds term_w1
  expect(await closeShellSession("sh-c-restore", [], () => undefined, f.deps)).toEqual({ ok: false, error: "terminal_changed" })
  expect(listShellSessions().map((s) => s.terminalId)).toEqual(["term_restored"])
  expect(await closeShellSession("sh-c-restore", [], () => undefined, f.deps)).toEqual({ ok: true, gone: false })
  expectClosed(["w1:p1"])
})

test("close shell (herdr): the last read is by terminal: the pane holding another terminal by then is never closed", async () => {
  store.replace([])
  let swap = false
  const f = fakeShells({ onList: () => { if (swap) queueMicrotask(() => { f.ws[0]!.term = "term_other" }) } })
  await spawnShellSession("/x/c-swap", f.deps)
  swap = true // the listing still shows term_w1, the last read sees term_other
  expect(await closeShellSession("sh-c-swap", [], () => undefined, f.deps)).toEqual({ ok: false, error: "terminal_changed" })
  store.replace([])
})

test("close shell (herdr): the pane went between the listing and the close → gone:true, nothing closed", async () => {
  store.replace([])
  let exits = false
  const f = fakeShells({ onList: () => { if (exits) queueMicrotask(() => f.ws.splice(0, 1)) } })
  await spawnShellSession("/x/c-exit", f.deps)
  exits = true
  expect(await closeShellSession("sh-c-exit", [], () => undefined, f.deps)).toEqual({ ok: true, gone: true })
  expect(listShellSessions()).toEqual([])
  expect(await closeShellSession("sh-c-exit", [], () => undefined, f.deps)).toEqual({ ok: true, gone: true })
  store.replace([])
})

test("close shell (herdr): `pane close` failing → kill_failed, recorded, and the retry reaches only that terminal", async () => {
  store.replace([])
  const f = fakeShells({ closeDown: true })
  await spawnShellSession("/x/c-fail", f.deps)
  expect(await closeShellSession("sh-c-fail", [], () => undefined, f.deps)).toEqual({ ok: false, error: "kill_failed" })
  expectClosed(["w1:p1"])
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-c-fail"])
  expect(await closeShellSession("sh-c-fail", [], () => undefined, f.deps)).toEqual({ ok: false, error: "kill_failed" })
  expectClosed(["w1:p1"])
  store.replace([])
})

test("close shell (herdr): a tmux shell under the same name → name_ambiguous, nothing closed or killed", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/c-clash", f.deps)
  const runs: string[][] = []
  const deps: ShellDeps = { ...f.deps, which: () => "/usr/bin/tmux", run: async (argv) => { runs.push(argv); return { code: 0, stdout: "sh-c-clash\t1\t%1\t/x\t1\t/s\t1\n", stderr: "" } } }
  expect(await closeShellSession("sh-c-clash", [], () => undefined, deps)).toEqual({ ok: false, error: "name_ambiguous" })
  expect(runs.some((a) => a.includes("kill-session"))).toBe(false)
  store.replace([])
})

test("poll: a read from before a close or a spawn never writes over it", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/c-race", f.deps)
  let release = () => {}
  const held: ShellDeps = { ...f.deps, which: () => "/usr/bin/tmux", run: async () => { await new Promise<void>((r) => { release = r }); return { code: 1, stdout: "", stderr: "" } } }
  let stop = startShellPoll(() => [], held, 60_000) // its herdr read is taken now, the tmux read hangs
  expect(await closeShellSession("sh-c-race", [], () => undefined, f.deps)).toEqual({ ok: true, gone: false })
  expectClosed(["w1:p1"])
  release()
  await Bun.sleep(5)
  stop()
  expect(listShellSessions()).toEqual([])
  stop = startShellPoll(() => [], held, 60_000)
  expect((await spawnShellSession("/x/c-race2", f.deps)).ok).toBe(true)
  release()
  await Bun.sleep(5)
  stop()
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-c-race2"])
  store.replace([])
})

// ── Close (POST /api/shell/close) ──

const CLOSE_LIST = "sh-a\t1\t%7\t/x\t1700000000\t/tmp/tmux-501/default\t70\nsh-b\t1\t%8\t/y\t1700000001\t/tmp/tmux-501/default\t80\n"

// list-sessions shows sh-a and sh-b until a kill of that `=name` lands (unless `unkillable`).
// `labels`: the herdr workspace labels (null: herdr installed, not answering);
// `noHerdr`: no herdr on this host at all, as on a Mac without it.
function fakeCloseTmux(opts: { unkillable?: boolean; killCode?: number; labels?: string[] | null; noHerdr?: boolean } = {}) {
  const which = (bin: string) => (opts.noHerdr && bin.endsWith("herdr") ? null : `/usr/bin/${bin}`)
  const herdrCalls: string[][] = []
  const h = fakeHerdr({ reply: (args) => {
    herdrCalls.push(args)
    if (opts.labels === null) throw new Error("herdr down")
    return { workspaces: (opts.labels ?? []).map((label, i) => ({ workspace_id: `w${i}`, label })), panes: [] }
  } }).h
  const calls: string[][] = []
  const killed = new Set<string>()
  const run: DetachedDeps["run"] = async (argv) => {
    calls.push(argv)
    if (argv.includes("kill-session")) {
      if (!opts.unkillable) killed.add(argv.at(-1)!.slice(1))
      return { code: opts.killCode ?? 0, stdout: "", stderr: "" }
    }
    if (argv.includes("list-sessions")) {
      return { code: 0, stdout: CLOSE_LIST.split("\n").filter((l) => !killed.has(l.split("\t")[0]!)).join("\n"), stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { run, calls, which, h, herdrCalls }
}

test("close shell: detaches first, kills the exact name, drops the row, broadcasts once", async () => {
  store.replace(parseShellList(CLOSE_LIST, ""))
  const f = fakeCloseTmux()
  const order: string[] = []
  const seen: string[][] = []
  const off = store.on((l) => seen.push(l.map((s) => s.name)))
  const r = await closeShellSession("sh-a", [], (key) => { order.push(`detach ${key}`); order.push(`kills so far ${f.calls.length}`) }, f)
  off()
  expect(r).toEqual({ ok: true, gone: false })
  expect(order).toEqual(["detach shell:sh-a", "kills so far 0"])
  expect(f.calls[0]!.slice(-3)).toEqual(["kill-session", "-t", "=sh-a"])
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-b"])
  expect(seen).toEqual([["sh-b"]])
  // A retry after the row left: ok, gone.
  expect(await closeShellSession("sh-a", [], () => undefined, fakeCloseTmux())).toEqual({ ok: true, gone: true })
})

test("close shell: not in the list → unknown_shell, nothing run", async () => {
  store.replace(parseShellList(CLOSE_LIST, ""))
  const f = fakeCloseTmux()
  expect(await closeShellSession("dispatch-x", [], () => undefined, f)).toEqual({ ok: false, error: "unknown_shell" })
  expect(f.calls).toEqual([])
})

test("close shell: a Claude in the shell (linked or on its pane) → claude_running, nothing run", async () => {
  const f = fakeCloseTmux()
  store.replace(parseShellList(CLOSE_LIST, "").map((s) => (s.name === "sh-a" ? { ...s, claudeKey: "claude:1" } : s)))
  expect(await closeShellSession("sh-a", [], () => undefined, f)).toEqual({ ok: false, error: "claude_running" })
  const agent = { key: "claude:2", pid: "", tmuxPane: "%8", tmuxSocket: "/tmp/tmux-501/default" }
  expect(await closeShellSession("sh-b", [agent], () => undefined, f)).toEqual({ ok: false, error: "claude_running" })
  expect(await closeShellSession("sh-b", [{ ...agent, tmuxSocket: "/other" }], () => undefined, f)).toMatchObject({ ok: true })
  expect(f.calls.filter((c) => c.includes("kill-session")).map((c) => c.at(-1))).toEqual(["=sh-b"])
})

test("close shell: the session survives the kill → kill_failed, row kept", async () => {
  store.replace(parseShellList(CLOSE_LIST, ""))
  expect(await closeShellSession("sh-a", [], () => undefined, fakeCloseTmux({ unkillable: true }))).toEqual({ ok: false, error: "kill_failed" })
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-a", "sh-b"])
})

test("close shell: kill-session fails because it already exited → ok, gone", async () => {
  store.replace(parseShellList(CLOSE_LIST, ""))
  expect(await closeShellSession("sh-a", [], () => undefined, fakeCloseTmux({ killCode: 1 }))).toEqual({ ok: true, gone: true })
  store.replace([])
})

test("close shell (tmux): a herdr workspace under the same name → name_ambiguous, nothing killed or detached", async () => {
  store.replace(parseShellList(CLOSE_LIST, ""))
  const f = fakeCloseTmux({ labels: ["sh-a"] })
  const detached: string[] = []
  expect(await closeShellSession("sh-a", [], (k) => detached.push(k), f)).toEqual({ ok: false, error: "name_ambiguous" })
  expect(detached).toEqual([])
  expect(f.calls.some((c) => c.includes("kill-session"))).toBe(false)
  store.replace([])
})

test("close shell (tmux): herdr installed but not answering → herdr_unreadable, nothing killed", async () => {
  store.replace(parseShellList(CLOSE_LIST, ""))
  const f = fakeCloseTmux({ labels: null })
  expect(await closeShellSession("sh-a", [], () => undefined, f)).toEqual({ ok: false, error: "herdr_unreadable" })
  expect(f.calls.some((c) => c.includes("kill-session"))).toBe(false)
  store.replace([])
})

test("close shell (tmux): no herdr on this host → closes as before, herdr never asked", async () => {
  store.replace(parseShellList(CLOSE_LIST, ""))
  const f = fakeCloseTmux({ noHerdr: true, labels: null })
  expect(await closeShellSession("sh-a", [], () => undefined, f)).toEqual({ ok: true, gone: false })
  expect(f.calls.filter((c) => c.includes("kill-session")).map((c) => c.at(-1))).toEqual(["=sh-a"])
  expect(f.herdrCalls).toEqual([])
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-b"])
  store.replace([])
})

test("resolveSpawnCwd: required, absolute, existing, a directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-cwd-"))
  const file = join(dir, "f.txt")
  writeFileSync(file, "x")
  expect(resolveSpawnCwd("  ")).toEqual({ error: "cwd required" })
  expect(resolveSpawnCwd("repo")).toEqual({ error: "cwd must be absolute" })
  expect(resolveSpawnCwd(join(dir, "nope"))).toEqual({ error: `cwd does not exist: ${join(dir, "nope")}` })
  expect(resolveSpawnCwd(file)).toEqual({ error: `cwd is not a directory: ${file}` })
  expect(resolveSpawnCwd(dir)).toEqual({ dir })
})

// ── Which Claude runs inside a shell (process ancestry, Moshi-style) ──

// launchd(1) → tmux server(500) → zsh pane(600) → claude(700) → node child(701);
// an unrelated claude(900) under another shell(800).
const TABLE = parseProcTable(["  1     0", "500 1", "600 500", "700 600", "701 700", "800 500", "900 800", "junk"].join("\n"))
const SHELL: ShellSession = { ...A, tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/default", panePid: 600 }

test("parseProcTable / descends: walks parents, bounded, self counts", () => {
  expect(TABLE.get(700)).toBe(600)
  expect(descends(701, 600, TABLE)).toBe(true)
  expect(descends(600, 600, TABLE)).toBe(true)
  expect(descends(900, 600, TABLE)).toBe(false)
  expect(descends(12345, 600, TABLE)).toBe(false)
  const loop = parseProcTable("10 11\n11 10")
  expect(descends(10, 600, loop)).toBe(false)
})

test("linkClaude: same pane AND a pid under the shell → linked", () => {
  const [s] = linkClaude([SHELL], [{ key: "claude:x", pid: "700", tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/default" }], TABLE)
  expect(s!.claudeKey).toBe("claude:x")
})

test("linkClaude: same pane but the pid is not under the shell (stale record, reused pane id) → not linked", () => {
  const [s] = linkClaude([SHELL], [{ key: "claude:y", pid: "900", tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/default" }], TABLE)
  expect(s!.claudeKey).toBe("")
})

test("linkClaude: a pid under the shell on another tmux server or pane → not linked (pane is the fast path)", () => {
  const agents = [
    { key: "claude:a", pid: "700", tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/cc" },
    { key: "claude:b", pid: "700", tmuxPane: "%5", tmuxSocket: "/tmp/tmux-501/default" },
  ]
  expect(linkClaude([SHELL], agents, TABLE)[0]!.claudeKey).toBe("")
})

test("linkClaude: no pid, or no process table → the pane match decides", () => {
  const agent = { key: "claude:x", pid: "", tmuxPane: "%4", tmuxSocket: "/tmp/tmux-501/default" }
  expect(linkClaude([SHELL], [agent], TABLE)[0]!.claudeKey).toBe("claude:x")
  expect(linkClaude([SHELL], [{ ...agent, pid: "900" }], null)[0]!.claudeKey).toBe("claude:x")
})

test("linkClaude (herdr): same herdr pane under the shell → linked; another pane or a stale pid → not", () => {
  const shell = { ...SHELL, tmuxPane: "", tmuxSocket: "", herdrPane: "w9:p1", terminalId: "term_9" }
  const agent = { key: "claude:h", pid: "700", tmuxPane: "", herdrPane: "w9:p1" }
  expect(linkClaude([shell], [agent], TABLE)[0]!.claudeKey).toBe("claude:h")
  expect(linkClaude([shell], [{ ...agent, herdrPane: "w8:p1" }], TABLE)[0]!.claudeKey).toBe("")
  expect(linkClaude([shell], [{ ...agent, pid: "900" }], TABLE)[0]!.claudeKey).toBe("")
})

test("a Claude ending in a shell's pane leaves no ended row: the shell counts as live on that pane", () => {
  store.replace([H])
  const note = spyOn(endedStore, "note").mockResolvedValue(false)
  try {
    herdrSessionGone({ herdrPane: "w9:p1", tmuxPane: "" } as Session, () => [], "prompt_input_exit")
    const live = note.mock.calls[0]![1]()
    expect(live.some((o) => o.herdrPane === "w9:p1")).toBe(true)
  } finally { note.mockRestore(); store.replace([]) }
})

test("store: a link appearing or going is a change (re-sent to phones)", () => {
  const s = createShellStore()
  s.replace([SHELL])
  expect(s.replace([{ ...SHELL, claudeKey: "claude:x" }])).toBe(true)
  expect(s.replace([{ ...SHELL, claudeKey: "claude:x" }])).toBe(false)
})
