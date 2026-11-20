// Desk runner (headless-desk P1): a phone or Canvas message to a claude/codex
// session runs as one headless turn on this host — `claude -p --resume <sid>`
// (stream-json) or `codex exec resume` — instead of keystrokes into a
// terminal. A session is a conversation id, never a tty or pane.
//
// One lease per sessionId: while our own turn runs, later sends queue (FIFO,
// cap QUEUE_CAP, each expiring at QUEUE_TTL_MS so the phone's 600 s
// DeliveredSend window never sees a second bubble) and run at turn exit.
// Refusals happen before any spawn:
//   runner_owned       a worker, the brain or the agy brain owns the sid
//   terminal_owned     an interactive claude/codex still holds it (idle or not)
//   target_gone (410)  no transcript on this host to resume
//   queue_full         the 6th queued send
// The lease survives a server restart (state file: pid + its start identity),
// so a restart never starts a second writer on a conversation.
//
// claude turns carry `--permission-prompt-tool stdio`: without it print mode
// leaves AskUserQuestion out of the tool set entirely (Verify 1b, CC 2.1.327).
// With it, the PreToolUse hook's `updatedInput.answers` answers the question
// and a hook that falls through is a denial (stdin is closed), never a hang.

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  type SpawnWorkerOpts, type SpawnedWorkerHandle,
  buildHeadlessClaudeArgs, buildHeadlessCodexArgs, defaultLoadAgentSecrets, defaultSpawnWorker, scrubAgentEnv,
} from "./worker-invocation"
import { defaultGetParentPid, defaultGetPidIdentity, defaultIsPidAlive, defaultKillPid } from "./worker-pid"
import { isAgentPidAlive } from "./agent-pid"
import { transcriptPath } from "./session-titles"
import { type Session, isHeadlessSession, listSessions, recordSession } from "./sessions"

export const DESK_PANE_PREFIX = "headless:desk:"
export const QUEUE_CAP = 5
export const QUEUE_TTL_MS = 540_000
export const KILL_GRACE_MS = 3_000
const RESTORE_POLL_MS = 2_000
const ROW_KEEP_MS = 24 * 60 * 60 * 1000

export type DeskAgent = "claude" | "codex"

export function deskStateFile(home = homedir()): string {
  return join(home, ".claude", "state", "companion-desk-turns.json")
}

export function deskEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPANION_DESK_HEADLESS === "1"
}

export function isDeskRow(s: Pick<Session, "herdrPane"> | null | undefined): boolean {
  return !!s?.herdrPane?.startsWith(DESK_PANE_PREFIX)
}

interface QueueItem { text: string; idemKey?: string; at: number; guard?: () => boolean }

export interface DeskTurnRecord {
  sid: string
  agent: DeskAgent
  cwd: string
  pid: number
  pidStart: string
  idemKey?: string
  queue: Array<Omit<QueueItem, "guard">>
}

interface DeskRow { sid: string; agent: DeskAgent; cwd: string; title: string; at: number }

interface Lease {
  sid: string
  agent: DeskAgent
  cwd: string
  text: string
  idemKey?: string
  handle: SpawnedWorkerHandle | null
  pid: number
  pidStart: string
  queue: QueueItem[]
  accepted: boolean
  interrupted: boolean
  killTimer: unknown
}

export type DeskSendResult =
  | { ok: true; queued: boolean; replayed?: boolean }
  | { ok: false; status: number; error: string }

export interface DeskSendInput {
  sid: string
  agent: string
  cwd: string
  text: string
  idemKey?: string
  // Checked again when a queued send is dequeued (Canvas: still the bound session?).
  guard?: () => boolean
}

export interface DeskDeps {
  spawn(opts: SpawnWorkerOpts): SpawnedWorkerHandle
  isAlive(pid: number): boolean
  identity(pid: number): string | null
  kill(pid: number, sig: NodeJS.Signals): void
  stateFile: string
  env(): Promise<NodeJS.ProcessEnv>
  transcriptExists(agent: DeskAgent, cwd: string, sid: string): boolean
  terminalHolds(sid: string, ownPids: ReadonlySet<number>): boolean
  runnerOwns(sid: string): boolean
  record(meta: Partial<Session> & { cwd: string }): Session | null
  broadcast(frame: Record<string, unknown>): void
  onLine(cwd: string, line: string): void
  onTurnExit(sid: string): void
  log(line: string): void
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
}

// Strip what would make a hook read the turn as a terminal or a worker.
const TERMINAL_ENV = /^(TMUX|TMUX_PANE|HERDR_.*|TERM_PROGRAM|TERM_SESSION_ID|ITERM_SESSION_ID|DISPATCH_.*|COMPANION_TASK_ID|COMPANION_HEADLESS|COMPANION_ORIGIN|COMPANION_SCRAPE|CLAUDE_CODE_SCRAPE_SESSION)$/

export function deskEnv(base: NodeJS.ProcessEnv, secrets: Record<string, string>): NodeJS.ProcessEnv {
  const env = scrubAgentEnv({ ...base, ...secrets })
  for (const k of Object.keys(env)) if (TERMINAL_ENV.test(k)) delete env[k]
  return env
}

let secretsOnce: Promise<Record<string, string>> | null = null

function descendsFromUs(pid: number, ownPids: ReadonlySet<number>): boolean {
  let p: number | null = pid
  for (let i = 0; i < 8 && p && p > 1; i++) {
    if (ownPids.has(p) || p === process.pid) return true
    p = defaultGetParentPid(p)
  }
  return false
}

// A live interactive claude/codex on this sid: a non-headless row with a live
// pid, or a ~/.claude/sessions/<pid>.json naming it — never our own turns.
export function defaultTerminalHolds(
  sid: string, ownPids: ReadonlySet<number>, home = homedir(),
  alive: (pid: string, agent: Session["agent"]) => boolean = isAgentPidAlive,
): boolean {
  for (const s of listSessions()) {
    if (s.sessionId !== sid || s.herdrPane?.startsWith("headless:") || !s.pid) continue
    if (alive(s.pid, s.agent) && !descendsFromUs(Number(s.pid), ownPids)) return true
  }
  const dir = join(home, ".claude", "sessions")
  let files: string[] = []
  try { files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)) } catch { return false }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { sessionId?: unknown; pid?: unknown }
      if (j.sessionId !== sid) continue
      const pid = Number(typeof j.pid === "number" ? j.pid : f.slice(0, -5))
      if (alive(String(pid), "claude") && !descendsFromUs(pid, ownPids)) return true
    } catch { /* unreadable: skip */ }
  }
  return false
}

export function createDeskRunner(over: Partial<DeskDeps> = {}) {
  const deps: DeskDeps = {
    spawn: defaultSpawnWorker,
    isAlive: defaultIsPidAlive,
    identity: defaultGetPidIdentity,
    kill: defaultKillPid,
    stateFile: deskStateFile(),
    env: async () => deskEnv(process.env, await (secretsOnce ??= defaultLoadAgentSecrets())),
    transcriptExists: (agent, cwd, sid) => agent === "codex" || existsSync(transcriptPath(cwd, sid)),
    terminalHolds: (sid, own) => defaultTerminalHolds(sid, own),
    runnerOwns: (sid) => isHeadlessSession(sid) || listSessions().some((s) => s.sessionId === sid && !!s.herdrPane?.startsWith("headless:") && !isDeskRow(s)),
    record: (meta) => recordSession(meta, { sessionIdConfirmed: true }),
    broadcast: () => {},
    onLine: () => {},
    onTurnExit: () => {},
    log: () => {},
    now: Date.now,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); return t },
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    ...over,
  }
  const leases = new Map<string, Lease>()
  const fresh = new Set<string>()   // created here, no turn yet → --session-id, not --resume
  const models = new Map<string, string>()
  const rows = new Map<string, DeskRow>()

  function persist(): void {
    const turns: DeskTurnRecord[] = [...leases.values()].map((l) => ({
      sid: l.sid, agent: l.agent, cwd: l.cwd, pid: l.pid, pidStart: l.pidStart, idemKey: l.idemKey,
      queue: l.queue.map(({ text, idemKey, at }) => ({ text, idemKey, at })),
    }))
    try {
      mkdirSync(dirname(deps.stateFile), { recursive: true })
      writeFileSync(deps.stateFile, JSON.stringify({ turns, models: Object.fromEntries(models), rows: [...rows.values()] }))
    } catch (err) { deps.log(`desk state not saved: ${(err as Error).message}`) }
  }

  function announce(sid: string, agent: DeskAgent, cwd: string, busy: boolean, pid = ""): Session | null {
    const prev = rows.get(sid)
    rows.set(sid, { sid, agent, cwd, title: prev?.title ?? "", at: deps.now() })
    return deps.record({
      agent, cwd, sessionId: sid, herdrPane: `${DESK_PANE_PREFIX}${sid}`,
      agentStatus: busy ? "busy" : "idle", pid, lastActiveAt: deps.now(),
      ...(models.get(sid) ? { model: models.get(sid) } : {}),
    })
  }

  function keyOf(agent: DeskAgent, sid: string): string {
    return `${agent}:sid:${sid}`
  }

  function refusal(sid: string, agent: string, cwd: string): DeskSendResult | null {
    if (agent !== "claude" && agent !== "codex") return { ok: false, status: 409, error: "unsupported_agent" }
    if (!sid) return { ok: false, status: 410, error: "target_gone" }
    if (deps.runnerOwns(sid)) return { ok: false, status: 409, error: "runner_owned" }
    const own = new Set([...leases.values()].map((l) => l.pid).filter((p) => p > 1))
    if (deps.terminalHolds(sid, own)) return { ok: false, status: 409, error: "terminal_owned" }
    if (!fresh.has(sid) && !leases.has(sid) && !deps.transcriptExists(agent, cwd, sid)) return { ok: false, status: 410, error: "target_gone" }
    return null
  }

  function expireLater(lease: Lease, item: QueueItem): void {
    deps.setTimer(() => {
      const i = lease.queue.indexOf(item)
      if (i < 0) return
      lease.queue.splice(i, 1)
      persist()
      deps.log(`desk queue expired → ${lease.sid.slice(0, 8)} "${item.text.slice(0, 40)}"`)
      deps.broadcast({ type: "inject_error", error: "queue_expired", key: keyOf(lease.agent, lease.sid), cwd: lease.cwd, text: item.text })
    }, QUEUE_TTL_MS)
  }

  async function start(lease: Lease): Promise<void> {
    const { sid, agent, cwd, text } = lease
    const resume = !fresh.has(sid)
    const model = models.get(sid)
    const args = agent === "claude"
      ? withPromptTool(buildHeadlessClaudeArgs({ prompt: text, sessionId: sid, resume, mode: "default", ...(model ? { model } : {}) }))
      : buildHeadlessCodexArgs({ prompt: text, sessionId: sid, resume: true, mode: "default", ...(model ? { model } : {}) })
    const env = await deps.env()
    if (lease.interrupted) return finish(lease, null, "SIGINT")
    fresh.delete(sid)
    deps.log(`desk turn → ${agent} ${sid.slice(0, 8)} in ${cwd} "${text.slice(0, 60)}"`)
    try {
      const handle = deps.spawn({
        cmd: agent, args, cwd, env,
        onStdoutLine: (line) => {
          if (agent !== "claude") return
          deps.onLine(cwd, line)
          // A reply proves the prompt landed even if its UserPromptSubmit hook never reached us.
          if (/"type":"(assistant|result)"/.test(line) && !line.includes('"is_error":true')) lease.accepted = true
        },
        onStderrLine: () => {},
        onExit: (code, sig) => finish(lease, code, sig),
      })
      lease.handle = handle
      lease.pid = handle.pid
      lease.pidStart = deps.identity(handle.pid) ?? ""
      persist()
      announce(sid, agent, cwd, true, handle.pid > 1 ? String(handle.pid) : "")
    } catch (err) {
      deps.log(`desk spawn failed → ${sid.slice(0, 8)}: ${(err as Error).message}`)
      finish(lease, 1, null)
    }
  }

  function finish(lease: Lease, code: number | null, sig: NodeJS.Signals | null): void {
    if (leases.get(lease.sid) !== lease) return
    if (lease.killTimer) deps.clearTimer(lease.killTimer)
    lease.killTimer = null
    const failed = !lease.interrupted && (lease.agent === "claude" ? !lease.accepted : code !== 0 || !!sig)
    if (failed) {
      deps.log(`desk turn failed → ${lease.sid.slice(0, 8)} (exit ${code ?? sig})`)
      deps.broadcast({ type: "inject_error", error: "turn_failed", key: keyOf(lease.agent, lease.sid), cwd: lease.cwd, text: lease.text })
    }
    // Interrupt cleared the queue; read it only now, so Stop never re-asserts the next turn.
    let next: QueueItem | undefined
    while (!lease.interrupted && (next = lease.queue.shift())) {
      if (!next.guard || next.guard()) break
      deps.log(`desk queued send dropped → ${lease.sid.slice(0, 8)}: target changed`)
      next = undefined
    }
    if (next) {
      Object.assign(lease, { text: next.text, idemKey: next.idemKey, handle: null, pid: 0, pidStart: "", accepted: false })
      persist()
      void start(lease)
      return
    }
    leases.delete(lease.sid)
    persist()
    announce(lease.sid, lease.agent, lease.cwd, false)
    deps.onTurnExit(lease.sid)
  }

  return {
    // Test seam: swap deps (spawn, env, probes) on a live runner.
    override(o: Partial<DeskDeps>): void {
      Object.assign(deps, o)
    },

    send(input: DeskSendInput): DeskSendResult {
      const lease = leases.get(input.sid)
      if (lease && input.idemKey && (lease.idemKey === input.idemKey || lease.queue.some((q) => q.idemKey === input.idemKey))) {
        return { ok: true, queued: lease.idemKey !== input.idemKey, replayed: true }
      }
      const refused = refusal(input.sid, input.agent, input.cwd)
      if (refused) return refused
      const agent = input.agent as DeskAgent
      const item: QueueItem = { text: input.text, idemKey: input.idemKey, at: deps.now(), guard: input.guard }
      if (lease) {
        if (lease.queue.length >= QUEUE_CAP) return { ok: false, status: 409, error: "queue_full" }
        lease.queue.push(item)
        expireLater(lease, item)
        persist()
        return { ok: true, queued: true }
      }
      const first: Lease = { sid: input.sid, agent, cwd: input.cwd, text: input.text, idemKey: input.idemKey, handle: null, pid: 0, pidStart: "", queue: [], accepted: false, interrupted: false, killTimer: null }
      leases.set(input.sid, first)
      void start(first)
      return { ok: true, queued: false }
    },

    // A new conversation with no turn yet: the row shows now, the first send starts it.
    create(agent: DeskAgent, cwd: string): Session | null {
      const sid = randomUUID()
      fresh.add(sid)
      const s = announce(sid, agent, cwd, false)
      persist()
      return s
    },

    // A conversation Companion takes over (ended terminal, resume): a desk row, idle.
    adopt(s: Pick<Session, "agent" | "sessionId" | "cwd"> & { title?: string }): Session | null {
      if ((s.agent !== "claude" && s.agent !== "codex") || !s.sessionId) return null
      const row = announce(s.sessionId, s.agent, s.cwd, leases.has(s.sessionId))
      if (s.title) rows.set(s.sessionId, { ...rows.get(s.sessionId)!, title: s.title })
      persist()
      return row
    },

    interrupt(sid: string): boolean {
      const lease = leases.get(sid)
      if (!lease) return false
      lease.interrupted = true
      lease.queue = []
      persist()
      if (lease.pid > 1) {
        deps.kill(lease.pid, "SIGINT")
        lease.killTimer = deps.setTimer(() => { if (deps.isAlive(lease.pid)) deps.kill(lease.pid, "SIGKILL") }, KILL_GRACE_MS)
      }
      deps.log(`desk interrupt → ${sid.slice(0, 8)}`)
      return true
    },

    // UserPromptSubmit of our own turn: the prompt landed (no turn_failed).
    noteAccepted(sid: string): boolean {
      const lease = leases.get(sid)
      if (!lease) return false
      lease.accepted = true
      return true
    },

    running(sid: string): boolean {
      return leases.has(sid)
    },

    setModel(sid: string, model: string): void {
      if (model) models.set(sid, model)
      persist()
    },

    modelFor(sid: string): string {
      return models.get(sid) ?? ""
    },

    // Boot: keep a live pid's lease (watched until it exits), run what was queued
    // behind a dead one, bring back the desk rows of the last day.
    restore(): void {
      let state: { turns?: DeskTurnRecord[]; models?: Record<string, string>; rows?: DeskRow[] } = {}
      try { state = JSON.parse(readFileSync(deps.stateFile, "utf8")) as typeof state } catch { return }
      for (const [sid, m] of Object.entries(state.models ?? {})) if (typeof m === "string") models.set(sid, m)
      for (const r of state.rows ?? []) {
        if (deps.now() - r.at > ROW_KEEP_MS) continue
        if (/(?:^|\/)(?:pr-shepherd-[^/]+|dispatch-[^/]+|apps\/wt\/)/i.test(r.cwd)) continue
        rows.set(r.sid, r)
        deps.record({ agent: r.agent, cwd: r.cwd, sessionId: r.sid, herdrPane: `${DESK_PANE_PREFIX}${r.sid}`, agentStatus: "idle", firstSeenAt: r.at, lastActiveAt: r.at, ...(r.title ? { title: r.title } : {}) })
      }
      for (const t of state.turns ?? []) {
        const lease: Lease = {
          sid: t.sid, agent: t.agent, cwd: t.cwd, text: "", idemKey: t.idemKey, handle: null, pid: t.pid, pidStart: t.pidStart,
          queue: (t.queue ?? []).filter((q) => deps.now() - q.at < QUEUE_TTL_MS), accepted: true, interrupted: false, killTimer: null,
        }
        leases.set(t.sid, lease)
        for (const q of lease.queue) expireLater(lease, q)
        const alive = t.pid > 1 && deps.isAlive(t.pid) && !!t.pidStart && deps.identity(t.pid) === t.pidStart
        if (!alive) { finish(lease, 0, null); continue }
        announce(t.sid, t.agent, t.cwd, true, String(t.pid))
        const watch = (): void => {
          if (leases.get(t.sid) !== lease) return
          if (deps.isAlive(t.pid) && deps.identity(t.pid) === t.pidStart) { deps.setTimer(watch, RESTORE_POLL_MS); return }
          finish(lease, 0, null)
        }
        deps.setTimer(watch, RESTORE_POLL_MS)
      }
      persist()
    },
  }
}

export type DeskRunner = ReturnType<typeof createDeskRunner>

function withPromptTool(args: string[]): string[] {
  const i = args.indexOf("--")
  return [...args.slice(0, i), "--permission-prompt-tool", "stdio", ...args.slice(i)]
}
