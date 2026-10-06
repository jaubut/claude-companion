// The auto-compact gate: every condition that must hold before a /compact is armed or typed.

export type InputState = "empty" | "typing" | "not_ready" | "unknown"

export interface GateInput {
  threshold: number
  tokens: number | null
  now: number
  lastUserActivityAt: number
  idleMs: number
  agentStatus: string
  backgroundTasks: number
  lastAttemptAt: number
  cooldownMs: number
  input: InputState
  // Test trigger: skip the size check (every other gate still applies).
  force?: boolean
}

export type GateReason =
  | "off"
  | "below_threshold"
  | "cooldown"
  | "user_active"
  | "typing"
  | "busy"
  | "background_tasks"
  | "pane_not_ready"

export type GateVerdict = { ok: true } | { ok: false; reason: GateReason }

// Every condition, cheapest first. `agentStatus` is Claude Code's own view
// (~/.claude/sessions/<pid>.json); only an explicit "idle" passes — "busy",
// "waiting" (a dialog) and unknown all refuse.
export function compactGate(g: GateInput): GateVerdict {
  if (g.threshold <= 0) return { ok: false, reason: "off" }
  if (!g.force && (g.tokens === null || g.tokens <= g.threshold)) return { ok: false, reason: "below_threshold" }
  if (g.lastAttemptAt > 0 && g.now - g.lastAttemptAt < g.cooldownMs) return { ok: false, reason: "cooldown" }
  if (g.now - g.lastUserActivityAt < g.idleMs) return { ok: false, reason: "user_active" }
  if (g.input === "typing") return { ok: false, reason: "typing" }
  if (g.agentStatus !== "idle") return { ok: false, reason: "busy" }
  if (g.backgroundTasks > 0) return { ok: false, reason: "background_tasks" }
  if (g.input !== "empty") return { ok: false, reason: "pane_not_ready" }
  return { ok: true }
}
