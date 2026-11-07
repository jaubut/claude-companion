import { test, expect, spyOn } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  closeShellSession, createShellStore, descends, linkClaude, parseProcTable, getShellSession, listShellSessions, parseShellList,
  readHerdrShells, readShellSessions, shellWire, spawnShellSession, store, wireSessions, type ShellDeps, type ShellSession,
} from "./shell-sessions"
import { resolveSpawnCwd } from "./spawn-session"
import { endedStore } from "./ended-sessions"
import { fakeHerdr } from "./herdr-fake.test-util"
import { herdrSessionGone } from "./herdr-workspace"
import type { Session } from "./sessions"
import type { DetachedDeps } from "./tmux-spawn-confirm"

// Phone-spawned terminal sessions: a login shell in a `sh-<dir>` herdr
// workspace, herdr itself as the record (Stage 2). tmux shells from before
// stay listed and closable, never created.

test("parseShellList keeps only tagged sessions, oldest first, times in ms", () => {
  const out = parseShellList([
    "cc-repo\t\t%3\t/x/repo\t1700000100",
    "sh-b\t1\t%9\t/x/b\t1700000200",
    "sh-a\t1\t%7\t/x/a\t1700000050",
    "",
  ].join("\n"), "/tmp/tmux-501/cc")
  expect(out.map((s) => s.key)).toEqual(["shell:sh-a", "shell:sh-b"])
  expect(out[0]).toEqual({ key: "shell:sh-a", name: "sh-a", cwd: "/x/a", workspaceId: "", herdrPane: "", terminalId: "", tmuxPane: "%7", tmuxSocket: "/tmp/tmux-501/cc", createdAt: 1700000050000, panePid: 0, claudeKey: "" })
})

test("parseShellList: tmux's own socket_path wins over the fallback", () => {
  const out = parseShellList("sh-a\t1\t%7\t/x\t1\t/private/tmp/tmux-501/default\nsh-b\t1\t%8\t/y\t2\t\n", "/fallback")
  expect(out.map((s) => s.tmuxSocket)).toEqual(["/private/tmp/tmux-501/default", "/fallback"])
})

const A: ShellSession = { key: "shell:sh-a", name: "sh-a", cwd: "/x/a", workspaceId: "", herdrPane: "", terminalId: "", tmuxPane: "%7", tmuxSocket: "", createdAt: 1, panePid: 0, claudeKey: "" }
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

// A fake herdr holding `sh-*` workspaces: create adds one, pane close removes it.
// Like the real one, workspace ids only go up and a split keeps its pane id.
function fakeShells(opts: {
  gate?: string | null; dies?: boolean; down?: boolean; unclosable?: boolean; agent?: string; terminal?: string
  listDown?: () => boolean; onCreate?: () => void; renameDown?: () => boolean
} = {}) {
  const ws: Array<{ id: string; label: string; term: string; cwd: string; split?: boolean }> = []
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
        return { workspace: { workspace_id: id }, root_pane: { pane_id: `${id}:p1`, terminal_id: `term_${id}` } }
      }
      if (verb === "workspace list") return { workspaces: ws.map((w) => ({ workspace_id: w.id, label: w.label })).concat({ workspace_id: "w0", label: "brain" }) }
      if (verb === "pane list") {
        const roots = ws.filter((w) => w.term).map((w) => ({ pane_id: `${w.id}:p1`, workspace_id: w.id, terminal_id: w.term, cwd: w.cwd, foreground_cwd: `${w.cwd}/sub` }))
        const splits = ws.filter((w) => w.split).map((w) => ({ pane_id: `${w.id}:p2`, workspace_id: w.id, terminal_id: `split_${w.id}`, cwd: w.cwd, foreground_cwd: "" }))
        return { panes: [...splits, ...roots].sort((a, b) => a.workspace_id.localeCompare(b.workspace_id)).concat({ pane_id: "w0:p1", workspace_id: "w0", terminal_id: "term_b", cwd: "/b", foreground_cwd: "" }) }
      }
      if (verb === "workspace close") ws.splice(0, ws.length, ...ws.filter((w) => w.id !== args[2]))
      if (verb === "workspace rename") {
        if (opts.renameDown?.()) throw new Error("rename failed")
        ws.find((w) => w.id === args[2])!.label = args[3]!
      }
      if (verb === "pane process-info") return { process_info: { shell_pid: 4242, foreground_process_group_id: 4242 } }
      if (verb === "pane get") return { pane: { agent: opts.agent ?? "", terminal_id: opts.terminal ?? ws.find((w) => args[2] === `${w.id}:p1`)?.term } }
      if (verb === "pane close") {
        if (opts.unclosable) throw new Error("no")
        const i = ws.findIndex((w) => args[2] === `${w.id}:p1`)
        if (ws[i]?.split) ws[i]!.term = ""
        else ws.splice(i, 1)
      }
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

test("spawn shell: the shell died at once → session_exited, its workspace closed, no record", async () => {
  store.replace([])
  const f = fakeShells({ dies: true })
  expect(await spawnShellSession("/x/repo", f.deps)).toEqual({ ok: false, error: "session_exited" })
  expect(f.calls.at(-1)).toEqual(["workspace", "close", "w1"])
  expect(listShellSessions()).toEqual([])
})

test("herdr list: only sh-* workspaces; a blip is null and keeps the rows", async () => {
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

test("herdr list: a split never takes over the shell's row, a lone restored pane does", async () => {
  const f = fakeShells()
  store.replace([])
  await spawnShellSession("/x/repo", f.deps)
  const w = f.ws[0]!
  w.split = true
  expect(await readHerdrShells(f.h)).toMatchObject([{ herdrPane: `${w.id}:p1`, terminalId: w.term }])
  w.split = false
  w.term = "term_restored"
  expect(await readHerdrShells(f.h)).toMatchObject([{ herdrPane: `${w.id}:p1`, terminalId: "term_restored" }])
  store.replace([])
  f.ws.length = 0
  expect(await readHerdrShells(f.h)).toEqual([])
})

test("herdr list: two workspaces with one label give one row", async () => {
  const f = fakeShells()
  store.replace([])
  f.ws.push({ id: "w1", label: "sh-dup", term: "t1", cwd: "/a" }, { id: "w2", label: "sh-dup", term: "t2", cwd: "/b" })
  expect((await readHerdrShells(f.h))!.map((s) => s.terminalId)).toEqual(["t1"])
  store.replace([])
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
  const f = fakeShells({ onCreate: () => f.ws.push({ id: "w9", label: "sh-repo", term: "t9", cwd: "/x" }) })
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r).toEqual({ ok: false, error: "session_exited" })
  expect(f.calls.at(-1)).toEqual(["workspace", "close", "w1"])
  store.replace([])
})

test("spawn shell: a listing that fails after create closes the new workspace, no record", async () => {
  store.replace([])
  let reads = 0
  const f = fakeShells({ listDown: () => reads++ >= 2 })
  expect(await spawnShellSession("/x/repo", f.deps)).toEqual({ ok: false, error: "session_exited" })
  expect(f.ws).toEqual([])
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
  expect(f.ws).toEqual([])
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

test("spawn shell: a shell exits and its name is reused before the poll → a working new shell", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/repo", f.deps)
  f.ws.length = 0 // `exit`: the workspace is gone, the store still holds w1:p1
  const r = await spawnShellSession("/x/repo", f.deps)
  expect(r).toMatchObject({ ok: true, session: { name: "sh-repo", herdrPane: "w2:p1", terminalId: "term_w2" } })
  expect(f.calls.some((c) => c[1] === "close")).toBe(false)
  expect((await readHerdrShells(f.h))?.map((s) => s.terminalId)).toEqual(["term_w2"])
  expect(await closeShellSession("sh-repo", [], () => undefined, f.deps)).toEqual({ ok: true, gone: false })
  expect(f.calls.filter((c) => c[1] === "close")).toEqual([["pane", "close", "w2:p1"]])
})

test("herdr list: a second workspace with a live row's label, listed first, changes nothing", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/repo", f.deps)
  f.ws.unshift({ id: "w0b", label: "sh-repo", term: "t2", cwd: "/x" })
  expect((await readHerdrShells(f.h))?.map((s) => s.terminalId)).toEqual(["term_w1"])
  f.ws.pop()
  expect((await readHerdrShells(f.h, []))?.map((s) => s.terminalId)).toEqual(["t2"])
  store.replace([])
})

test("herdr list: a split left by a shell that exited loses the label, so a fresh start can't list it", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/repo", f.deps)
  const w = f.ws[0]!
  w.split = true
  w.term = ""
  expect(await readHerdrShells(f.h)).toEqual([])
  expect(f.calls.filter((c) => c[1] === "rename")).toEqual([["workspace", "rename", "w1", "split-repo"]])
  // A restart: an empty store and no memory of the release, herdr's label only.
  const fresh = fakeShells()
  fresh.ws.push({ id: "w8", label: w.label, term: "t", cwd: "/x" })
  expect(await readHerdrShells(fresh.h, [])).toEqual([])
  f.ws.length = 0
  await readHerdrShells(f.h)
})

test("herdr list: a failed rename still keeps the split off the list, and is retried", async () => {
  store.replace([])
  let down = true
  const f = fakeShells({ renameDown: () => down })
  await spawnShellSession("/x/repo", f.deps)
  const w = f.ws[0]!
  w.split = true
  w.term = ""
  expect(await readHerdrShells(f.h)).toEqual([])
  expect(w.label).toBe("sh-repo")
  expect(await readHerdrShells(f.h)).toEqual([])
  down = false
  expect(await readHerdrShells(f.h)).toEqual([])
  expect(w.label).toBe("split-repo")
  f.ws.length = 0
  await readHerdrShells(f.h)
  store.replace([])
})

test("close shell: a split survives, the close succeeds, and no later poll or retry reaches it", async () => {
  const f = fakeShells()
  store.replace([])
  await spawnShellSession("/x/repo", f.deps)
  const w = f.ws[0]!
  w.split = true
  const name = listShellSessions()[0]!.name
  expect(await closeShellSession(name, [], () => undefined, f.deps)).toEqual({ ok: true, gone: false })
  expect(listShellSessions()).toEqual([])
  expect(await readHerdrShells(f.h)).toEqual([])
  expect(await closeShellSession(name, [], () => undefined, f.deps)).toEqual({ ok: true, gone: true })
  expect(f.calls.filter((c) => c[1] === "close").map((c) => c[2])).toEqual([`${w.id}:p1`])
  f.ws.length = 0
  expect(await readHerdrShells(f.h)).toEqual([])
})

// ── Close (POST /api/shell/close) ──

const CLOSE_LIST = "sh-a\t1\t%7\t/x\t1700000000\t/tmp/tmux-501/default\t70\nsh-b\t1\t%8\t/y\t1700000001\t/tmp/tmux-501/default\t80\n"

// list-sessions shows sh-a and sh-b until a kill of that `=name` lands (unless `unkillable`).
function fakeCloseTmux(opts: { unkillable?: boolean; killCode?: number } = {}) {
  const which = () => "/usr/bin/tmux"
  const h = fakeHerdr({ reply: () => ({ workspaces: [], panes: [] }) }).h
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
  return { run, calls, which, h }
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

test("close shell (herdr): closes that pane only, drops the row; a tmux kill never runs", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/repo", f.deps)
  const detached: string[] = []
  expect(await closeShellSession("sh-repo", [], (k) => detached.push(k), f.deps)).toEqual({ ok: true, gone: false })
  expect(detached).toEqual(["shell:sh-repo"])
  expect(f.calls.filter((c) => c[1] === "close")).toEqual([["pane", "close", "w1:p1"]])
  expect(listShellSessions()).toEqual([])
})

test("close shell (herdr): an agent hooks don't know, or one on the pane → claude_running, pane untouched", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/repo", f.deps)
  const live = listShellSessions()[0]!
  store.replace([live])
  expect(await closeShellSession("sh-repo", [{ key: "c", pid: "", tmuxPane: "", herdrPane: "w1:p1" }], () => undefined, f.deps)).toEqual({ ok: false, error: "claude_running" })
  const busy = fakeShells({ agent: "claude", terminal: live.terminalId })
  expect(await closeShellSession("sh-repo", [], () => undefined, busy.deps)).toEqual({ ok: false, error: "claude_running" })
  expect([...f.calls, ...busy.calls].some((c) => c[1] === "close")).toBe(false)
  store.replace([])
})

test("close shell (herdr): a reused pane id (other terminal) is never closed", async () => {
  store.replace([])
  const f = fakeShells()
  await spawnShellSession("/x/repo", f.deps)
  const other = fakeShells({ terminal: "term_other" })
  expect(await closeShellSession("sh-repo", [], () => undefined, other.deps)).toEqual({ ok: true, gone: true })
  expect(other.calls.some((c) => c[1] === "close")).toBe(false)
  store.replace([])
})

test("close shell (herdr): the pane survives → kill_failed, row kept", async () => {
  store.replace([])
  const f = fakeShells({ unclosable: true })
  await spawnShellSession("/x/repo", f.deps)
  expect(await closeShellSession("sh-repo", [], () => undefined, f.deps)).toEqual({ ok: false, error: "kill_failed" })
  expect(listShellSessions().map((s) => s.name)).toEqual(["sh-repo"])
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
