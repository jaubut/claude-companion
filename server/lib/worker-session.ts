import { type Session, listSessions, recordSession, removeSessionByKey, setSessionModel } from "./sessions"
import type { SupervisedTaskSnapshot } from "./worker-supervisor"

/**
 * The drawer card of a headless worker task. One task = one live session: the supervisor registers the card under its
 * own uuid before agy / codex mint their conversation id (a family switch mints another), so once the task reports a
 * new id, every other headless record of the same task is retired.
 */
export function recordWorkerSession(task: SupervisedTaskSnapshot, pid: number | null, model: string): Session | null {
  const recorded = recordSession({
    cwd: task.worktree,
    agent: task.family,
    sessionId: task.sessionId,
    label: `${task.repo} · ${task.taskId}`,
    title: task.status === "running" && task.step ? `${task.title} · ${task.step}` : task.title,
    taskId: task.taskId,
    herdrPane: `headless:worker:${task.taskId}`,
    herdrAgent: task.builder,
    agentStatus: task.status === "running" ? "busy" : "idle",
    pid: String(pid ?? process.pid),
    firstSeenAt: task.startedAt,
    model,
  }, { sessionIdConfirmed: true })
  if (!recorded) return null
  if (model) setSessionModel(recorded.key, model)
  for (const s of listSessions()) {
    if (s.key !== recorded.key && s.taskId === task.taskId && s.herdrPane?.startsWith("headless:")) removeSessionByKey(s.key)
  }
  return recorded
}
