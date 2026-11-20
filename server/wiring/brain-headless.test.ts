import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRAIN_AGENT } from "../lib/brain"
import { listSessions, recordSession } from "../lib/sessions"
import { BRAIN_DIR, HEADLESS_BRAIN_PANE, createHeadlessBrainRunner, writeBrainMcpConfig } from "./brain-headless"

// The brain's --mcp-config (canvas-board-sync A1): only `board`, loopback, 0600, no token.

describe("writeBrainMcpConfig", () => {
  test("only board → loopback /api/mcp/board with the headersHelper; mode 0600; no token in the file", () => {
    process.env.COMPANION_AUTH_TOKEN = process.env.COMPANION_AUTH_TOKEN || "brain-mcp-test-token-0123456789"
    const dir = mkdtempSync(join(tmpdir(), "cc-brain-mcp-"))
    const path = writeBrainMcpConfig(dir, 4999)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const raw = readFileSync(path, "utf8")
    const cfg = JSON.parse(raw) as { mcpServers: Record<string, { type: string; url: string; headersHelper: string }> }
    expect(Object.keys(cfg.mcpServers)).toEqual(["board"])
    expect(cfg.mcpServers.board!.type).toBe("http")
    expect(cfg.mcpServers.board!.url).toBe("http://127.0.0.1:4999/api/mcp/board")
    expect(cfg.mcpServers.board!.headersHelper).toMatch(/scripts\/board-mcp-headers\.sh$/)
    expect(raw).not.toContain(process.env.COMPANION_AUTH_TOKEN!)
    expect(raw.toLowerCase()).not.toContain("bearer")
  })
})

describe("headless brain fresh spawn", () => {
  test("spawn(null) purges stale brain sessions so tick() cannot re-adopt an old session_id", async () => {
    recordSession({
      cwd: BRAIN_DIR,
      agent: "claude",
      sessionId: "stale-7-day-session-id",
      label: "brain",
      title: "Brain",
      taskId: BRAIN_AGENT,
      herdrPane: HEADLESS_BRAIN_PANE,
      herdrAgent: BRAIN_AGENT,
      agentStatus: "idle",
      pid: "99999",
    }, { sessionIdConfirmed: true })
    expect(listSessions().some((s) => s.sessionId === "stale-7-day-session-id")).toBe(true)

    const runner = createHeadlessBrainRunner({
      noteActivity: () => {},
      onStop: async () => {},
    })
    const res = await runner.spawn(null)
    expect(res.ok).toBe(true)
    const brainSessions = listSessions().filter((s) => s.taskId === BRAIN_AGENT)
    expect(brainSessions).toHaveLength(1)
    expect(brainSessions[0]!.sessionId).not.toBe("stale-7-day-session-id")
  })
})
