import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCommandCatalog, initProbeArgs, parseInitLine } from "./command-catalog"
import type { CommandEntry } from "./command-list"

// Captured from Claude Code 2.1.327 on the Mac (2026-11-18), cut to six
// commands (descriptions shortened): the probe's control_response, and a turn's system/init
// (its other fields dropped; `mcp__fake__prompt` appended to stand for an MCP
// prompt only a real turn lists).
const CONTROL_RESPONSE = JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "1", response: { commands: [
  { name: "frontend-design", description: "Create distinctive, production-grade frontend interfaces that avoid generic AI aesthetics. (user)", argumentHint: "" },
  { name: "review", description: "Adversarial pre-delivery code review (spec compliance + code quality) against the original plan → risk report. (user)", argumentHint: "" },
  { name: "caveman:caveman", description: "(caveman) Ultra-compressed communication mode.", argumentHint: "", aliases: ["caveman"] },
  { name: "clear", description: "Start a new session with empty context; previous session stays on disk (resumable with /resume)", argumentHint: "[name]", aliases: ["reset", "new"], builtin: true },
  { name: "compact", description: "Free up context by summarizing the conversation so far", argumentHint: "<optional custom summarization instructions>", builtin: true },
  { name: "model", description: "Set the AI model for Claude Code", argumentHint: "<model>", builtin: true },
], claude_code_version: "2.1.327" } } })
const INIT_LINE = JSON.stringify({
  type: "system", subtype: "init", cwd: "/tmp/x", session_id: "ff319fea-e260-467c-ba24-a3be132452d0",
  slash_commands: ["frontend-design", "review", "caveman:caveman", "clear", "compact", "model", "mcp__fake__prompt"],
  skills: ["frontend-design", "review", "caveman:caveman"], claude_code_version: "2.1.327",
})

test("the probe's control_response → entries with descriptions and kinds", () => {
  const out = parseInitLine(CONTROL_RESPONSE)!
  expect(out.map((c) => c.name)).toEqual(["/frontend-design", "/review", "/caveman:caveman", "/clear", "/compact", "/model"])
  expect(out.find((c) => c.name === "/compact")).toEqual({ name: "/compact", description: "Free up context by summarizing the conversation so far", kind: "default" })
  expect(out.find((c) => c.name === "/review")?.kind).toBe("custom")
  expect(out.every((c) => c.kind === "default" || c.kind === "custom")).toBe(true)
})

test("a turn's init line: names only, descriptions and kinds merged from the prior list", () => {
  const prior = parseInitLine(CONTROL_RESPONSE)!
  const out = parseInitLine(INIT_LINE, prior)!
  expect(out).toHaveLength(7)
  expect(out.find((c) => c.name === "/model")).toEqual({ name: "/model", description: "Set the AI model for Claude Code", kind: "default" })
  expect(out.find((c) => c.name === "/mcp__fake__prompt")).toEqual({ name: "/mcp__fake__prompt", description: "", kind: "custom" })
  // Cold (no prior): skills and plugin commands are custom, the rest default.
  const cold = parseInitLine(INIT_LINE)!
  expect(cold.find((c) => c.name === "/caveman:caveman")?.kind).toBe("custom")
  expect(cold.find((c) => c.name === "/clear")?.kind).toBe("default")
})

test("other lines carry nothing", () => {
  expect(parseInitLine('{"type":"assistant","message":{}}')).toBeNull()
  expect(parseInitLine("not json")).toBeNull()
  expect(parseInitLine('{"type":"system","subtype":"hook_started"}')).toBeNull()
})

test("the probe argv is the control form: stream-json in, no persistence, no MCP, no hooks", () => {
  const a = initProbeArgs()
  expect(a).toContain("--input-format")
  expect(a).toContain("--no-session-persistence")
  expect(a).toContain("--strict-mcp-config")
  expect(a[a.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}')
  expect(a).not.toContain("--")
})

test("list: cold probes once (concurrent callers share it), warm is cached, persisted to disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-"))
  const file = join(dir, "companion-commands.json")
  let probes = 0
  const catalog = createCommandCatalog({ file, probe: async () => { probes++; await Bun.sleep(5); return parseInitLine(CONTROL_RESPONSE) } })
  const [a, b] = await Promise.all([catalog.list(dir), catalog.list(dir)])
  expect(probes).toBe(1)
  expect(a).toEqual({ cached: false, commands: expect.any(Array) as unknown as CommandEntry[] })
  expect(b.commands).toHaveLength(6)
  const t0 = performance.now()
  const warm = await catalog.list(dir)
  expect(performance.now() - t0).toBeLessThan(50)
  expect(warm.cached).toBe(true)
  expect(JSON.parse(readFileSync(file, "utf8"))[dir].commands).toHaveLength(6)
  // A fresh catalog reads the file: no probe.
  const again = createCommandCatalog({ file, probe: async () => { probes++; return null } })
  expect((await again.list(dir)).cached).toBe(true)
  expect(probes).toBe(1)
})

test("noteLine updates the cwd's list from a turn; a failed probe answers null, never an empty list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-"))
  const catalog = createCommandCatalog({ file: join(dir, "c.json"), probe: async () => null })
  expect(await catalog.list(dir)).toEqual({ cached: false, commands: null })
  catalog.noteLine(dir, INIT_LINE)
  expect(catalog.peek(dir)).toHaveLength(7)
  catalog.noteLine(dir, '{"type":"assistant"}')
  expect(catalog.peek(dir)).toHaveLength(7)
})
