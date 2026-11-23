import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detachedCommand } from "./worker-spawn"
import { createWorkerSupervisor } from "./worker-supervisor"

describe("detachedCommand", () => {
  test("under a systemd unit on Linux the worker gets its own transient scope; elsewhere it runs as is", () => {
    const yes = () => true
    expect(detachedCommand("claude", ["-p", "x"], { INVOCATION_ID: "abc" }, "linux", yes))
      .toEqual({ cmd: "systemd-run", args: ["--user", "--scope", "--quiet", "--collect", "--", "claude", "-p", "x"] })
    expect(detachedCommand("claude", ["-p"], {}, "linux", yes)).toEqual({ cmd: "claude", args: ["-p"] })
    expect(detachedCommand("claude", ["-p"], { INVOCATION_ID: "abc" }, "darwin", yes)).toEqual({ cmd: "claude", args: ["-p"] })
    // No user bus (a sandbox, a system unit): unwrapped rather than a worker that cannot start.
    expect(detachedCommand("claude", ["-p"], { INVOCATION_ID: "abc" }, "linux", () => false)).toEqual({ cmd: "claude", args: ["-p"] })
  })
})

const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true } catch { return false } }

describe("a worker survives a Companion restart", () => {
  test("server A spawns it and is SIGTERMed mid-turn; server B re-attaches, streams the rest, lands the receipt, leaves no orphan", async () => {
    const home = join(tmpdir(), `worker-spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const go = join(home, "go")
    // A headless claude: a background child in its group (must not outlive it), init, then its turn once `go` exists.
    const fake = join(home, "fake-claude")
    writeFileSync(fake, `#!/bin/sh
sleep 300 &
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sid-detach"}'
n=0; while [ ! -e '${go}' ] && [ $n -lt 300 ]; do sleep 0.05; n=$((n+1)); done
printf '%s\\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"Fixed after the restart."}]}}'
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"DONE https://github.com/jaubut/claude-companion/pull/999"}'
`)
    chmodSync(fake, 0o755)
    const serverA = join(home, "server-a.ts")
    writeFileSync(serverA, `import { mkdirSync } from "node:fs"
import { createWorkerSupervisor } from ${JSON.stringify(join(import.meta.dir, "worker-supervisor.ts"))}
import { spawnDetachedWorker } from ${JSON.stringify(join(import.meta.dir, "worker-spawn.ts"))}
const [home, fake] = process.argv.slice(2) as [string, string]
const sup = createWorkerSupervisor({
  host: "zettlab", home, now: Date.now, uuid: () => crypto.randomUUID(), trust: () => {}, reportJob: () => {}, loadAgentSecrets: async () => ({}),
  sh: async (_cmd, args) => {
    if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
    return { ok: true, out: "origin/main\\n", err: "", code: 0 }
  },
  spawnWorker: (opts) => spawnDetachedWorker({ ...opts, cmd: fake }),
})
const d = await sup.dispatchTask({ taskId: "survive-1", repo: "claude-companion", prompt: "Fix it", family: "claude", model: "claude-sonnet-5-5" })
if (!d.ok) { console.log("FAIL " + d.error); process.exit(1) }
for (let i = 0; i < 200 && sup.getTask("survive-1")?.sessionId !== "sid-detach"; i++) await Bun.sleep(25)
console.log("READY " + sup.getTask("survive-1")?.sessionId)
setInterval(() => {}, 1_000)
`)
    let a: ReturnType<typeof Bun.spawn> | null = null
    let pid = 0
    try {
      a = Bun.spawn([process.execPath, serverA, home, fake], { stdout: "pipe", stderr: "inherit" })
      const reader = (a.stdout as ReadableStream<Uint8Array>).getReader()
      let out = ""
      while (!out.includes("\n")) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value) }
      expect(out.trim()).toBe("READY sid-detach")
      const record = JSON.parse(readFileSync(join(home, ".claude", "state", "companion-worker-tasks.json"), "utf8"))[0]
      pid = record.pid as number
      expect(record.logOffset).toBeGreaterThan(0)

      // The deploy's restart: systemd SIGTERMs the server.
      a.kill("SIGTERM")
      await a.exited
      expect(groupAlive(pid)).toBe(true)

      const b = createWorkerSupervisor({
        host: "zettlab", home, now: Date.now, uuid: () => crypto.randomUUID(), trust: () => {}, reportJob: () => {},
        sh: async () => ({ ok: true, out: "", err: "", code: 0 }),
      })
      expect(b.getTask("survive-1")?.status).toBe("running")
      expect(b.pendingReceipts()).toEqual([])

      // Server C (e.g. a dev/test instance) loading the same state file while B is alive treats the reparented worker as foreign.
      const c = createWorkerSupervisor({
        host: "zettlab", home, selfPid: process.pid + 100_000, now: Date.now, uuid: () => crypto.randomUUID(), trust: () => {}, reportJob: () => {},
        sh: async () => ({ ok: true, out: "", err: "", code: 0 }),
      })
      expect(c.getTask("survive-1")).toBeNull()
      expect(existsSync(`${record.logFile}.out`)).toBe(true)

      writeFileSync(go, "")
      const done = await b.awaitTask("survive-1", 10_000)
      expect(done.ok && done.task.status).toBe("completed")
      expect(done.ok && done.task.prUrl).toBe("https://github.com/jaubut/claude-companion/pull/999")
      expect(b.pendingReceipts().map((r) => [r.task.taskId, r.task.status, r.task.result]))
        .toEqual([["survive-1", "completed", "DONE https://github.com/jaubut/claude-companion/pull/999"]])
      expect(c.pendingReceipts()).toEqual([])

      // No orphan: the worker's background child went with it, and its output files are gone.
      for (let i = 0; i < 100 && groupAlive(pid); i++) await Bun.sleep(20)
      expect(groupAlive(pid)).toBe(false)
      expect(readdirSync(join(home, ".claude", "state", "companion-worker-logs"))).toEqual([])
      expect(existsSync(`${record.logFile}.out`)).toBe(false)
    } finally {
      a?.kill("SIGKILL")
      if (pid > 1) try { process.kill(-pid, "SIGKILL") } catch { /* gone */ }
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)

  test("leader exits during the restart window while a background child in -rawPid stays alive: replays .out to completed, deletes .out/.err, and keeps worktree reservation until child exits", async () => {
    const home = join(tmpdir(), `worker-spawn-exited-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(home, "claude-companion", ".git"), { recursive: true })
    const go = join(home, "go")
    const doneFile = join(home, "leader-done")
    const fake = join(home, "fake-claude")
    writeFileSync(fake, `#!/bin/sh
sleep 300 &
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"sid-window"}'
n=0; while [ ! -e '${go}' ] && [ $n -lt 300 ]; do sleep 0.05; n=$((n+1)); done
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"SHIPPED https://github.com/jaubut/claude-companion/pull/1000"}'
touch '${doneFile}'
`)
    chmodSync(fake, 0o755)
    const serverA = join(home, "server-a.ts")
    writeFileSync(serverA, `import { mkdirSync } from "node:fs"
import { createWorkerSupervisor } from ${JSON.stringify(join(import.meta.dir, "worker-supervisor.ts"))}
import { spawnDetachedWorker } from ${JSON.stringify(join(import.meta.dir, "worker-spawn.ts"))}
const [home, fake] = process.argv.slice(2) as [string, string]
const sup = createWorkerSupervisor({
  host: "zettlab", home, now: Date.now, uuid: () => crypto.randomUUID(), trust: () => {}, reportJob: () => {}, loadAgentSecrets: async () => ({}),
  sh: async (_cmd, args) => {
    if (args.includes("worktree") && args.includes("add")) mkdirSync(args[args.indexOf("add") + (args.includes("-b") ? 4 : 2)]!, { recursive: true })
    return { ok: true, out: "origin/main\\n", err: "", code: 0 }
  },
  spawnWorker: (opts) => spawnDetachedWorker({ ...opts, cmd: fake }),
})
const d = await sup.dispatchTask({ taskId: "window-1", repo: "claude-companion", prompt: "Fix it", family: "claude", model: "claude-sonnet-5-5" })
if (!d.ok) { console.log("FAIL " + d.error); process.exit(1) }
for (let i = 0; i < 200 && sup.getTask("window-1")?.sessionId !== "sid-window"; i++) await Bun.sleep(25)
console.log("READY " + sup.getTask("window-1")?.sessionId)
setInterval(() => {}, 1_000)
`)
    let a: ReturnType<typeof Bun.spawn> | null = null
    let pid = 0
    try {
      a = Bun.spawn([process.execPath, serverA, home, fake], { stdout: "pipe", stderr: "inherit" })
      const reader = (a.stdout as ReadableStream<Uint8Array>).getReader()
      let out = ""
      while (!out.includes("\n")) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value) }
      expect(out.trim()).toBe("READY sid-window")
      const record = JSON.parse(readFileSync(join(home, ".claude", "state", "companion-worker-tasks.json"), "utf8"))[0]
      pid = record.pid as number

      // Server A dies; during the restart window the leader finishes its turn and exits, while `sleep 300 &` stays in -pid.
      a.kill("SIGTERM")
      await a.exited
      writeFileSync(go, "")
      for (let i = 0; i < 100 && !existsSync(doneFile); i++) await Bun.sleep(20)
      for (let i = 0; i < 100 && existsSync(`/proc/${pid}`); i++) await Bun.sleep(20)
      expect(groupAlive(pid)).toBe(true)

      const b = createWorkerSupervisor({
        host: "zettlab", home, killGraceMs: 50, now: Date.now, uuid: () => crypto.randomUUID(), trust: () => {}, reportJob: () => {},
        sh: async (_cmd, args) => {
          if (args.includes("worktree") && args.includes("remove")) {
            rmSync(args.at(-1)!, { recursive: true, force: true })
            return { ok: true, out: "", err: "", code: 0 }
          }
          if (args.includes("status") && args.includes("--porcelain")) return { ok: true, out: "", err: "", code: 0 }
          return { ok: true, out: "  origin/dispatch/window-1\n", err: "", code: 0 }
        },
      })
      const done = await b.awaitTask("window-1", 5_000)
      expect(done.ok && done.task.status).toBe("completed")
      expect(done.ok && done.task.prUrl).toBe("https://github.com/jaubut/claude-companion/pull/1000")
      expect(existsSync(`${record.logFile}.out`)).toBe(false)
      expect(existsSync(`${record.logFile}.err`)).toBe(false)

      // The unverified PGID was not SIGKILLed, and worktree reservation holds until the background child exits.
      expect(groupAlive(pid)).toBe(true)
      const kept = await b.interruptTask("window-1", { closeWorktree: true })
      expect(kept).toEqual({ ok: false, status: 409, error: "worktree kept: worker process has not exited yet" })

      process.kill(-pid, "SIGKILL")
      for (let i = 0; i < 100 && groupAlive(pid); i++) await Bun.sleep(20)
      const closed = await b.interruptTask("window-1", { closeWorktree: true })
      expect(closed.ok && closed.worktreeRemoved).toBe(true)
    } finally {
      a?.kill("SIGKILL")
      if (pid > 1) try { process.kill(-pid, "SIGKILL") } catch { /* gone */ }
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)
})
