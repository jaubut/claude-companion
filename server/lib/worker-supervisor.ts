import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { BuilderReport } from "./builder-jobs"
import { type ShFn, realSh } from "./live-repo"
import { redactSecrets } from "./secret-redact"
import { ensureFolderTrusted } from "./spawn-session"

// Inverted MCP Worker Supervisor (BKM-Q24R Phase 3):
// Supervises headless `claude -p --output-format stream-json --verbose` builder
// subprocesses in isolated per-task git worktrees (`~/apps/wt/<repo>-<taskId>`
// on branch `dispatch/<taskId>`), replacing `herdr`/`tmux` pane scraping with:
//   - structured stream-json NDJSON event parsing → live BuilderJobStore frames
//   - event-driven `awaitTask` completion notifications (no terminal polling)
//   - multi-turn session continuity (`--session-id` on turn 1, `--resume` on 2+)
//   - process-group interruption (`interruptTask`) and guarded worktree cleanup.

export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/
export const ALLOWED_MODES = new Set(["acceptEdits", "auto", "default", "dontAsk", "plan"])
const PR_URL_RE = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/
const PROMPT_MAX = 100_000
const DEFAULT_TIMEOUT_S = 3600
const MAX_WAIT_MS = 120_000
const DEFAULT_WAIT_MS = 30_000

export type WorkerTaskStatus = "running" | "completed" | "failed" | "interrupted"

export interface StreamJsonEvent {
  sessionId?: string
  step?: string
  assistantText?: string
  resultText?: string
  isError?: boolean
  prUrl?: string
  done?: boolean
}

function shortCmd(raw: unknown): string {
  const s = redactSecrets(typeof raw === "string" ? raw : "").replace(/\s+/g, " ").trim()
  if (!s) return "Running command"
  return `Running ${s.length > 60 ? `${s.slice(0, 59)}…` : s}`
}

function shortPath(raw: unknown, prefix: string): string {
  const s = typeof raw === "string" ? raw.trim() : ""
  const base = s ? basename(s) : ""
  return base ? `${prefix} ${base}` : prefix
}

function toolStep(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return shortPath(input.file_path ?? input.path, "Editing")
    case "Read":
      return shortPath(input.file_path ?? input.path, "Reading")
    case "Grep":
      return typeof input.pattern === "string" && input.pattern.trim()
        ? `Searching ${redactSecrets(input.pattern.trim()).slice(0, 48)}`
        : "Searching codebase"
    case "Glob":
      return typeof input.pattern === "string" && input.pattern.trim()
        ? `Listing ${input.pattern.trim().slice(0, 48)}`
        : "Listing files"
    case "Bash":
      return shortCmd(input.command)
    default:
      return `Tool: ${name.slice(0, 48)}`
  }
}

/** Parse one NDJSON line from `claude -p --output-format stream-json --verbose`. Pure & never throws. */
export function parseStreamJsonLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return null
  let obj: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (!obj) return null

  const out: StreamJsonEvent = {}
  if (typeof obj.session_id === "string" && obj.session_id.trim()) {
    out.sessionId = obj.session_id.trim()
  }

  if (obj.type === "assistant") {
    const msg = obj.message && typeof obj.message === "object" ? (obj.message as Record<string, unknown>) : null
    const content = Array.isArray(msg?.content) ? msg.content : []
    const texts: string[] = []
    for (const block of content) {
      if (!block || typeof block !== "object") continue
      const b = block as Record<string, unknown>
      if (b.type === "tool_use" && typeof b.name === "string") {
        const input = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : {}
        out.step = toolStep(b.name, input)
      } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        texts.push(b.text.trim())
      }
    }
    if (texts.length > 0) {
      out.assistantText = texts.join("\n")
      const pr = out.assistantText.match(PR_URL_RE)?.[0]
      if (pr) out.prUrl = pr
    }
    return Object.keys(out).length > 0 ? out : null
  }

  if (obj.type === "result") {
    out.done = true
    out.isError = obj.is_error === true || (typeof obj.subtype === "string" && obj.subtype.startsWith("error"))
    if (typeof obj.result === "string") {
      out.resultText = obj.result.trim()
      const pr = out.resultText.match(PR_URL_RE)?.[0]
      if (pr) out.prUrl = pr
    }
    return out
  }

  return Object.keys(out).length > 0 ? out : null
}

export interface DispatchTaskInput {
  taskId: string
  repo: string
  prompt: string
  title?: string
  agent?: string
  model?: string
  mode?: string
  timeoutS?: number
}

export interface SupervisedTaskSnapshot {
  taskId: string
  repo: string
  title: string
  builder: string
  branch: string
  worktree: string
  sessionId: string
  status: WorkerTaskStatus
  turnCount: number
  step: string | null
  pct: number | null
  result: string
  prUrl: string | null
  error: string | null
  startedAt: number
  updatedAt: number
  completedAt: number | null
}

export interface SpawnedWorkerHandle {
  pid: number
  kill(sig: NodeJS.Signals): void
}

export interface SpawnWorkerOpts {
  cmd: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  onStdoutLine(line: string): void
  onStderrLine(line: string): void
  onExit(code: number | null, signal: NodeJS.Signals | null): void
}

export interface WorkerSupervisorDeps {
  host: string
  home: string
  now(): number
  uuid(): string
  sh: ShFn
  trust(dir: string): void
  reportJob(report: BuilderReport): void
  resolveRepoDir?(repo: string, home: string): string | null
  spawnWorker?(opts: SpawnWorkerOpts): SpawnedWorkerHandle
}

export function defaultResolveRepoDir(repo: string, home = homedir()): string | null {
  if (!REPO_NAME_RE.test(repo)) return null
  const candidates = [
    repo === "claude-companion-ios" ? join(home, "apps", "claude companion") : "",
    join(home, repo),
    join(home, "lanes", repo),
    join(home, "Developer", repo),
    join(home, "apps", repo),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(join(c, ".git"))) return c
  }
  return null
}

export function defaultSpawnWorker(opts: SpawnWorkerOpts): SpawnedWorkerHandle {
  const child = spawn(opts.cmd, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })
  let outBuf = ""
  let errBuf = ""
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    outBuf += chunk
    const lines = outBuf.split("\n")
    outBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStdoutLine(l)
  })
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    errBuf += chunk
    const lines = errBuf.split("\n")
    errBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStderrLine(l)
  })
  child.on("error", (err) => {
    opts.onStderrLine(err.message)
    opts.onExit(1, null)
  })
  child.on("close", (code, sig) => {
    if (outBuf.trim()) opts.onStdoutLine(outBuf)
    if (errBuf.trim()) opts.onStderrLine(errBuf)
    opts.onExit(code, sig)
  })
  return {
    pid: child.pid ?? 0,
    kill(sig: NodeJS.Signals) {
      if (!child.pid) return
      try {
        process.kill(-child.pid, sig)
      } catch {
        try { child.kill(sig) } catch { /* already gone */ }
      }
    },
  }
}

/** Build the headless `claude -p` argv for turn 1 (`--session-id`) or follow-up turns (`--resume`). */
export function buildHeadlessClaudeArgs(opts: {
  prompt: string
  sessionId: string
  resume: boolean
  mode: string
  agent?: string
  model?: string
}): string[] {
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    opts.mode,
    ...(opts.resume ? ["--resume", opts.sessionId] : ["--session-id", opts.sessionId]),
  ]
  if (opts.agent) args.push("--agent", opts.agent)
  if (opts.model) args.push("--model", opts.model)
  return args
}

interface InternalTask extends SupervisedTaskSnapshot {
  repoDir: string
  handle: SpawnedWorkerHandle | null
  timeoutTimer: ReturnType<typeof setTimeout> | null
  killTimer: ReturnType<typeof setTimeout> | null
  waiters: Set<() => void>
  stderrTail: string[]
}

function toSnapshot(t: InternalTask): SupervisedTaskSnapshot {
  return {
    taskId: t.taskId,
    repo: t.repo,
    title: t.title,
    builder: t.builder,
    branch: t.branch,
    worktree: t.worktree,
    sessionId: t.sessionId,
    status: t.status,
    turnCount: t.turnCount,
    step: t.step,
    pct: t.pct,
    result: t.result,
    prUrl: t.prUrl,
    error: t.error,
    startedAt: t.startedAt,
    updatedAt: t.updatedAt,
    completedAt: t.completedAt,
  }
}

export function createWorkerSupervisor(deps: WorkerSupervisorDeps) {
  const tasks = new Map<string, InternalTask>()
  const resolveRepo = deps.resolveRepoDir ?? defaultResolveRepoDir
  const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker

  function notifyWaiters(t: InternalTask): void {
    for (const fn of [...t.waiters]) {
      t.waiters.delete(fn)
      fn()
    }
  }

  function clearTimers(t: InternalTask): void {
    if (t.timeoutTimer) { clearTimeout(t.timeoutTimer); t.timeoutTimer = null }
    if (t.killTimer) { clearTimeout(t.killTimer); t.killTimer = null }
  }

  async function ensureWorktree(repoDir: string, repoSlug: string, taskId: string): Promise<{ ok: true; worktree: string; branch: string } | { ok: false; error: string }> {
    const wtRoot = join(deps.home, "apps", "wt")
    const worktree = join(wtRoot, `${repoSlug}-${taskId}`)
    const branch = `dispatch/${taskId}`
    if (existsSync(worktree)) {
      return { ok: true, worktree, branch }
    }
    mkdirSync(wtRoot, { recursive: true })
    const sym = await deps.sh("git", ["-C", repoDir, "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: repoDir, timeoutMs: 15_000 })
    const baseRef = sym.ok && sym.out.trim() ? sym.out.trim() : "origin/main"
    const baseBranch = baseRef.replace(/^origin\//, "")
    await deps.sh("git", ["-C", repoDir, "fetch", "-q", "origin", baseBranch], { cwd: repoDir, timeoutMs: 30_000 })
    const hasBranch = (await deps.sh("git", ["-C", repoDir, "show-ref", "-q", "--verify", `refs/heads/${branch}`], { cwd: repoDir, timeoutMs: 10_000 })).ok
    const wtRes = hasBranch
      ? await deps.sh("git", ["-C", repoDir, "worktree", "add", "-q", worktree, branch], { cwd: repoDir, timeoutMs: 30_000 })
      : await deps.sh("git", ["-C", repoDir, "worktree", "add", "-q", "-b", branch, worktree, baseRef], { cwd: repoDir, timeoutMs: 30_000 })
    if (!wtRes.ok) {
      return { ok: false, error: `worktree add failed: ${(wtRes.err || wtRes.out).trim().slice(0, 200)}` }
    }
    return { ok: true, worktree, branch }
  }

  return {
    async dispatchTask(input: DispatchTaskInput): Promise<{ ok: true; task: SupervisedTaskSnapshot } | { ok: false; status: number; error: string }> {
      const taskId = typeof input.taskId === "string" ? input.taskId.trim() : ""
      if (!TASK_ID_RE.test(taskId)) return { ok: false, status: 400, error: "invalid_task_id" }
      const repo = typeof input.repo === "string" ? input.repo.trim() : ""
      if (!REPO_NAME_RE.test(repo)) return { ok: false, status: 400, error: "invalid_repo" }
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : ""
      if (!prompt || prompt.length > PROMPT_MAX) return { ok: false, status: 400, error: "invalid_prompt" }
      const mode = input.mode?.trim() || "auto"
      if (!ALLOWED_MODES.has(mode)) return { ok: false, status: 400, error: "invalid_mode" }

      const existing = tasks.get(taskId)
      if (existing && existing.status === "running") {
        return { ok: false, status: 409, error: "task_already_running" }
      }

      const repoDir = existing?.repoDir ?? resolveRepo(repo, deps.home)
      if (!repoDir) return { ok: false, status: 404, error: `repo_not_found: ${repo}` }

      const repoSlug = repo.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
      const wt = await ensureWorktree(repoDir, repoSlug, taskId)
      if (!wt.ok) return { ok: false, status: 500, error: wt.error }

      deps.trust(wt.worktree)

      const now = deps.now()
      const resume = !!existing && existing.turnCount > 0
      const sessionId = existing?.sessionId ?? deps.uuid()
      const title = (input.title?.trim() || existing?.title || prompt.split("\n")[0] || taskId).slice(0, 200)
      const builder = `builder-${deps.host.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}-${repoSlug}-${taskId}`

      const task: InternalTask = existing ?? {
        taskId,
        repo,
        repoDir,
        title,
        builder,
        branch: wt.branch,
        worktree: wt.worktree,
        sessionId,
        status: "running",
        turnCount: 0,
        step: "Starting headless builder",
        pct: 5,
        result: "",
        prUrl: null,
        error: null,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        handle: null,
        timeoutTimer: null,
        killTimer: null,
        waiters: new Set(),
        stderrTail: [],
      }

      task.title = title
      task.status = "running"
      task.turnCount += 1
      task.step = resume ? `Turn ${task.turnCount}: resuming builder` : "Starting headless builder"
      task.pct = 5
      task.error = null
      task.completedAt = null
      task.updatedAt = now
      task.stderrTail = []
      tasks.set(taskId, task)

      deps.reportJob({
        event: "task",
        id: taskId,
        title: task.title,
        builder: task.builder,
        step: task.step,
        pct: task.pct,
      })

      const args = buildHeadlessClaudeArgs({
        prompt,
        sessionId: task.sessionId,
        resume,
        mode,
        agent: input.agent?.trim() || undefined,
        model: input.model?.trim() || undefined,
      })

      let settled = false
      const handle = spawnWorker({
        cmd: "claude",
        args,
        cwd: task.worktree,
        env: {
          ...process.env,
          DISPATCH_TASK_ID: taskId,
          DISPATCH_WORKER: "1",
          DISPATCH_HEADLESS: "1",
          COMPANION_TASK_ID: task.builder,
        },
        onStdoutLine(line) {
          const ev = parseStreamJsonLine(line)
          if (!ev) return
          task.updatedAt = deps.now()
          if (ev.sessionId) task.sessionId = ev.sessionId
          if (ev.prUrl) task.prUrl = ev.prUrl
          if (ev.assistantText) task.result = ev.assistantText
          if (ev.resultText) task.result = ev.resultText
          if (ev.step) {
            task.step = ev.step
            task.pct = Math.min(90, Math.max(10, (task.pct ?? 5) + 8))
            deps.reportJob({
              event: "progress",
              id: taskId,
              title: task.title,
              builder: task.builder,
              step: task.step,
              pct: task.pct,
            })
          }
          if (ev.done && ev.isError) {
            task.error = (ev.resultText || "builder turn reported an error").slice(0, 400)
          }
        },
        onStderrLine(line) {
          const clean = redactSecrets(line.trim()).slice(0, 300)
          if (clean) {
            task.stderrTail.push(clean)
            if (task.stderrTail.length > 10) task.stderrTail.shift()
          }
        },
        onExit(code, sig) {
          if (settled) return
          settled = true
          clearTimers(task)
          task.handle = null
          task.updatedAt = deps.now()
          task.completedAt = task.updatedAt
          if (task.status === "interrupted") {
            deps.reportJob({ event: "aborted", id: taskId, title: task.title, builder: task.builder, step: task.step ?? "Interrupted", pct: task.pct })
            notifyWaiters(task)
            return
          }
          const ok = code === 0 && !sig && !task.error
          if (ok) {
            task.status = "completed"
            task.pct = 100
            task.step = task.prUrl ? `PR ready: ${task.prUrl}` : "Turn completed"
            deps.reportJob({ event: "done", id: taskId, title: task.title, builder: task.builder, step: task.step, pct: 100 })
          } else {
            task.status = "failed"
            const tail = task.stderrTail.join(" | ")
            task.error = task.error ?? (`claude exited (code=${code ?? "null"} sig=${sig ?? "none"})${tail ? `: ${tail}` : ""}`).slice(0, 400)
            task.step = `Failed: ${task.error.slice(0, 100)}`
            deps.reportJob({ event: "aborted", id: taskId, title: task.title, builder: task.builder, step: task.step, pct: task.pct })
          }
          notifyWaiters(task)
        },
      })

      if (!settled) {
        task.handle = handle
        const timeoutMs = Math.max(1, input.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000
        task.timeoutTimer = setTimeout(() => {
          if (settled || task.status !== "running") return
          task.error = `timed out after ${Math.round(timeoutMs / 1000)}s`
          task.handle?.kill("SIGTERM")
          task.killTimer = setTimeout(() => {
            if (!settled) task.handle?.kill("SIGKILL")
          }, 5_000)
          task.killTimer.unref?.()
        }, timeoutMs)
        task.timeoutTimer.unref?.()
      }

      return { ok: true, task: toSnapshot(task) }
    },

    async awaitTask(taskId: string, waitMs = DEFAULT_WAIT_MS): Promise<{ ok: true; task: SupervisedTaskSnapshot; timedOut: boolean } | { ok: false; status: number; error: string }> {
      const t = tasks.get(taskId.trim())
      if (!t) return { ok: false, status: 404, error: "task_not_found" }
      const boundedWait = Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(waitMs)))
      if (t.status !== "running" || boundedWait === 0) {
        return { ok: true, task: toSnapshot(t), timedOut: false }
      }
      const timedOut = await new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const onDone = () => {
          if (timer) clearTimeout(timer)
          t.waiters.delete(onDone)
          resolve(false)
        }
        t.waiters.add(onDone)
        timer = setTimeout(() => {
          t.waiters.delete(onDone)
          resolve(true)
        }, boundedWait)
        timer.unref?.()
      })
      return { ok: true, task: toSnapshot(t), timedOut: timedOut && t.status === "running" }
    },

    async interruptTask(taskId: string, opts: { closeWorktree?: boolean } = {}): Promise<{ ok: true; task: SupervisedTaskSnapshot; worktreeRemoved: boolean; note?: string } | { ok: false; status: number; error: string }> {
      const t = tasks.get(taskId.trim())
      if (!t) return { ok: false, status: 404, error: "task_not_found" }
      if (t.status === "running") {
        t.status = "interrupted"
        t.error = "interrupted by caller"
        t.step = "Interrupted"
        t.updatedAt = deps.now()
        t.completedAt = t.updatedAt
        const h = t.handle
        clearTimers(t)
        if (h) {
          h.kill("SIGTERM")
          const killTimer = setTimeout(() => h.kill("SIGKILL"), 3_000)
          killTimer.unref?.()
        }
        deps.reportJob({ event: "aborted", id: t.taskId, title: t.title, builder: t.builder, step: "Interrupted", pct: t.pct })
        notifyWaiters(t)
      }

      let worktreeRemoved = false
      let note: string | undefined
      if (opts.closeWorktree && existsSync(t.worktree)) {
        const statusRes = await deps.sh("git", ["-C", t.worktree, "status", "--porcelain"], { cwd: t.worktree, timeoutMs: 10_000 })
        if (!statusRes.ok || statusRes.out.trim() !== "") {
          note = "worktree kept: uncommitted changes present"
        } else {
          await deps.sh("git", ["-C", t.worktree, "fetch", "-q", "origin"], { cwd: t.worktree, timeoutMs: 20_000 })
          const pushed = await deps.sh("git", ["-C", t.worktree, "branch", "-r", "--contains", "HEAD"], { cwd: t.worktree, timeoutMs: 10_000 })
          if (!pushed.ok || pushed.out.trim() === "") {
            note = "worktree kept: HEAD is not pushed to any remote branch"
          } else {
            const rm = await deps.sh("git", ["-C", t.repoDir, "worktree", "remove", t.worktree], { cwd: t.repoDir, timeoutMs: 20_000 })
            if (rm.ok) {
              await deps.sh("git", ["-C", t.repoDir, "branch", "-D", t.branch], { cwd: t.repoDir, timeoutMs: 10_000 })
              worktreeRemoved = true
            } else {
              note = `worktree kept: ${(rm.err || rm.out).trim().slice(0, 160)}`
            }
          }
        }
      }

      return { ok: true, task: toSnapshot(t), worktreeRemoved, ...(note ? { note } : {}) }
    },

    listTasks(): SupervisedTaskSnapshot[] {
      return [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(toSnapshot)
    },

    getTask(taskId: string): SupervisedTaskSnapshot | null {
      const t = tasks.get(taskId.trim())
      return t ? toSnapshot(t) : null
    },
  }
}

export type WorkerSupervisor = ReturnType<typeof createWorkerSupervisor>
