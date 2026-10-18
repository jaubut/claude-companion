// Takeover worktrees: a fresh worktree path is a new project to Claude Code, so
// a repo with .mcp.json would stop at the "new MCP servers found" picker. Carry
// the main checkout's MCP choices over, then disable every .mcp.json server
// still unanswered — a takeover never silently enables project MCP servers.
import { readFileSync } from "node:fs"

const MCP_KEYS = ["enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers"] as const

type Entry = Record<string, unknown>

const listed = (entry: Entry, k: string): unknown[] => (Array.isArray(entry[k]) ? (entry[k] as unknown[]) : [])

// Mutates entry; returns true when it changed.
export function applyMcpChoices(entry: Entry, projects: Record<string, Entry>, mcpFrom: string, cwd: string): boolean {
  let changed = false
  // Claude Code seeds empty lists on project entries, so empty counts as unanswered.
  const unanswered = entry.enableAllProjectMcpServers !== true
    && listed(entry, "enabledMcpjsonServers").length === 0 && listed(entry, "disabledMcpjsonServers").length === 0
  const main = projects[mcpFrom]
  if (unanswered && main) {
    for (const k of MCP_KEYS) if (k in main) { entry[k] = main[k]; changed = true }
  }
  if (entry.enableAllProjectMcpServers === true) return changed
  const seen = new Set([...listed(entry, "enabledMcpjsonServers"), ...listed(entry, "disabledMcpjsonServers")])
  const missing = mcpjsonServerNames(cwd).filter((n) => !seen.has(n))
  if (missing.length === 0) return changed
  entry.disabledMcpjsonServers = [...listed(entry, "disabledMcpjsonServers"), ...missing]
  return true
}

export function mcpjsonServerNames(cwd: string): string[] {
  try {
    const servers: unknown = JSON.parse(readFileSync(`${cwd}/.mcp.json`, "utf8")).mcpServers
    return servers && typeof servers === "object" ? Object.keys(servers) : []
  } catch { return [] }
}
