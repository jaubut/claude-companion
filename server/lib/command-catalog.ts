// The slash-command catalog per cwd, built from Claude Code's own headless
// output instead of a /help scrape (headless-desk P1).
//
// Two sources, one parser (parseInitLine):
//   - the init-only probe: `claude -p --input-format stream-json` sent a lone
//     `initialize` control_request answers a `control_response` whose
//     `commands` carry names, descriptions and `builtin` (the SDK
//     supportedCommands shape). Killed on that line: no user message is ever
//     written, so no model request is made (Verify 2, 2026-11-18: 0 POST
//     /v1/messages, no transcript, ~0.34 s, 251 commands on the Mac).
//   - every headless turn's `system/init` line (desk runner, brain): names only
//     (`slash_commands`, `skills`), merged over what the probe described, so
//     MCP prompts that only exist after a real turn show up too.
// No frame: clients pull it through /api/command/list and /suggest.

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { CommandEntry } from "./command-list"
import { scrubAgentEnv } from "./worker-invocation"

export const PROBE_TIMEOUT_MS = 15_000
// A cached list older than this is still served, and refreshed behind it.
export const STALE_MS = 60 * 60 * 1000
const MAX_CWDS = 200

export function initProbeArgs(): string[] {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--no-session-persistence", "--strict-mcp-config", "--settings", '{"disableAllHooks":true}',
  ]
}

export const INIT_REQUEST = JSON.stringify({ type: "control_request", request_id: "1", request: { subtype: "initialize" } })

interface ProbeCommand { name?: unknown; description?: unknown; builtin?: unknown }

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * A stream-json line → catalog entries, or null when the line carries none.
 * `prior` (the cwd's current list) supplies descriptions and kinds an init
 * line does not have.
 */
export function parseInitLine(line: string, prior: readonly CommandEntry[] = []): CommandEntry[] | null {
  let j: Record<string, unknown>
  try { j = JSON.parse(line) as Record<string, unknown> } catch { return null }
  if (!j || typeof j !== "object") return null
  if (j.type === "control_response") {
    const outer = j.response as { response?: { commands?: unknown } } | undefined
    const cmds = outer?.response?.commands
    if (!Array.isArray(cmds)) return null
    const out: CommandEntry[] = []
    for (const c of cmds as ProbeCommand[]) {
      const name = str(c?.name).replace(/^\//, "")
      if (!name) continue
      out.push({ name: `/${name}`, description: oneLine(str(c.description)), kind: c.builtin === true ? "default" : "custom" })
    }
    return out
  }
  if (j.type === "system" && j.subtype === "init" && Array.isArray(j.slash_commands)) {
    const skills = new Set((Array.isArray(j.skills) ? j.skills : []).map(str))
    const known = new Map(prior.map((c) => [c.name, c]))
    const out: CommandEntry[] = []
    for (const raw of j.slash_commands as unknown[]) {
      const name = str(raw).replace(/^\//, "")
      if (!name) continue
      const had = known.get(`/${name}`)
      const custom = skills.has(name) || name.includes(":") || name.startsWith("mcp__")
      out.push({ name: `/${name}`, description: had?.description ?? "", kind: had?.kind ?? (custom ? "custom" : "default") })
    }
    return out
  }
  return null
}

export type Probe = (cwd: string) => Promise<CommandEntry[] | null>

// Spawn the init-only probe in `cwd`, write the initialize request, resolve on
// the first control_response (or system/init) line and SIGKILL the process.
export const defaultProbe: Probe = (cwd) => new Promise((resolve) => {
  let done = false
  let buf = ""
  const env = { ...scrubAgentEnv(process.env), COMPANION_SCRAPE: "1" }
  let child: ReturnType<typeof spawn>
  try {
    child = spawn("claude", initProbeArgs(), { cwd, env, stdio: ["pipe", "pipe", "ignore"] })
  } catch { resolve(null); return }
  const finish = (v: CommandEntry[] | null): void => {
    if (done) return
    done = true
    clearTimeout(timer)
    try { child.kill("SIGKILL") } catch { /* gone */ }
    resolve(v)
  }
  const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS)
  child.on("error", () => finish(null))
  child.on("close", () => finish(null))
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    buf += chunk
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const l of lines) {
      const parsed = parseInitLine(l)
      if (parsed) { finish(parsed); return }
    }
  })
  child.stdin?.on("error", () => { /* closed early */ })
  child.stdin?.write(`${INIT_REQUEST}\n`)
})

export interface CatalogEntry { at: number; commands: CommandEntry[] }

export interface CommandCatalog {
  useFile(path: string): void
  peek(cwd: string): CommandEntry[] | null
  list(cwd: string, opts?: { force?: boolean }): Promise<{ cached: boolean; commands: CommandEntry[] | null }>
  noteLine(cwd: string, line: string): void
  probe(cwd: string): Promise<CommandEntry[] | null>
}

export function createCommandCatalog(opts: { probe?: Probe; file?: string; now?: () => number } = {}): CommandCatalog {
  const probeFn = opts.probe ?? defaultProbe
  let file = opts.file ?? join(homedir(), ".claude", "state", "companion-commands.json")
  const now = opts.now ?? Date.now
  const byCwd = new Map<string, CatalogEntry>()
  const inflight = new Map<string, Promise<CommandEntry[] | null>>()
  let loaded = false

  function load(): void {
    if (loaded) return
    loaded = true
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, CatalogEntry>
      for (const [cwd, e] of Object.entries(raw)) {
        if (e && Array.isArray(e.commands) && typeof e.at === "number") byCwd.set(cwd, e)
      }
    } catch { /* no file yet */ }
  }

  function save(): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(Object.fromEntries(byCwd)))
    } catch { /* best effort: the memory copy still serves */ }
  }

  function put(cwd: string, commands: CommandEntry[]): void {
    byCwd.delete(cwd)
    byCwd.set(cwd, { at: now(), commands })
    while (byCwd.size > MAX_CWDS) byCwd.delete(byCwd.keys().next().value!)
    save()
  }

  function probe(cwd: string): Promise<CommandEntry[] | null> {
    const running = inflight.get(cwd)
    if (running) return running
    const p = (existsSync(cwd) ? probeFn(cwd) : Promise.resolve(null))
      .then((commands) => {
        if (commands && commands.length > 0) put(cwd, commands)
        return commands && commands.length > 0 ? commands : null
      })
      .catch(() => null)
      .finally(() => inflight.delete(cwd))
    inflight.set(cwd, p)
    return p
  }

  return {
    // Test seam: keep a test's writes out of the real state dir.
    useFile(path) {
      file = path
    },
    peek(cwd) {
      load()
      return byCwd.get(cwd)?.commands ?? null
    },
    async list(cwd, o = {}) {
      load()
      const hit = byCwd.get(cwd)
      if (hit && !o.force) {
        if (now() - hit.at > STALE_MS) void probe(cwd)
        return { cached: true, commands: hit.commands }
      }
      return { cached: false, commands: await probe(cwd) }
    },
    noteLine(cwd, line) {
      if (!cwd || !line.includes('"slash_commands"')) return
      load()
      const commands = parseInitLine(line, byCwd.get(cwd)?.commands ?? [])
      if (commands && commands.length > 0) put(cwd, commands)
    },
    probe,
  }
}

export const commandCatalog = createCommandCatalog()
