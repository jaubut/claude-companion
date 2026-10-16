import type { Task } from "./orchestrator-chat"

// The runtime-neutral handle of an orchestrator worker (wiring/worker-io.ts):
// which runtime holds it and its ids there. herdr_pane set ⇒ herdr (its rows
// have tmux_session NULL); else a tmux session; else nothing spawned yet.

export type WorkerRef =
  | { kind: "herdr"; agent: string; pane: string }
  | { kind: "tmux"; session: string; socket: string | null }
  | { kind: "none" }

export function workerRefOf(t: Pick<Task, "tmuxSession" | "tmuxSocket" | "herdrAgent" | "herdrPane">): WorkerRef {
  if (t.herdrPane) return { kind: "herdr", agent: t.herdrAgent ?? "", pane: t.herdrPane }
  if (t.tmuxSession) return { kind: "tmux", session: t.tmuxSession, socket: t.tmuxSocket || null }
  return { kind: "none" }
}

/** For logs: "herdr cc-x, pane w3:p1" / "tmux cc-x" / "no worker". */
export function workerLabel(r: WorkerRef): string {
  if (r.kind === "herdr") return `herdr ${r.agent || "?"}, pane ${r.pane}`
  if (r.kind === "tmux") return `tmux ${r.session}`
  return "no worker"
}
