import type { SpawnAgent } from "./spawn-session"
import type { Session } from "./sessions"

// Helpers shared by every hook endpoint and the event wiring: which agent a
// hook came from, the cwd it reports, the decision envelope each hook event
// expects back, and the project/subtitle labels used in pushes and cards.
// Fan-in by design — the route modules and wiring/events all import these.

export function agentFromHeaders(headers: Headers): SpawnAgent {
  return headers.get("x-companion-agent") === "codex" ? "codex" : "claude"
}

export function agentTitle(agent: SpawnAgent): string {
  return agent === "codex" ? "Codex" : "Claude"
}

export function cwdFromPayload(payloadCwd: string | undefined, headers: Headers): string {
  return payloadCwd || headers.get("x-companion-cwd") || ""
}

export function hookDecisionResponse(
  agent: SpawnAgent,
  eventName: "PreToolUse" | "PermissionRequest",
  decision: "allow" | "deny",
  reason: string,
): Response {
  if (agent === "codex") {
    // Codex hook compatibility: empty stdout continues; blocking is explicit.
    if (decision === "allow") return new Response("")
    return Response.json({ decision: "block", reason })
  }
  if (eventName === "PermissionRequest") {
    return Response.json({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: decision },
      },
    })
  }
  return Response.json({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  })
}

// "claude-companion", "tls-dashboard-v2", or undefined when cwd is the
// user's home dir (the default `cwd.split('/').pop()` would return the
// macOS username which is meaningless project context). Empty cwds also
// yield undefined so the title falls back to just the tool name.
export function projectLabelFor(cwd: string): string | undefined {
  if (!cwd) return undefined
  const home = process.env.HOME ?? ""
  if (home && cwd === home) return undefined
  const last = cwd.split("/").pop()
  return last && last.length > 0 ? last : undefined
}

export function subtitleFor(tool: string, summary: string): string | undefined {
  if (!summary) return undefined
  // Path-based tools: show the basename so the banner doesn't waste space
  // on /Users/<long>/path/to/. The full path stays in the body.
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "Read") {
    const base = summary.split("/").pop()
    if (base && base.length > 0 && base !== summary) return base
    return undefined
  }
  // Bash / Grep / etc — already concise, no value in showing the same
  // string twice across subtitle and body.
  return undefined
}

// Session identity as reported by the hook wrapper's headers. Sibling of
// agentFromHeaders above; the registry consumes the result but does not own
// the parsing. `Session` is a type-only import (erased) so there is no cycle.
export function metaFromHeaders(headers: Headers): Partial<Session> {
  const raw = (name: string): string => {
    const v = headers.get(name) ?? ""
    // Claude Code hooks sometimes emit "not a tty" when stdin is piped — treat
    // that as absent so we don't key a session on garbage.
    return v === "not a tty" ? "" : v
  }
  return {
    termProgram: raw("x-companion-term-program"),
    agent: raw("x-companion-agent") === "codex" ? "codex" : "claude",
    tty: raw("x-companion-tty"),
    iTermSessionId: raw("x-companion-iterm-session-id"),
    tmuxPane: raw("x-companion-tmux-pane"),
    taskId: raw("x-companion-task-id"),
    pid: raw("x-companion-pid"),
  }
}
