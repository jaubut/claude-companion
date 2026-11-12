import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { BuilderReport } from "./builder-jobs"
import { decideWorkerModel } from "./jev-model-router"
import type { ShFn } from "./live-repo"
import { redactSecrets } from "./secret-redact"
import {
  ALLOWED_FAMILIES, ALLOWED_MODES, REPO_NAME_RE, SAFE_IDENTIFIER_RE, TASK_ID_RE,
  type StreamJsonEvent, type WorkerFamily, type WorkerTaskStatus,
  buildHeadlessClaudeArgs, buildHeadlessCodexArgs, buildHeadlessGeminiArgs,
  buildHeadlessWorkerInvocation, buildWorkerEnv, parseStreamJsonLine, resolveWorkerFamily,
} from "./worker-invocation"

export {
  ALLOWED_FAMILIES, ALLOWED_MODES, REPO_NAME_RE, SAFE_IDENTIFIER_RE, TASK_ID_RE,
  type StreamJsonEvent, type WorkerFamily, type WorkerTaskStatus,
  buildHeadlessClaudeArgs, buildHeadlessCodexArgs, buildHeadlessGeminiArgs,
  buildHeadlessWorkerInvocation, buildWorkerEnv, parseStreamJsonLine, resolveWorkerFamily,
}

const PROMPT_MAX = 100_000, DEFAULT_TIMEOUT_S = 3600, MAX_WAIT_MS = 120_000, DEFAULT_WAIT_MS = 30_000

export interface DispatchTaskInput {
  taskId: string; repo: string; prompt: string; title?: string; family?: string; agent?: string; model?: string; mode?: string; timeoutS?: number
}

export interface SupervisedTaskSnapshot {
  taskId: string; repo: string; title: string; builder: string; family: WorkerFamily; model: string | null; branch: string; worktree: string; sessionId: string
  status: WorkerTaskStatus; turnCount: number; step: string | null; pct: number | null; result: string; prUrl: string | null
  error: string | null; startedAt: number; updatedAt: number; completedAt: number | null
}

export interface SpawnedWorkerHandle { pid: number; kill(sig: NodeJS.Signals): void }

export interface SpawnWorkerOpts {
  cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv
  onStdoutLine(line: string): void; onStderrLine(line: string): void; onExit(code: number | null, signal: NodeJS.Signals | null): void
}

export interface WorkerSupervisorDeps {
  host: string; home: string; now(): number; uuid(): string; sh: ShFn; trust(dir: string): void; reportJob(report: BuilderReport): void
  stateFile?: string; killGraceMs?: number; resolveRepoDir?(repo: string, home: string): string | null; spawnWorker?(opts: SpawnWorkerOpts): SpawnedWorkerHandle
  isPidAlive?(pid: number): boolean; killPid?(pid: number, sig: NodeJS.Signals): void; getPidIdentity?(pid: number): string | null
  syncSession?(task: SupervisedTaskSnapshot, pid: number | null): void
  onTaskTerminal?(task: SupervisedTaskSnapshot): void
}

export function defaultResolveRepoDir(repo: string, home = homedir()): string | null {
  if (!REPO_NAME_RE.test(repo)) return null
  const candidates = [repo === "claude-companion-ios" ? join(home, "apps", "claude companion") : "", join(home, repo), join(home, "lanes", repo), join(home, "Developer", repo), join(home, "apps", repo)].filter(Boolean)
  for (const c of candidates) if (existsSync(join(c, ".git"))) return c
  return null
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(-pid, 0); return true } catch { return false }
}

export function defaultKillPid(pid: number, sig: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  try { process.kill(-pid, sig) } catch { /* gone */ }
}

export function defaultGetPidIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    if (existsSync(`/proc/${pid}/stat`)) {
      const bootId = existsSync("/proc/sys/kernel/random/boot_id") ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : "linux"
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const rparen = stat.lastIndexOf(")")
      const startTime = rparen > 0 ? stat.slice(rparen + 2).trim().split(/\s+/)[19] ?? "" : ""
      if (startTime) return `${bootId}:${pid}:${startTime}`
    }
    const ps = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_000 })
    const out = (ps.stdout ?? "").trim()
    return ps.status === 0 && out ? `ps:${pid}:${out}` : null
  } catch { return null }
}

/**
 * Claude Code's Linux sandbox ro-binds /dev/null over `.git/config.lock` of the repo a worktree belongs to (hard-coded
 * in the CLI, no setting turns it off). A sandbox killed mid-command leaves that mount point on the host as a 0-byte
 * 0444 file, and every later `git config` write there fails ("could not lock config file"). Remove it unless some live
 * process still has it open or mounted. Without /proc (macOS, where the sandbox doesn't do this) it is left alone.
 */
export function clearStaleGitConfigLock(repoDir: string): void {
  const lock = join(repoDir, ".git", "config.lock")
  try {
    const st = statSync(lock)
    if (!st.isFile() || st.size !== 0 || (st.mode & 0o222) !== 0) return
    const mountPoint = ` ${lock.replace(/ /g, "\\040")} `
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue
      try { if (readFileSync(`/proc/${pid}/mountinfo`, "utf8").includes(mountPoint)) return } catch { /* gone or not ours */ }
      try { for (const fd of readdirSync(`/proc/${pid}/fd`)) if (readlinkSync(`/proc/${pid}/fd/${fd}`) === lock) return } catch { /* gone or not ours */ }
    }
    rmSync(lock, { force: true })
  } catch { /* no stub, or no /proc */ }
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

interface PersistedTaskRecord extends SupervisedTaskSnapshot {
  repoDir: string; pid?: number | null; pidIdentity?: string | null; sessionStarted?: boolean
}
interface InternalTask extends PersistedTaskRecord {
  pid: number | null; pidIdentity: string | null; reloadedFromDisk: boolean; sessionStarted: boolean
  activeTurn: number; jobId: string; turnReportedTerminal: boolean
  handle: SpawnedWorkerHandle | null; exitPromise: Promise<void> | null
  timeoutTimer: ReturnType<typeof setTimeout> | null; killTimer: ReturnType<typeof setTimeout> | null
  waiters: Set<() => void>; stderrTail: string[]
}
function toSnapshot(t: InternalTask): SupervisedTaskSnapshot {
  const { taskId, repo, title, builder, family, model, branch, worktree, sessionId, status, turnCount, step, pct, result, prUrl, error, startedAt, updatedAt, completedAt } = t
  return { taskId, repo, title, builder, family, model, branch, worktree, sessionId, status, turnCount, step, pct, result, prUrl, error, startedAt, updatedAt, completedAt }
}
function waitMsPromise(ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => { const tm = setTimeout(() => resolve(false), ms); tm.unref?.() })
}
function sameRealPath(a: string, b: string): boolean {
  try { return realpathSync(a) === realpathSync(b) } catch { return a === b }
}

export function createWorkerSupervisor(deps: WorkerSupervisorDeps) {
  const tasks = new Map<string, InternalTask>()
  const inFlightDispatches = new Set<string>()
  const inFlightWorktrees = new Set<string>()
  const resolveRepo = deps.resolveRepoDir ?? defaultResolveRepoDir
  const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive
  const killPid = deps.killPid ?? defaultKillPid
  const getPidIdentity = deps.getPidIdentity ?? ((pid: number) => defaultGetPidIdentity(pid) ?? (deps.isPidAlive ? `mock:${pid}` : null))
  const stateFile = deps.stateFile ?? join(deps.home, ".claude", "state", "companion-worker-tasks.json")
  const killGraceMs = Math.max(50, deps.killGraceMs ?? 3_000)

  function syncTaskSession(t: InternalTask): void {
    try { deps.syncSession?.(toSnapshot(t), t.handle?.pid ?? t.pid ?? null) } catch { /* best effort */ }
  }

  function savePersistedTasks(): void {
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const records: PersistedTaskRecord[] = [...tasks.values()].map((t) => ({
        ...toSnapshot(t), repoDir: t.repoDir, pid: t.handle?.pid ?? t.pid ?? null, pidIdentity: t.pidIdentity, sessionStarted: t.sessionStarted,
      }))
      const tmp = `${stateFile}.tmp.${process.pid}.${Date.now()}`
      writeFileSync(tmp, JSON.stringify(records))
      renameSync(tmp, stateFile)
    } catch { /* best-effort persistence */ }
  }

  function loadPersistedTasks(): void {
    if (!existsSync(stateFile)) return
    let parsed: unknown = null
    try { parsed = JSON.parse(readFileSync(stateFile, "utf8")) as unknown } catch { return }
    if (!Array.isArray(parsed)) return
    const now = deps.now()
    let dirty = false
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue
      const r = item as Partial<PersistedTaskRecord>
      if (typeof r.taskId !== "string" || !TASK_ID_RE.test(r.taskId) || typeof r.repo !== "string" || !REPO_NAME_RE.test(r.repo)) continue
      if (typeof r.repoDir !== "string" || !r.repoDir || typeof r.worktree !== "string" || !r.worktree || typeof r.sessionId !== "string" || !r.sessionId) continue
      const wasRunning = r.status === "running"
      const turnCount = typeof r.turnCount === "number" && r.turnCount > 0 ? Math.floor(r.turnCount) : 1
      const rawPid = typeof r.pid === "number" && Number.isInteger(r.pid) && r.pid > 1 ? r.pid : null
      const savedIdentity = typeof r.pidIdentity === "string" && r.pidIdentity ? r.pidIdentity : null
      let survivingPid: number | null = null
      let survivingIdentity: string | null = null
      if (rawPid !== null && isPidAlive(rawPid)) {
        const currentIdentity = getPidIdentity(rawPid)
        if (savedIdentity && currentIdentity !== null && currentIdentity === savedIdentity) {
          killPid(rawPid, "SIGTERM")
          if (isPidAlive(rawPid)) { survivingPid = rawPid; survivingIdentity = savedIdentity }
        } else if (currentIdentity === null || !savedIdentity) { survivingPid = rawPid; survivingIdentity = savedIdentity } // unknown identity != exited: group stays reserved
        dirty = true
      } else if (rawPid !== null) dirty = true
      if (wasRunning) dirty = true
      const loadedFamily = resolveWorkerFamily({ family: r.family, model: r.model ?? undefined }) ?? "claude"
      const taskRecord: InternalTask = {
        taskId: r.taskId, repo: r.repo, repoDir: r.repoDir,
        title: typeof r.title === "string" ? r.title : r.taskId,
        builder: typeof r.builder === "string" ? r.builder : `builder-${r.repo}-${r.taskId}`,
        family: loadedFamily,
        model: typeof r.model === "string" && r.model ? r.model : null,
        branch: typeof r.branch === "string" ? r.branch : `dispatch/${r.taskId}`,
        worktree: r.worktree, sessionId: r.sessionId,
        status: wasRunning ? "interrupted" : (r.status ?? "interrupted"),
        turnCount,
        step: wasRunning ? "Interrupted (server restarted)" : (typeof r.step === "string" ? r.step : null),
        pct: typeof r.pct === "number" ? r.pct : null,
        result: typeof r.result === "string" ? r.result : "",
        prUrl: typeof r.prUrl === "string" ? r.prUrl : null,
        error: wasRunning ? "server restarted while task was running" : (typeof r.error === "string" ? r.error : null),
        startedAt: typeof r.startedAt === "number" ? r.startedAt : now,
        updatedAt: wasRunning ? now : (typeof r.updatedAt === "number" ? r.updatedAt : now),
        completedAt: wasRunning ? now : (typeof r.completedAt === "number" ? r.completedAt : null),
        pid: survivingPid, pidIdentity: survivingIdentity, reloadedFromDisk: survivingPid !== null,
        sessionStarted: typeof r.sessionStarted === "boolean" ? r.sessionStarted : r.status === "completed",
        activeTurn: turnCount, jobId: turnCount <= 1 ? r.taskId : `${r.taskId}:t${turnCount}`,
        turnReportedTerminal: true, handle: null, exitPromise: null, timeoutTimer: null, killTimer: null, waiters: new Set(), stderrTail: [],
      }
      tasks.set(r.taskId, taskRecord)
      syncTaskSession(taskRecord)
    }
    if (dirty) savePersistedTasks()
  }

  loadPersistedTasks()

  async function reconcileSurvivingProcess(t: InternalTask): Promise<boolean> {
    if (t.exitPromise) {
      const exited = await Promise.race([t.exitPromise.then(() => true), waitMsPromise(killGraceMs + 1_000)])
      if (!exited || t.handle !== null || t.exitPromise !== null) return false
    }
    if (t.pid !== null) {
      const pid = t.pid
      if (isPidAlive(pid)) {
        const curId = getPidIdentity(pid)
        if (t.pidIdentity && curId !== null && curId !== t.pidIdentity) {
          t.pid = null; t.pidIdentity = null; t.reloadedFromDisk = false; savePersistedTasks(); return true
        }
        if (t.pidIdentity && curId === t.pidIdentity) killPid(pid, "SIGTERM")
        const deadline = Date.now() + killGraceMs
        while (Date.now() < deadline && isPidAlive(pid)) await waitMsPromise(25)
        if (isPidAlive(pid)) {
          const curId2 = getPidIdentity(pid)
          if (t.pidIdentity && curId2 !== null && curId2 !== t.pidIdentity) {
            t.pid = null; t.pidIdentity = null; t.reloadedFromDisk = false; savePersistedTasks(); return true
          }
          if (t.pidIdentity && curId2 === t.pidIdentity) { killPid(pid, "SIGKILL"); await waitMsPromise(100) }
        }
        if (isPidAlive(pid)) return false
      }
      t.pid = null; t.pidIdentity = null; t.reloadedFromDisk = false; savePersistedTasks()
    }
    return true
  }

  function notifyWaiters(t: InternalTask): void {
    for (const fn of [...t.waiters]) { t.waiters.delete(fn); fn() }
  }

  function clearTimers(t: InternalTask): void {
    if (t.timeoutTimer) { clearTimeout(t.timeoutTimer); t.timeoutTimer = null }
    if (t.killTimer) { clearTimeout(t.killTimer); t.killTimer = null }
  }

  for (const dir of new Set([...tasks.values()].map((t) => t.repoDir))) clearStaleGitConfigLock(dir)

  async function ensureWorktree(repoDir: string, repo: string, taskId: string, ownedByTask: boolean): Promise<{ ok: true; worktree: string; branch: string } | { ok: false; error: string }> {
    clearStaleGitConfigLock(repoDir)
    const wtRoot = join(deps.home, "apps", "wt", repo)
    const worktree = join(wtRoot, taskId)
    const branch = `dispatch/${taskId}`
    for (const other of tasks.values()) {
      if ((other.taskId !== taskId || other.repo !== repo) && other.worktree.toLowerCase() === worktree.toLowerCase()) {
        return { ok: false, error: `worktree collision with ${other.repo}/${other.taskId}` }
      }
    }
    if (existsSync(worktree)) {
      if (!ownedByTask && !existsSync(join(worktree, ".git"))) return { ok: false, error: "worktree path already exists and is not a git worktree" }
      const common = await deps.sh("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: worktree, timeoutMs: 10_000 })
      if (!common.ok) return { ok: false, error: "existing worktree is not a valid git repository" }
      const commonOut = common.out.trim()
      if (commonOut.startsWith("/") && !sameRealPath(commonOut, join(repoDir, ".git"))) return { ok: false, error: "existing worktree belongs to a different repository" }
      const curBranch = await deps.sh("git", ["-C", worktree, "symbolic-ref", "-q", "--short", "HEAD"], { cwd: worktree, timeoutMs: 10_000 })
      if (!curBranch.ok) return { ok: false, error: "existing worktree is not on a branch" }
      const bOut = curBranch.out.trim()
      if (bOut && bOut !== "origin/main" && bOut !== branch) return { ok: false, error: `existing worktree branch mismatch: ${bOut}` }
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
    if (!wtRes.ok) return { ok: false, error: `worktree add failed: ${(wtRes.err || wtRes.out).trim().slice(0, 200)}` }
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
      const agent = input.agent?.trim() || undefined
      if (agent && !SAFE_IDENTIFIER_RE.test(agent)) return { ok: false, status: 400, error: "invalid_agent" }
      const model = input.model?.trim() || undefined
      if (model && !SAFE_IDENTIFIER_RE.test(model)) return { ok: false, status: 400, error: "invalid_model" }
      const existing = tasks.get(taskId)
      const family = resolveWorkerFamily({ family: input.family, agent, model: model ?? existing?.model ?? undefined })
      if (!family) return { ok: false, status: 400, error: "invalid_family" }

      if (existing && existing.repo !== repo) return { ok: false, status: 409, error: `task_repo_mismatch: ${taskId} belongs to ${existing.repo}` }
      const wtKey = (existing?.worktree ?? join(deps.home, "apps", "wt", repo, taskId)).toLowerCase()
      if (inFlightDispatches.has(taskId) || inFlightWorktrees.has(wtKey) || (existing && existing.status === "running")) {
        return { ok: false, status: 409, error: "task_already_running" }
      }

      // Reserve the taskId and worktree synchronously BEFORE any await so concurrent dispatches cannot race setup.
      inFlightDispatches.add(taskId); inFlightWorktrees.add(wtKey)
      try {
        if (existing && !(await reconcileSurvivingProcess(existing))) return { ok: false, status: 409, error: "task_already_running" }
        const repoDir = existing?.repoDir ?? resolveRepo(repo, deps.home)
        if (!repoDir) return { ok: false, status: 404, error: `repo_not_found: ${repo}` }

        const wt = await ensureWorktree(repoDir, repo, taskId, !!existing)
        if (!wt.ok) return { ok: false, status: 500, error: wt.error }
        deps.trust(wt.worktree)

        const now = deps.now()
        const familyChanged = !!existing && existing.family !== family
        const resume = !!existing && existing.sessionStarted && !familyChanged
        const sessionId = (existing && !familyChanged) ? existing.sessionId : deps.uuid()
        const title = (input.title?.trim() || existing?.title || prompt.split("\n")[0] || taskId).slice(0, 200)
        const myTurn = (existing?.turnCount ?? 0) + 1
        const routedModel = family === "claude"
          ? (await decideWorkerModel({
              repo,
              title,
              prompt,
              turnCount: myTurn,
              explicitModel: model ?? null,
              existingModel: existing?.model ?? null,
            })).model
          : null
        const explicitNonAuto = model && model.toLowerCase() !== "auto" ? model : null
        const effectiveModel = explicitNonAuto ?? routedModel ?? existing?.model ?? null
        const repoSlug = repo.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
        const builder = `builder-${deps.host.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}-${repoSlug}-${taskId}`
        // Use `:` separator on turn 2+ (`:` is forbidden in TASK_ID_RE so it can never collide with another taskId).
        const myJobId = myTurn === 1 ? taskId : `${taskId}:t${myTurn}`

        const task: InternalTask = existing ?? {
          taskId, repo, repoDir, title, builder, family, model: effectiveModel, branch: wt.branch, worktree: wt.worktree, sessionId,
          status: "running", turnCount: 0, step: `Starting headless ${family} builder`, pct: 5,
          result: "", prUrl: null, error: null, startedAt: now, updatedAt: now, completedAt: null,
          pid: null, pidIdentity: null, reloadedFromDisk: false, sessionStarted: false,
          activeTurn: myTurn, jobId: myJobId, turnReportedTerminal: false,
          handle: null, exitPromise: null, timeoutTimer: null, killTimer: null, waiters: new Set(), stderrTail: [],
        }

        clearTimers(task)
        task.title = title; task.family = family; task.model = effectiveModel; task.sessionId = sessionId
        if (familyChanged) task.sessionStarted = false
        task.status = "running"; task.turnCount = myTurn; task.activeTurn = myTurn; task.jobId = myJobId
        task.turnReportedTerminal = false; task.step = resume ? `Turn ${myTurn}: resuming ${family} builder` : `Starting headless ${family} builder`
        task.pct = 5; task.error = null; task.completedAt = null; task.updatedAt = now; task.stderrTail = []
        tasks.set(taskId, task); savePersistedTasks(); syncTaskSession(task)

        deps.reportJob({ event: "task", id: myJobId, title: task.title, builder: task.builder, step: task.step, pct: task.pct })

        const invocation = buildHeadlessWorkerInvocation({ family, prompt, sessionId: task.sessionId, resume, mode, agent, model: effectiveModel ?? undefined })
        let settled = false
        let resolveExit!: () => void
        const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve })
        task.exitPromise = exitPromise

        let handle: SpawnedWorkerHandle
        try {
          handle = spawnWorker({
            cmd: invocation.cmd, args: invocation.args, cwd: task.worktree, env: buildWorkerEnv(process.env, taskId, task.builder),
            onStdoutLine(line) {
              if (settled || task.activeTurn !== myTurn) return
              const ev = parseStreamJsonLine(line)
              if (!ev) return
              task.updatedAt = deps.now()
              const prevSid = task.sessionId; const prevStarted = task.sessionStarted
              if (ev.sessionId) { task.sessionId = ev.sessionId; task.sessionStarted = true }
              if (ev.prUrl) task.prUrl = ev.prUrl
              if (ev.assistantText) { task.result = ev.assistantText; task.sessionStarted = true }
              if (ev.resultText) { task.result = ev.resultText; task.sessionStarted = true }
              if (ev.step) {
                task.sessionStarted = true; task.step = ev.step
                task.pct = Math.min(90, Math.max(10, (task.pct ?? 5) + 8))
                deps.reportJob({ event: "progress", id: myJobId, title: task.title, builder: task.builder, step: task.step, pct: task.pct })
              }
              if (ev.done && ev.isError) task.error = (ev.resultText || `${family} turn reported an error`).slice(0, 400)
              if (task.sessionStarted !== prevStarted || task.sessionId !== prevSid) { savePersistedTasks(); syncTaskSession(task) }
            },
            onStderrLine(line) {
              if (settled || task.activeTurn !== myTurn) return
              const clean = redactSecrets(line.trim()).slice(0, 300)
              if (clean) { task.stderrTail.push(clean); if (task.stderrTail.length > 10) task.stderrTail.shift() }
            },
            onExit(code, sig) {
              clearStaleGitConfigLock(task.repoDir)
              if (settled) return
              settled = true; resolveExit()
              if (task.activeTurn !== myTurn) return
              clearTimers(task); task.handle = null; task.exitPromise = null
              if (task.pid !== null && !isPidAlive(task.pid)) { task.pid = null; task.pidIdentity = null; task.reloadedFromDisk = false }
              task.updatedAt = deps.now(); task.completedAt = task.updatedAt
              if (task.status === "interrupted") {
                if (!task.turnReportedTerminal) {
                  task.turnReportedTerminal = true
                  deps.reportJob({ event: "aborted", id: myJobId, title: task.title, builder: task.builder, step: task.step ?? "Interrupted", pct: task.pct })
                }
                savePersistedTasks(); syncTaskSession(task); notifyWaiters(task); return
              }
              if (code === 0 && !sig && !task.error) {
                task.sessionStarted = true; task.status = "completed"; task.pct = 100
                task.step = task.prUrl ? `PR ready: ${task.prUrl}` : "Turn completed"
                if (!task.turnReportedTerminal) {
                  task.turnReportedTerminal = true
                  deps.reportJob({ event: "done", id: myJobId, title: task.title, builder: task.builder, step: task.step, pct: 100 })
                }
              } else {
                task.status = "failed"
                const tail = task.stderrTail.join(" | ")
                task.error = task.error ?? (`${family} exited (code=${code ?? "null"} sig=${sig ?? "none"})${tail ? `: ${tail}` : ""}`).slice(0, 400)
                task.step = `Failed: ${task.error.slice(0, 100)}`
                if (!task.turnReportedTerminal) {
                  task.turnReportedTerminal = true
                  deps.reportJob({ event: "aborted", id: myJobId, title: task.title, builder: task.builder, step: task.step, pct: task.pct })
                }
              }
              savePersistedTasks(); syncTaskSession(task); notifyWaiters(task)
              try { deps.onTaskTerminal?.(toSnapshot(task)) } catch { /* best effort */ }
            },
          })
        } catch (err) {
          settled = true; resolveExit(); clearTimers(task)
          task.handle = null; task.exitPromise = null; task.pid = null; task.pidIdentity = null; task.status = "failed"
          task.error = `spawn failed: ${((err as Error)?.message ?? String(err)).slice(0, 300)}`
          task.step = `Failed: ${task.error.slice(0, 100)}`
          task.updatedAt = deps.now(); task.completedAt = task.updatedAt; task.turnReportedTerminal = true
          deps.reportJob({ event: "aborted", id: myJobId, title: task.title, builder: task.builder, step: task.step, pct: task.pct })
          savePersistedTasks(); syncTaskSession(task); notifyWaiters(task)
          return { ok: false, status: 500, error: task.error }
        }

        if (!settled && task.activeTurn === myTurn) {
          task.handle = handle
          task.pid = handle.pid > 1 ? handle.pid : null
          task.pidIdentity = task.pid ? getPidIdentity(task.pid) : null
          task.reloadedFromDisk = false
          savePersistedTasks(); syncTaskSession(task)
          const timeoutMs = Math.max(1, input.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000
          task.timeoutTimer = setTimeout(() => {
            if (settled || task.activeTurn !== myTurn || task.status !== "running") return
            task.error = `timed out after ${Math.round(timeoutMs / 1000)}s`
            task.handle?.kill("SIGTERM")
            task.killTimer = setTimeout(() => { if (!settled && task.activeTurn === myTurn) task.handle?.kill("SIGKILL") }, 5_000)
            task.killTimer.unref?.()
          }, timeoutMs)
          task.timeoutTimer.unref?.()
        }

        return { ok: true, task: toSnapshot(task) }
      } finally {
        inFlightDispatches.delete(taskId); inFlightWorktrees.delete(wtKey)
      }
    },

    async awaitTask(taskId: string, waitMs = DEFAULT_WAIT_MS): Promise<{ ok: true; task: SupervisedTaskSnapshot; timedOut: boolean } | { ok: false; status: number; error: string }> {
      const t = tasks.get(taskId.trim())
      if (!t) return { ok: false, status: 404, error: "task_not_found" }
      const boundedWait = Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(waitMs)))
      if (t.status !== "running" || boundedWait === 0) return { ok: true, task: toSnapshot(t), timedOut: false }
      const timedOut = await new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const onDone = () => { if (timer) clearTimeout(timer); t.waiters.delete(onDone); resolve(false) }
        t.waiters.add(onDone)
        timer = setTimeout(() => { t.waiters.delete(onDone); resolve(true) }, boundedWait)
        timer.unref?.()
      })
      return { ok: true, task: toSnapshot(t), timedOut: timedOut && t.status === "running" }
    },

    async interruptTask(taskId: string, opts: { closeWorktree?: boolean } = {}): Promise<{ ok: true; task: SupervisedTaskSnapshot; worktreeRemoved: boolean; note?: string } | { ok: false; status: number; error: string }> {
      const id = taskId.trim()
      const t = tasks.get(id)
      if (!t) return { ok: false, status: 404, error: "task_not_found" }
      const wtKey = t.worktree.toLowerCase()
      if (inFlightDispatches.has(id) || inFlightWorktrees.has(wtKey)) return { ok: false, status: 409, error: "task_dispatch_in_progress" }
      inFlightDispatches.add(id); inFlightWorktrees.add(wtKey)
      try {
        if (t.status === "running" || t.handle !== null || t.exitPromise !== null) {
          t.status = "interrupted"; t.error = "interrupted by caller"; t.step = "Interrupted"
          t.updatedAt = deps.now(); t.completedAt = t.updatedAt
          const h = t.handle
          clearTimers(t)
          if (!t.turnReportedTerminal) {
            t.turnReportedTerminal = true
            deps.reportJob({ event: "aborted", id: t.jobId, title: t.title, builder: t.builder, step: "Interrupted", pct: t.pct })
          }
          savePersistedTasks(); syncTaskSession(t); notifyWaiters(t)
          if (h) {
            h.kill("SIGTERM")
            const killTimer = setTimeout(() => h.kill("SIGKILL"), killGraceMs)
            killTimer.unref?.()
          }
        }

        const exited = await reconcileSurvivingProcess(t)
        if (!exited) return { ok: true, task: toSnapshot(t), worktreeRemoved: false, note: "worktree kept: worker process has not exited yet" }

        let worktreeRemoved = false
        let note: string | undefined
        if (opts.closeWorktree && existsSync(t.worktree)) {
          clearStaleGitConfigLock(t.repoDir)
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
      } finally {
        inFlightDispatches.delete(id); inFlightWorktrees.delete(wtKey)
      }
    },

    setTaskModel(taskId: string, model: string): SupervisedTaskSnapshot | null {
      const t = tasks.get(taskId.trim())
      if (!t) return null
      const nextFamily = resolveWorkerFamily({ model })
      t.model = model
      if (nextFamily && nextFamily !== t.family) {
        t.family = nextFamily
        t.sessionStarted = false
        t.sessionId = deps.uuid()
      }
      t.updatedAt = deps.now()
      savePersistedTasks(); syncTaskSession(t)
      return toSnapshot(t)
    },

    listTasks(): SupervisedTaskSnapshot[] { return [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(toSnapshot) },
    getTask(taskId: string): SupervisedTaskSnapshot | null { const t = tasks.get(taskId.trim()); return t ? toSnapshot(t) : null },
  }
}

export type WorkerSupervisor = ReturnType<typeof createWorkerSupervisor>
