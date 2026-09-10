import type { Task } from "./orchestrator-chat"

// Worker → task correlation (PRJ-OR1T Phase 8).
//
// Which task does this hook event belong to? Until now the answer was "whatever
// task shares its cwd", which is fine for one worker per directory and wrong the
// moment there are two: worker A's turn-end closes worker B's task, and B's
// reply lands in the thread under A's id.
//
// Identity is issued at dispatch (COMPANION_TASK_ID in the worker's env →
// X-Companion-Task-Id on every hook) and never re-derived from ambient context.
// This module owns the whole correlation policy and is pure: every seam — the
// matchers, the tmux lookup, the clock, the log — is injected, so the tiers are
// testable without sqlite, tmux, or the wiring's import-time timers.
//
// Side-effect free by contract: it returns a task or null and never binds,
// closes, or mutates anything. reconcileDispatch re-runs on every session
// mutation (~10 call sites), so resolve() must be safe to call constantly.

export type ResolveKind = "bind" | "close"

export interface WorkerIdentityDeps {
  // Tier 1 — exact task id, filtered to the status the event expects.
  matchUnboundTaskById(taskId: string): Task | null
  findRunningTaskById(taskId: string): Task | null
  // Distinguishes "this id is resolved already" from "this id is unknown here".
  getTask(taskId: string): Task | null
  // Tier 2 — the worker's tmux session name.
  matchUnboundTaskByTmuxSession(tmuxSession: string): Task | null
  findRunningTaskByTmuxSession(tmuxSession: string): Task | null
  // The ambiguity gate, and tier 3's cwd fallback (today's behaviour).
  countUnboundTasksInCwd(cwd: string): number
  countRunningTasksInCwd(cwd: string): number
  matchUnboundTaskByCwd(cwd: string): Task | null
  findRunningTaskByCwd(cwd: string): Task | null
  // %N pane id → tmux session name. Only called when the cwd is ambiguous.
  tmuxSessionForPane(pane: string): Promise<string | null>
  now(): number
  log(msg: string): void
}

export interface WorkerIdentityInput {
  taskId?: string
  tmuxPane?: string
  cwd: string
}

export interface WorkerIdentityResolver {
  resolve(kind: ResolveKind, input: WorkerIdentityInput): Promise<Task | null>
}

// A dispatch whose worker never sends an identity would otherwise sit in
// 'dispatched' forever (stale hook scripts on this host). After this long the
// bind degrades to the old cwd-FIFO match with a warning — never the close,
// where a wrong guess posts a reply under the wrong task and frees the wrong
// WIP slot.
export const BIND_DEGRADE_AFTER_MS = 90_000

export function createWorkerIdentityResolver(deps: WorkerIdentityDeps): WorkerIdentityResolver {
  const byId = (kind: ResolveKind, taskId: string): Task | null =>
    kind === "bind" ? deps.matchUnboundTaskById(taskId) : deps.findRunningTaskById(taskId)

  const byTmuxSession = (kind: ResolveKind, session: string): Task | null =>
    kind === "bind" ? deps.matchUnboundTaskByTmuxSession(session) : deps.findRunningTaskByTmuxSession(session)

  const byCwd = (kind: ResolveKind, cwd: string): Task | null =>
    kind === "bind" ? deps.matchUnboundTaskByCwd(cwd) : deps.findRunningTaskByCwd(cwd)

  const countIn = (kind: ResolveKind, cwd: string): number =>
    kind === "bind" ? deps.countUnboundTasksInCwd(cwd) : deps.countRunningTasksInCwd(cwd)

  // Tier 4. Bind is the only one that may degrade, and only once the oldest
  // candidate has waited out the window.
  function refuse(kind: ResolveKind, cwd: string, candidates: number): Task | null {
    deps.log(`ambiguous ${kind} in ${cwd}: ${candidates} candidates, no identity`)
    if (kind === "close") return null
    const oldest = deps.matchUnboundTaskByCwd(cwd)
    if (!oldest || deps.now() - oldest.updatedAt <= BIND_DEGRADE_AFTER_MS) return null
    deps.log(`bind degraded to cwd FIFO in ${cwd} → [${oldest.taskId}] — worker sent no task id (stale hook scripts on this host?)`)
    return oldest
  }

  return {
    async resolve(kind: ResolveKind, input: WorkerIdentityInput): Promise<Task | null> {
      const cwd = input.cwd ?? ""
      const taskId = (input.taskId ?? "").trim()

      // Tier 1 — the id the worker was dispatched with decides, both ways. A row
      // that exists but is already resolved (bound, done, cancelled) returns
      // null instead of falling through: a session that already owns a task must
      // never pick up a sibling task in the same cwd, which is the exact
      // cross-bind this phase exists to stop.
      if (taskId) {
        const exact = byId(kind, taskId)
        if (exact) return exact
        if (deps.getTask(taskId)) return null
        // Unknown id (a restored db, an env inherited from another host): no
        // identity at all rather than a wrong one — fall through to the tiers.
      }

      if (!cwd) return null
      const candidates = countIn(kind, cwd)
      // Nothing to correlate with. The common case for every non-worker session,
      // so it stays silent.
      if (candidates === 0) return null

      // Tier 2 — ambiguous cwd: ask tmux which session owns this pane. Gated on
      // ambiguity so the common path never pays for a subprocess.
      if (candidates > 1) {
        const pane = (input.tmuxPane ?? "").trim()
        if (pane) {
          const tmuxSession = await deps.tmuxSessionForPane(pane)
          if (tmuxSession) {
            const match = byTmuxSession(kind, tmuxSession)
            if (match) return match
          }
        }
        return refuse(kind, cwd, candidates)
      }

      // Tier 3 — exactly one candidate: the cwd is identity enough. Unchanged
      // behaviour for every single-worker directory.
      return byCwd(kind, cwd)
    },
  }
}
