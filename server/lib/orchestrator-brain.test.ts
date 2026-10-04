import { describe, expect, test } from "bun:test"
import { brainArgs } from "./orchestrator-brain"

// The brain's headless calls run lean: the measured ~3.4 s of each gate call
// that was CLI startup (user settings, hooks, MCP) is gone, and no tool exists.

describe("brainArgs", () => {
  test("lean flags, no tools, prompt on stdin", () => {
    const a = brainArgs("/bin/claude", "claude-haiku-4-5")
    const flag = (f: string) => a[a.indexOf(f) + 1]
    expect(a.slice(0, 2)).toEqual(["/bin/claude", "-p"])
    expect(flag("--model")).toBe("claude-haiku-4-5")
    expect(flag("--output-format")).toBe("json")
    expect(flag("--setting-sources")).toBe("project,local")
    expect(JSON.parse(flag("--settings")!)).toEqual({ disableAllHooks: true })
    expect(a).toContain("--strict-mcp-config")
    expect(a).toContain("--no-session-persistence")
    expect(flag("--permission-mode")).toBe("dontAsk")
    expect(flag("--tools")).toBe("") // no tool exists in the session
    expect(flag("--append-system-prompt")).toContain("NO tools")
    // exact shape: every value follows its flag, no positional prompt
    expect(a).toEqual([
      "/bin/claude", "-p", "--model", "claude-haiku-4-5", "--output-format", "json", "--setting-sources", "project,local",
      "--settings", '{"disableAllHooks":true}', "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "dontAsk",
      "--tools", "", "--append-system-prompt", flag("--append-system-prompt")!,
    ])
    expect(a).not.toContain("--disallowed-tools")
  })
})
