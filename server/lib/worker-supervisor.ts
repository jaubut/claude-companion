import { existsSync } from "node:fs"
import { join } from "node:path"
import type { BuilderReport } from "./builder-jobs"
import { clearStaleGitConfigLock } from "./git-config-lock"
import { decideWorkerModel } from "./jev-model-router"
import type { ShFn } from "./live-repo"
import { redactSecrets } from "./secret-redact"
import {
  ALLOWED_FAMILIES, ALLOWED_MODES, DEFAULT_REAP_GRACE_MS, REPO_NAME_RE, SAFE_IDENTIFIER_RE, TASK_ID_RE, WORKER_FOOTER, WORKER_SHIP_RULE, WORKER_TURN_RULE,
  type SpawnWorkerOpts, type SpawnedWorkerHandle, type StreamJsonEvent, type WorkerFamily, type WorkerTaskStatus,
  buildHeadlessClaudeArgs, buildHeadlessCodexArgs, buildHeadlessGeminiArgs,
  buildHeadlessWorkerInvocation, buildWorkerEnv, defaultLoadAgentSecrets, defaultSpawnWorker, modelFitsFamily, parseStreamJsonLine, resolveWorkerFamily,
} from "./worker-invocation"
import { defaultGetParentPid, defaultGetPidIdentity, defaultIsPidAlive, defaultKillPid } from "./worker-pid"
import { createReceiptOutbox } from "./worker-receipt-outbox"
import { type PersistedTaskRecord, type WorkerReceipt, type WorkerTurn, loadTaskRecords, saveTaskRecords, workerReceiptFile, workerStateFile } from "./worker-task-store"
import { closeTurn, dispatchTurns, openTurn, refreshResult, restoreTurns } from "./worker-turns"
import { cloneRepo, closeTaskWorktree, defaultResolveRepoDir, ensureWorktree, finishedPrHead, worktreeDirtyPaths } from "./worker-worktree"

export {
  ALLOWED_FAMILIES, ALLOWED_MODES, REPO_NAME_RE, SAFE_IDENTIFIER_RE, TASK_ID_RE, WORKER_SHIP_RULE, WORKER_TURN_RULE,
  type SpawnWorkerOpts, type SpawnedWorkerHandle, defaultSpawnWorker, type StreamJsonEvent, type WorkerFamily, type WorkerTaskStatus,
  buildHeadlessClaudeArgs, buildHeadlessCodexArgs, buildHeadlessGeminiArgs,
  buildHeadlessWorkerInvocation, buildWorkerEnv, parseStreamJsonLine, resolveWorkerFamily,
}

const PROMPT_MAX = 100_000, DEFAULT_TIMEOUT_S = 3600, MAX_WAIT_MS = 120_000, DEFAULT_WAIT_MS = 30_000

export interface DispatchTaskInput {
  taskId: string; repo: string; prompt: string; title?: string; family?: string; agent?: string; model?: string; mode?: string; timeoutS?: number
  /** The handoff claim from `bin/worker dispatch --claim` (lib/handoff-claim.ts). Stays inside the supervisor. */
  claim?: string
  /** Server-only (routes/api.ts, Jeremie's authenticated phone inject): resume with the stored claim. Never from a tool call. */
  inheritClaim?: boolean
}

/** What the dispatch made of the task's claim: bound (verified), refused with its reason, lookup failed (pending), or none (absent). */
export type ClaimStatus = "verified" | `claim_refused:${string}` | "pending" | "absent"

export interface SupervisedTaskSnapshot {
  taskId: string; repo: string; title: string; builder: string; family: WorkerFamily; model: string | null; branch: string; worktree: string; sessionId: string
  status: WorkerTaskStatus; turnCount: number; step: string | null; pct: number | null; result: string; prUrl: string | null
  error: string | null; startedAt: number; updatedAt: number; completedAt: number | null
}

export interface WorkerSupervisorDeps {
  host: string; home: string; now(): number; uuid(): string; sh: ShFn; trust(dir: string): void; reportJob(report: BuilderReport): void
  stateFile?: string; receiptFile?: string; killGraceMs?: number; reapGraceMs?: number; resolveRepoDir?(repo: string, home: string): string | null; spawnWorker?(opts: SpawnWorkerOpts): SpawnedWorkerHandle
  isPidAlive?(pid: number): boolean; killPid?(pid: number, sig: NodeJS.Signals): void; getPidIdentity?(pid: number): string | null
  /** This supervisor's process (default process.pid) and a pid's parent: a worker still parented to another live Companion is its, never reaped here. */
  selfPid?: number; getParentPid?(pid: number): number | null
  /** `linkBound`: the task holds a verified handoff claim, so it may write its notes DB row (wiring's status sync). */
  syncSession?(task: SupervisedTaskSnapshot, pid: number | null, linkBound: boolean): void
  /** Any state change, plus every new step or summary while running (the brain thread's live card). */
  onTaskProgress?(task: SupervisedTaskSnapshot): void
  onTaskTerminal?(task: SupervisedTaskSnapshot, linkBound: boolean): void
  /** A finished turn's receipt entered the outbox (pendingReceipts / ackReceipts). */
  onReceipt?(): void
  /** Does this claim let the worker task link its PR to the notes DB row of its id? Persisted; null (lookup failed) = ask next turn. */
  bindTask?(taskId: string, repo: string, claim: string): Promise<true | string | null>
  /** A bound task's turn reported a PR: link it (the claim checked again) before the turn reads completed. Bounded, never rejects. */
  linkPr?(task: SupervisedTaskSnapshot, claim: string): Promise<string>
  /** Live active design state summary appended automatically to headless worker prompts. */
  designContext?(): string
  /** Agent secrets for a Claude worker's env (default: `~/.local/bin/tls-agent-env`). Never rejects; {} on failure. */
  loadAgentSecrets?(): Promise<Record<string, string>>
}

export { workerStateFile }

interface InternalTask extends PersistedTaskRecord {
  pid: number | null; pidIdentity: string | null; reloadedFromDisk: boolean; sessionStarted: boolean; prLinkBound: boolean | null; handoffClaim: string | null; modelPinned: boolean
  activeTurn: number; jobId: string; turnReportedTerminal: boolean; turns: WorkerTurn[]; turnsRead: number; dispatchTurn: number
  handle: SpawnedWorkerHandle | null; exitPromise: Promise<void> | null
  timeoutTimer: ReturnType<typeof setTimeout> | null; killTimer: ReturnType<typeof setTimeout> | null
  /** Armed on each `result` event: the process must exit after its turn (reapGraceMs). `lingered`: it didn't, and was stopped. */
  reapTimer: ReturnType<typeof setTimeout> | null; lingered: boolean
  waiters: Set<() => void>; stderrTail: string[]
}
function toSnapshot(t: InternalTask): SupervisedTaskSnapshot {
  const { taskId, repo, title, builder, family, model, branch, worktree, sessionId, status, turnCount, step, pct, result, prUrl, error, startedAt, updatedAt, completedAt } = t
  return { taskId, repo, title, builder, family, model, branch, worktree, sessionId, status, turnCount, step, pct, result, prUrl, error, startedAt, updatedAt, completedAt }
}
function waitMsPromise(ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => { const tm = setTimeout(() => resolve(false), ms); tm.unref?.() })
}
export function createWorkerSupervisor(deps: WorkerSupervisorDeps) {
  const tasks = new Map<string, InternalTask>()
  const inFlightDispatches = new Set<string>()
  const inFlightWorktrees = new Set<string>()
  const resolveRepo = deps.resolveRepoDir ?? defaultResolveRepoDir
  const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker
  const loadAgentSecrets = deps.loadAgentSecrets ?? (() => defaultLoadAgentSecrets(deps.home))
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive
  const killPid = deps.killPid ?? defaultKillPid
  const getPidIdentity = deps.getPidIdentity ?? ((pid: number) => defaultGetPidIdentity(pid) ?? (deps.isPidAlive ? `mock:${pid}` : null))
  const getParentPid = deps.getParentPid ?? (deps.isPidAlive ? () => null : defaultGetParentPid)
  const selfPid = deps.selfPid ?? process.pid
  const stateFile = deps.stateFile ?? workerStateFile(deps.home)
  // Records of workers another live Companion (prod, while a test or dev instance loads the same file) still runs: kept as-is.
  const foreignRecords: PersistedTaskRecord[] = []
  const killGraceMs = Math.max(50, deps.killGraceMs ?? 3_000)
  const reapGraceMs = Math.max(1, deps.reapGraceMs ?? DEFAULT_REAP_GRACE_MS)
  const outbox = createReceiptOutbox(deps.receiptFile ?? workerReceiptFile(deps.home), deps.now, deps.onReceipt)

  function syncTaskSession(t: InternalTask): void {
    try { deps.syncSession?.(toSnapshot(t), t.handle?.pid ?? t.pid ?? null, t.prLinkBound === true && !!t.handoffClaim) } catch { /* best effort */ }
    try { deps.onTaskProgress?.(toSnapshot(t)) } catch { /* best effort */ }
  }

  function savePersistedTasks(): void {
    saveTaskRecords(stateFile, [...tasks.values()].map((t): PersistedTaskRecord => ({
      ...toSnapshot(t), repoDir: t.repoDir, pid: t.handle?.pid ?? t.pid ?? null, pidIdentity: t.pidIdentity, sessionStarted: t.sessionStarted, prLinkBound: t.prLinkBound, handoffClaim: t.handoffClaim, modelPinned: t.modelPinned, ownerPid: selfPid,
      turns: t.turns, turnsRead: t.turnsRead, dispatchTurn: t.dispatchTurn,
    })).concat(foreignRecords.filter((r) => !tasks.has(r.taskId))))
  }

  function enqueueReceipt(t: InternalTask, note: string | null = null): void { outbox.enqueue(toSnapshot(t), dispatchTurns(t), note) }

  function loadPersistedTasks(): void {
    const now = deps.now()
    let dirty = false
    for (const r of loadTaskRecords(stateFile)) {
      const wasRunning = r.status === "running"
      const turnCount = typeof r.turnCount === "number" && r.turnCount > 0 ? Math.floor(r.turnCount) : 1
      const rawPid = typeof r.pid === "number" && Number.isInteger(r.pid) && r.pid > 1 ? r.pid : null
      const savedIdentity = typeof r.pidIdentity === "string" && r.pidIdentity ? r.pidIdentity : null
      let survivingPid: number | null = null
      let survivingIdentity: string | null = null
      if (rawPid !== null && isPidAlive(rawPid)) {
        const currentIdentity = getPidIdentity(rawPid)
        const ownerPid = typeof r.ownerPid === "number" ? r.ownerPid : null
        if (ownerPid !== null && ownerPid !== selfPid && getParentPid(rawPid) === ownerPid) { foreignRecords.push(r as PersistedTaskRecord); continue }
        if (savedIdentity && currentIdentity !== null && currentIdentity === savedIdentity) {
          killPid(rawPid, "SIGTERM")
          if (isPidAlive(rawPid)) { survivingPid = rawPid; survivingIdentity = savedIdentity }
        } else if (currentIdentity === null || !savedIdentity) { survivingPid = rawPid; survivingIdentity = savedIdentity } // unknown identity != exited: group stays reserved
        dirty = true
      } else if (rawPid !== null) dirty = true
      if (wasRunning) dirty = true
      const loadedFamily = resolveWorkerFamily({ family: r.family, model: r.model ?? undefined }) ?? "claude"
      // The restart killed the process, but a turn that already ended completed (its `result` event came) delivered its report.
      const { turns, reported } = restoreTurns(r, wasRunning, now)
      const taskRecord: InternalTask = {
        taskId: r.taskId, repo: r.repo, repoDir: r.repoDir,
        title: typeof r.title === "string" ? r.title : r.taskId,
        builder: typeof r.builder === "string" ? r.builder : `builder-${r.repo}-${r.taskId}`,
        family: loadedFamily,
        model: typeof r.model === "string" && r.model ? r.model : null,
        branch: typeof r.branch === "string" ? r.branch : `dispatch/${r.taskId}`,
        worktree: r.worktree, sessionId: r.sessionId,
        status: reported ? "completed" : wasRunning ? "interrupted" : (r.status ?? "interrupted"),
        turnCount,
        step: reported ? "Turn completed (server restarted before the worker exited)" : wasRunning ? "Interrupted (server restarted)" : (typeof r.step === "string" ? r.step : null),
        pct: reported ? 100 : typeof r.pct === "number" ? r.pct : null,
        result: "",
        prUrl: typeof r.prUrl === "string" ? r.prUrl : null,
        error: reported ? null : wasRunning ? "server restarted while task was running" : (typeof r.error === "string" ? r.error : null),
        startedAt: typeof r.startedAt === "number" ? r.startedAt : now,
        updatedAt: wasRunning ? now : (typeof r.updatedAt === "number" ? r.updatedAt : now),
        completedAt: wasRunning ? now : (typeof r.completedAt === "number" ? r.completedAt : null),
        pid: survivingPid, pidIdentity: survivingIdentity, reloadedFromDisk: survivingPid !== null,
        sessionStarted: typeof r.sessionStarted === "boolean" ? r.sessionStarted : r.status === "completed",
        prLinkBound: typeof r.prLinkBound === "boolean" ? r.prLinkBound : null,
        handoffClaim: typeof r.handoffClaim === "string" && r.handoffClaim ? r.handoffClaim : null,
        modelPinned: r.modelPinned === true,
        activeTurn: turnCount, jobId: turnCount <= 1 ? r.taskId : `${r.taskId}:t${turnCount}`,
        turnReportedTerminal: true, handle: null, exitPromise: null, timeoutTimer: null, killTimer: null, reapTimer: null, lingered: false, waiters: new Set(), stderrTail: [],
        turns, turnsRead: typeof r.turnsRead === "number" ? r.turnsRead : turns.at(-1)?.turn ?? 0,
        dispatchTurn: typeof r.dispatchTurn === "number" ? r.dispatchTurn : 0,
      }
      refreshResult(taskRecord)
      tasks.set(r.taskId, taskRecord)
      syncTaskSession(taskRecord)
      if (wasRunning) enqueueReceipt(taskRecord)
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
    if (t.reapTimer) { clearTimeout(t.reapTimer); t.reapTimer = null }
  }

  /** Runs fn on a finished task under the dispatch reservation, so a follow-up dispatch never races a worktree removal. */
  async function withReservation<T>(t: InternalTask, fn: () => Promise<T>): Promise<T | null> {
    const wtKey = t.worktree.toLowerCase()
    if (t.status === "running" || inFlightDispatches.has(t.taskId) || inFlightWorktrees.has(wtKey)) return null
    inFlightDispatches.add(t.taskId); inFlightWorktrees.add(wtKey)
    try { return await fn() } finally { inFlightDispatches.delete(t.taskId); inFlightWorktrees.delete(wtKey) }
  }

  for (const dir of new Set([...tasks.values()].map((t) => t.repoDir))) clearStaleGitConfigLock(dir)

  return {
    async dispatchTask(input: DispatchTaskInput): Promise<{ ok: true; task: SupervisedTaskSnapshot; claim: ClaimStatus } | { ok: false; status: number; error: string }> {
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
      // A follow-up turn keeps the task's recorded family unless the caller names a family, agent or model.
      const family = existing && !input.family?.trim() && !agent && !model
        ? existing.family
        : resolveWorkerFamily({ family: input.family, agent, model })
      if (!family) return { ok: false, status: 400, error: "invalid_family" }

      if (existing && existing.repo !== repo) return { ok: false, status: 409, error: `task_repo_mismatch: ${taskId} belongs to ${existing.repo}` }
      // A bound task's worktree, session and dispatch/<id> branch feed a PR already linked as Jeremie's: only its own
      // claim resumes it. Refused before any side effect, so the record and its binding stay as they are.
      const supplied = input.inheritClaim ? existing?.handoffClaim ?? undefined : input.claim
      if (existing?.prLinkBound === true && existing.handoffClaim && supplied !== existing.handoffClaim) return { ok: false, status: 409, error: "claim_required" }
      const wtKey = (existing?.worktree ?? join(deps.home, "apps", "wt", repo, taskId)).toLowerCase()
      if (inFlightDispatches.has(taskId) || inFlightWorktrees.has(wtKey) || (existing && existing.status === "running")) {
        return { ok: false, status: 409, error: "task_already_running" }
      }

      // Reserve the taskId and worktree synchronously BEFORE any await so concurrent dispatches cannot race setup.
      inFlightDispatches.add(taskId); inFlightWorktrees.add(wtKey)
      try {
        if (existing && !(await reconcileSurvivingProcess(existing))) return { ok: false, status: 409, error: "task_already_running" }
        const repoDir = existing?.repoDir ?? resolveRepo(repo, deps.home) ?? await cloneRepo(deps.sh, deps.home, repo)
        if (!repoDir) return { ok: false, status: 404, error: `repo_not_found: ${repo}` }

        const wt = await ensureWorktree(deps.sh, deps.home, tasks.values(), repoDir, repo, taskId, !!existing)
        if (!wt.ok) return { ok: false, status: 500, error: wt.error }
        deps.trust(wt.worktree)
        const familyChanged = !!existing && existing.family !== family
        // Every dispatch must present its claim: the stored one is never inherited, since anyone with the task id
        // (list_tasks shows it) can dispatch. The exact claim a bound task holds keeps it bound without asking the row
        // again (its first PR may already have taken it); any other claim is checked itself, and a refusal never falls back.
        const claim = supplied || null
        const bind = !claim ? "absent" : existing?.prLinkBound === true && existing.handoffClaim === claim ? true
          : deps.bindTask ? await deps.bindTask(taskId, repo, claim).catch(() => null) : "no_binding"
        const prLinkBound = bind === true ? true : bind === null ? null : false
        const handoffClaim = prLinkBound === false ? null : claim
        const claimStatus: ClaimStatus = !claim ? "absent" : bind === true ? "verified" : bind === null ? "pending" : `claim_refused:${bind}`

        const now = deps.now()
        const resume = !!existing && existing.sessionStarted && !familyChanged
        const sessionId = (existing && !familyChanged) ? existing.sessionId : deps.uuid()
        const title = (input.title?.trim() || existing?.title || prompt.split("\n")[0] || taskId).slice(0, 200)
        const myTurn = (existing?.turnCount ?? 0) + 1
        // Only a model of this family reaches the CLI; when the family changes on resume, drop the previous family's stored model.
        const usable = (m: string | null | undefined) => m && m.toLowerCase() !== "auto" && modelFitsFamily(m, family) ? m : null
        const storedModel = existing && !familyChanged ? usable(existing.model) : null
        // A chosen model (this dispatch's, or one pinned earlier by a dispatch or the picker) beats the router, retry escalation included.
        const explicitModel = usable(model) ?? (existing?.modelPinned ? storedModel : null)
        const routedModel = family === "claude"
          ? (await decideWorkerModel({
              repo,
              title,
              prompt,
              turnCount: myTurn,
              explicitModel,
              existingModel: storedModel,
            })).model
          : null
        // Codex / gemini run outside the Claude sandbox and load their own; only a Claude worker needs them passed in.
        const secrets = family === "claude" ? await loadAgentSecrets() : {}
        const effectiveModel = explicitModel ?? routedModel ?? storedModel ?? null
        const repoSlug = repo.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
        const builder = `builder-${deps.host.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}-${repoSlug}-${taskId}`
        // Use `:` separator on turn 2+ (`:` is forbidden in TASK_ID_RE so it can never collide with another taskId).
        const myJobId = myTurn === 1 ? taskId : `${taskId}:t${myTurn}`

        const task: InternalTask = existing ?? {
          taskId, repo, repoDir, title, builder, family, model: effectiveModel, branch: wt.branch, worktree: wt.worktree, sessionId,
          status: "running", turnCount: 0, step: `Starting headless ${family} builder`, pct: 5,
          result: "", prUrl: null, error: null, startedAt: now, updatedAt: now, completedAt: null,
          pid: null, pidIdentity: null, reloadedFromDisk: false, sessionStarted: false, prLinkBound, handoffClaim, modelPinned: false,
          activeTurn: myTurn, jobId: myJobId, turnReportedTerminal: false, turns: [], turnsRead: 0, dispatchTurn: 0,
          handle: null, exitPromise: null, timeoutTimer: null, killTimer: null, reapTimer: null, lingered: false, waiters: new Set(), stderrTail: [],
        }

        clearTimers(task)
        task.prLinkBound = prLinkBound; task.handoffClaim = handoffClaim
        task.title = title; task.family = family; task.model = effectiveModel; task.modelPinned = !!explicitModel; task.sessionId = sessionId
        if (familyChanged) task.sessionStarted = false
        task.status = "running"; task.turnCount = myTurn; task.activeTurn = myTurn; task.jobId = myJobId
        task.turnReportedTerminal = false; task.step = resume ? `Turn ${myTurn}: resuming ${family} builder` : `Starting headless ${family} builder`
        task.pct = 5; task.error = null; task.completedAt = null; task.updatedAt = now; task.stderrTail = []; task.lingered = false
        closeTurn(task, "interrupted", now); task.dispatchTurn = openTurn(task, now).turn; refreshResult(task)
        tasks.set(taskId, task); savePersistedTasks(); syncTaskSession(task)

        deps.reportJob({ event: "task", id: myJobId, title: task.title, builder: task.builder, step: task.step, pct: task.pct })

        const dCtx = deps.designContext?.().trim() ?? ""
        const effectivePrompt = prompt.startsWith("/") ? prompt : `${(dCtx ? `${prompt}\n\n${dCtx}` : prompt).slice(0, PROMPT_MAX - WORKER_FOOTER.length - 2)}\n\n${WORKER_FOOTER}`
        const invocation = buildHeadlessWorkerInvocation({ family, prompt: effectivePrompt, sessionId: task.sessionId, resume, mode, agent, model: effectiveModel ?? undefined })
        let settled = false
        let resolveExit!: () => void
        const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve })
        task.exitPromise = exitPromise

        let handle: SpawnedWorkerHandle
        try {
          handle = spawnWorker({
            cmd: invocation.cmd, args: invocation.args, cwd: task.worktree, env: buildWorkerEnv(process.env, taskId, task.builder, secrets),
            onStdoutLine(line) {
              if (settled || task.activeTurn !== myTurn) return
              const ev = parseStreamJsonLine(line)
              if (!ev) return
              task.updatedAt = deps.now()
              const prevSid = task.sessionId; const prevStarted = task.sessionStarted; const prevPrUrl = task.prUrl; const prevResult = task.result
              if (ev.sessionId) { task.sessionId = ev.sessionId; task.sessionStarted = true }
              if (ev.prUrl) task.prUrl = ev.prUrl
              // Each turn keeps its own text: a later turn (a background-task notification) never overwrites an earlier report.
              if (ev.assistantText || ev.resultText || ev.step) {
                // Output after a `result`: the worker is working again, so it isn't idle yet.
                if (task.reapTimer) { clearTimeout(task.reapTimer); task.reapTimer = null }
                const cur = openTurn(task, task.updatedAt)
                if (ev.assistantText) { cur.result = ev.assistantText; task.sessionStarted = true }
                if (ev.resultText) { cur.result = ev.resultText; task.sessionStarted = true }
                if (ev.prUrl) cur.prUrl = ev.prUrl
              }
              const turnEnded = !!ev.done && closeTurn(task, ev.isError ? "failed" : "completed", task.updatedAt)
              refreshResult(task)
              // The turn is over: a process still alive after the grace is idle on background work (ee0a87d5, 256a637a). Stop it.
              if (turnEnded && !task.reapTimer) {
                task.reapTimer = setTimeout(() => {
                  task.reapTimer = null
                  if (settled || task.activeTurn !== myTurn || task.status !== "running" || task.turns.at(-1)?.endedAt === null) return
                  task.lingered = true
                  task.handle?.kill("SIGTERM")
                  task.killTimer = setTimeout(() => { if (!settled && task.activeTurn === myTurn) task.handle?.kill("SIGKILL") }, killGraceMs)
                  task.killTimer.unref?.()
                }, reapGraceMs)
                task.reapTimer.unref?.()
              }
              if (ev.step) {
                task.sessionStarted = true; task.step = ev.step
                task.pct = Math.min(90, Math.max(10, (task.pct ?? 5) + 8))
                deps.reportJob({ event: "progress", id: myJobId, title: task.title, builder: task.builder, step: task.step, pct: task.pct })
                syncTaskSession(task)
              }
              // A reason the supervisor already set (the turn timeout) beats agy's generic "interrupted", which it prints on any SIGTERM.
              if (ev.done && ev.isError) task.error ??= (family === "gemini" && ev.resultText === "interrupted"
                ? "agy got a stop signal the supervisor did not send (Companion restart, another Companion or test instance, or a manual kill)"
                : ev.resultText || `${family} turn reported an error`).slice(0, 400)
              if (turnEnded || task.sessionStarted !== prevStarted || task.sessionId !== prevSid || task.prUrl !== prevPrUrl) { savePersistedTasks(); syncTaskSession(task) }
              else if (task.result !== prevResult && !ev.step) { try { deps.onTaskProgress?.(toSnapshot(task)) } catch { /* best effort */ } }
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
              // Stopped by the reaper after its turn ended: that turn's report stands, the signal is ours.
              const exitedOk = (task.lingered || (code === 0 && !sig)) && !task.error
              closeTurn(task, task.status === "interrupted" ? "interrupted" : exitedOk ? "completed" : "failed", task.updatedAt)
              refreshResult(task)
              if (task.status === "interrupted") {
                if (!task.turnReportedTerminal) {
                  task.turnReportedTerminal = true
                  deps.reportJob({ event: "aborted", id: myJobId, title: task.title, builder: task.builder, step: task.step ?? "Interrupted", pct: task.pct })
                }
                savePersistedTasks(); syncTaskSession(task); notifyWaiters(task); return
              }
              const finish = () => {
                savePersistedTasks(); syncTaskSession(task); notifyWaiters(task)
                try { deps.onTaskTerminal?.(toSnapshot(task), task.prLinkBound === true && !!task.handoffClaim) } catch { /* best effort */ }
                const lingerNote = task.lingered ? `Ended its turn with background work still running: stopped ${Math.round(reapGraceMs / 1000)} s later, so nothing it says is still running will finish. Re-dispatch to finish it.` : null
                if (task.status !== "completed" || task.prUrl) { enqueueReceipt(task, lingerNote); return }
                // Completed with no PR: a clean worktree closes; a dirty one is kept and the receipt says so (a88c7bd9).
                const snap = toSnapshot(task); const turns = dispatchTurns(task)
                void worktreeDirtyPaths(deps.sh, task.worktree).catch(() => null).then(async (dirty) => {
                  const keptNote = dirty?.length ? `No PR, and ${dirty.length} uncommitted change(s) left in ${task.worktree}: worktree kept. Resume the task to commit and open the PR.` : null
                  outbox.enqueue(snap, turns, [lingerNote, keptNote].filter(Boolean).join("\n") || null)
                  // Only the removal holds the reservation: a follow-up dispatched meanwhile keeps the worktree.
                  if (dirty && !dirty.length) await withReservation(task, () => closeTaskWorktree(deps.sh, task))
                }).catch(() => outbox.enqueue(snap, turns, lingerNote))
              }
              const complete = (link: string | null) => {
                const note = link === "timeout" ? " (PR link still pending)" : link && link !== "linked" && link !== "not_linked" ? ` (not linked: ${link})` : ""
                task.sessionStarted = true; task.status = "completed"; task.pct = 100
                task.step = task.prUrl ? `PR ready: ${task.prUrl}${note}` : "Turn completed"
                if (!task.turnReportedTerminal) {
                  task.turnReportedTerminal = true
                  deps.reportJob({ event: "done", id: myJobId, title: task.title, builder: task.builder, step: task.step, pct: 100 })
                }
                finish()
              }
              if (exitedOk) {
                // The link lands before the turn reads completed (await_task, the brain): the shepherd reads origin through it.
                if (task.prUrl && task.prLinkBound === true && task.handoffClaim && deps.linkPr) {
                  task.step = `Linking PR: ${task.prUrl}`
                  savePersistedTasks()
                  void deps.linkPr(toSnapshot(task), task.handoffClaim).catch(() => "link_failed").then((link) => {
                    if (task.activeTurn === myTurn && task.status === "running") complete(link)
                  })
                  return
                }
                complete(null)
                return
              }
              task.status = "failed"
              const tail = task.stderrTail.join(" | ")
              task.error = task.error ?? (`${family} exited (code=${code ?? "null"} sig=${sig ?? "none"})${tail ? `: ${tail}` : ""}`).slice(0, 400)
              task.step = `Failed: ${task.error.slice(0, 100)}`
              if (!task.turnReportedTerminal) {
                task.turnReportedTerminal = true
                deps.reportJob({ event: "aborted", id: myJobId, title: task.title, builder: task.builder, step: task.step, pct: task.pct })
              }
              finish()
            },
          })
        } catch (err) {
          settled = true; resolveExit(); clearTimers(task)
          task.handle = null; task.exitPromise = null; task.pid = null; task.pidIdentity = null; task.status = "failed"
          task.error = `spawn failed: ${((err as Error)?.message ?? String(err)).slice(0, 300)}`
          task.step = `Failed: ${task.error.slice(0, 100)}`
          task.updatedAt = deps.now(); task.completedAt = task.updatedAt; task.turnReportedTerminal = true
          closeTurn(task, "failed", task.updatedAt)
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
            const last = task.stderrTail.at(-1)
            task.error = `timed out after ${Math.round(timeoutMs / 1000)}s${last ? `: ${last}` : ""}`.slice(0, 400)
            task.handle?.kill("SIGTERM")
            task.killTimer = setTimeout(() => { if (!settled && task.activeTurn === myTurn) task.handle?.kill("SIGKILL") }, 5_000)
            task.killTimer.unref?.()
          }, timeoutMs)
          task.timeoutTimer.unref?.()
        }

        return { ok: true, task: toSnapshot(task), claim: claimStatus }
      } finally {
        inFlightDispatches.delete(taskId); inFlightWorktrees.delete(wtKey)
      }
    },

    /** `turns`: every turn ended since the last await returned, full text (the brain reads them all, not only `result`). */
    async awaitTask(taskId: string, waitMs = DEFAULT_WAIT_MS): Promise<{ ok: true; task: SupervisedTaskSnapshot; timedOut: boolean; turns: WorkerTurn[] } | { ok: false; status: number; error: string }> {
      const t = tasks.get(taskId.trim())
      if (!t) return { ok: false, status: 404, error: "task_not_found" }
      const unread = (): WorkerTurn[] => {
        const out = t.turns.filter((x) => x.endedAt !== null && x.turn > t.turnsRead)
        if (out.length) { t.turnsRead = out.at(-1)!.turn; savePersistedTasks() }
        return out
      }
      const boundedWait = Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(waitMs)))
      if (t.status !== "running" || boundedWait === 0) return { ok: true, task: toSnapshot(t), timedOut: false, turns: unread() }
      const timedOut = await new Promise<boolean>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const onDone = () => { if (timer) clearTimeout(timer); t.waiters.delete(onDone); resolve(false) }
        t.waiters.add(onDone)
        timer = setTimeout(() => { t.waiters.delete(onDone); resolve(true) }, boundedWait)
        timer.unref?.()
      })
      return { ok: true, task: toSnapshot(t), timedOut: timedOut && t.status === "running", turns: unread() }
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
          closeTurn(t, "interrupted", t.updatedAt); refreshResult(t)
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

        const { removed: worktreeRemoved, note } = opts.closeWorktree ? await closeTaskWorktree(deps.sh, t) : { removed: false, note: undefined }
        return { ok: true, task: toSnapshot(t), worktreeRemoved, ...(note ? { note } : {}) }
      } finally {
        inFlightDispatches.delete(id); inFlightWorktrees.delete(wtKey)
      }
    },

    setTaskModel(taskId: string, model: string): SupervisedTaskSnapshot | null {
      const t = tasks.get(taskId.trim())
      if (!t) return null
      const nextFamily = resolveWorkerFamily({ model })
      t.model = model; t.modelPinned = true
      if (nextFamily && nextFamily !== t.family) {
        t.family = nextFamily
        t.sessionStarted = false
        t.sessionId = deps.uuid()
      }
      t.updatedAt = deps.now()
      savePersistedTasks(); syncTaskSession(t)
      return toSnapshot(t)
    },

    /** The task and its whole turn history (`bin/worker get`); doesn't move await's read mark. */
    getTaskTurns(taskId: string): { task: SupervisedTaskSnapshot; turns: WorkerTurn[] } | null {
      const t = tasks.get(taskId.trim())
      return t ? { task: toSnapshot(t), turns: t.turns.map((x) => ({ ...x })) } : null
    },

    /** Closes the worktree of every finished task whose PR is merged or closed, or that completed with no PR; never a dirty one. */
    async sweepWorktrees(): Promise<string[]> {
      const closed: string[] = []
      for (const t of [...tasks.values()]) {
        if (t.status === "running" || !existsSync(t.worktree) || (!t.prUrl && t.status !== "completed")) continue
        const out = await withReservation(t, async () => {
          const pr = t.prUrl ? await finishedPrHead(deps.sh, t.prUrl, t.repoDir) : null
          if (t.prUrl && !pr) return false
          return (await closeTaskWorktree(deps.sh, t, pr?.head ?? null)).removed
        }).catch(() => false)
        if (out) closed.push(t.taskId)
      }
      return closed
    },

    pendingReceipts(): WorkerReceipt[] { return outbox.pending() },
    /** The brain host delivered these: drop them from the outbox. */
    ackReceipts(ids: string[]): number { return outbox.ack(ids) },

    listTasks(): SupervisedTaskSnapshot[] { return [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(toSnapshot) },
    getTask(taskId: string): SupervisedTaskSnapshot | null { const t = tasks.get(taskId.trim()); return t ? toSnapshot(t) : null },
  }
}

export type WorkerSupervisor = ReturnType<typeof createWorkerSupervisor>
