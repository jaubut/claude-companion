import { spawn, spawnSync } from "node:child_process"
import { closeSync, fstatSync, mkdirSync, openSync, readSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { defaultKillPid } from "./worker-pid"

// How a headless worker process starts: piped (defaultSpawnWorker), or detached (spawnDetachedWorker).

/** `offset`: the stdout bytes handled so far, when the output goes to a file (spawnDetachedWorker): a restart resumes there. */
export interface SpawnedWorkerHandle { pid: number; kill(sig: NodeJS.Signals): void; offset?(): number }

export interface SpawnWorkerOpts {
  cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv
  /** Output to `<logFile>.out` / `.err` instead of pipes, so the worker outlives the server (spawnDetachedWorker); the pipe spawner ignores it. */
  logFile?: string
  onStdoutLine(line: string): void; onStderrLine(line: string): void; onExit(code: number | null, signal: NodeJS.Signals | null): void
}

export function defaultSpawnWorker(opts: SpawnWorkerOpts): SpawnedWorkerHandle {
  const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: true })
  let outBuf = "", errBuf = ""
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    outBuf += chunk; const lines = outBuf.split("\n"); outBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStdoutLine(l)
  })
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    errBuf += chunk; const lines = errBuf.split("\n"); errBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStderrLine(l)
  })
  child.on("error", (err) => { opts.onStderrLine(err.message); opts.onExit(1, null) })
  child.on("close", (code, sig) => {
    if (outBuf.trim()) opts.onStdoutLine(outBuf)
    if (errBuf.trim()) opts.onStderrLine(errBuf)
    opts.onExit(code, sig)
  })
  return { pid: child.pid ?? 0, kill(sig: NodeJS.Signals) { if (child.pid) defaultKillPid(child.pid, sig) } }
}

// A supervised worker that outlives a Companion restart (every auto-deploy killed them, 2026-11-15): its stdout / stderr go
// to files the server tails (a pipe dies with the server), and under systemd it runs in its own transient scope, so
// `systemctl restart claude-companion` stops the service's cgroup without it. The next boot re-attaches (attachDetachedWorker).

// ponytail: polled, not fs.watch (flaky across platforms); 200 ms of progress latency.
const POLL_MS = 200

type TurnCallbacks = Pick<SpawnWorkerOpts, "onStdoutLine" | "onStderrLine" | "onExit">
interface FollowOpts extends TurnCallbacks { logFile: string; outFrom: number; errFrom: number }

const SCOPE = ["--user", "--scope", "--quiet", "--collect", "--"]
let scopeOk: boolean | null = null
/** Once per server: can it start a user scope (a sandbox or a system unit has no user bus)? Without one, workers run unwrapped. */
const canScope = (): boolean => (scopeOk ??= spawnSync("systemd-run", [...SCOPE, "true"], { stdio: "ignore", timeout: 5_000 }).status === 0)

/** Under a systemd unit (INVOCATION_ID), `systemd-run --user --scope` execs the worker in a scope of its own: out of the service's cgroup. */
export function detachedCommand(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, scopeWorks = canScope): { cmd: string; args: string[] } {
  return platform === "linux" && env.INVOCATION_ID && scopeWorks() ? { cmd: "systemd-run", args: [...SCOPE, cmd, ...args] } : { cmd, args }
}

/** Whole lines appended to `file` from byte `pos`. `offset()`: the bytes delivered so far, saved so a restart resumes there. */
function tailLines(file: string, pos: number, onLine: (line: string) => void) {
  let fd: number | null = null
  const read = (flush: boolean): void => {
    try { fd ??= openSync(file, "r") } catch { return }
    const size = fstatSync(fd).size
    if (size <= pos) return
    const buf = Buffer.alloc(size - pos)
    const n = readSync(fd, buf, 0, buf.length, pos)
    let start = 0
    for (let nl = buf.indexOf(10); nl !== -1 && nl < n; start = nl + 1, nl = buf.indexOf(10, start)) {
      pos += nl + 1 - start // advanced first: a save inside onLine records this line as consumed
      const line = buf.toString("utf8", start, nl)
      if (line.trim()) onLine(line)
    }
    if (flush && start < n) { pos += n - start; const line = buf.toString("utf8", start, n); if (line.trim()) onLine(line) }
  }
  return { read, offset: () => pos, close: () => { if (fd !== null) closeSync(fd); fd = null } }
}

/** Tails both files until `exited`: then the rest is read, leftovers in the worker's process group are killed (no orphan), the files go. */
function follow(pid: number, o: FollowOpts): { handle: SpawnedWorkerHandle; exited(code: number | null, sig: NodeJS.Signals | null): void } {
  const out = tailLines(`${o.logFile}.out`, o.outFrom, o.onStdoutLine)
  const err = tailLines(`${o.logFile}.err`, o.errFrom, o.onStderrLine)
  const timer = setInterval(() => { try { out.read(false); err.read(false) } catch { /* a callback threw: the next poll goes on */ } }, POLL_MS)
  let done = false
  const exited = (code: number | null, sig: NodeJS.Signals | null): void => {
    if (done) return
    done = true
    clearInterval(timer)
    try { out.read(true); err.read(true) } catch { /* best effort */ }
    out.close(); err.close()
    defaultKillPid(pid, "SIGKILL")
    try { o.onExit(code, sig) } finally { rmSync(`${o.logFile}.out`, { force: true }); rmSync(`${o.logFile}.err`, { force: true }) }
  }
  return { handle: { pid, kill: (sig) => defaultKillPid(pid, sig), offset: out.offset }, exited }
}

/** The supervisor's spawner: output to `<logFile>.out` / `.err` (0600) instead of pipes. No logFile: the plain pipe spawner. */
export function spawnDetachedWorker(opts: SpawnWorkerOpts): SpawnedWorkerHandle {
  const logFile = opts.logFile
  if (!logFile) return defaultSpawnWorker(opts)
  mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 })
  const fds = [openSync(`${logFile}.out`, "w", 0o600), openSync(`${logFile}.err`, "w", 0o600)]
  const { cmd, args } = detachedCommand(opts.cmd, opts.args)
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", fds[0]!, fds[1]!], detached: true })
  } catch (err) {
    rmSync(`${logFile}.out`, { force: true }); rmSync(`${logFile}.err`, { force: true })
    throw err
  } finally {
    for (const fd of fds) closeSync(fd)
  }
  const f = follow(child.pid ?? 0, { ...opts, logFile, outFrom: 0, errFrom: 0 })
  child.on("error", (err) => { opts.onStderrLine(err.message); f.exited(1, null) })
  child.on("exit", (code, sig) => f.exited(code, sig))
  return f.handle
}

/** After a restart: follow a worker an earlier server spawned, from the saved stdout offset. `alive()` false = it ended (not
 *  our child any more: exit status unknown, onExit gets nulls). pid null: it ended while the server was down; its output is replayed. */
export function attachDetachedWorker(o: TurnCallbacks & { logFile: string; outFrom: number; pid: number | null; alive(): boolean }): SpawnedWorkerHandle {
  let errFrom = 0
  try { errFrom = statSync(`${o.logFile}.err`).size } catch { /* none */ }
  const f = follow(o.pid ?? 0, { ...o, errFrom })
  const timer = setInterval(() => { if (o.pid === null || !o.alive()) { clearInterval(timer); f.exited(null, null) } }, POLL_MS)
  return f.handle
}
