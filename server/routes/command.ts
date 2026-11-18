import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { CommandEntry } from "../lib/command-list"
import { suggestFromList } from "../lib/command-menu"
import { commandCatalog } from "../lib/command-catalog"
import { getShellSession } from "../lib/shell-sessions"
import { companionLog } from "../lib/log"
import { resolveSession } from "../lib/sessions"
import { checked, jsonObject } from "../lib/json-body"

// Slash-command autocomplete (PRJ-OR1T Phase 16; headless-desk P1): the list
// and the per-prefix suggestions both come from the init-derived catalog
// (lib/command-catalog.ts). Nothing here types into a terminal.

// Antigravity has no init line: its built-ins plus the skills on disk.
const AGY_BUILTIN_COMMANDS: CommandEntry[] = [
  { name: "/goal", description: "Run a thorough long-running task until the goal is achieved", kind: "default" },
  { name: "/compact", description: "Compact and summarize conversation context", kind: "default" },
  { name: "/schedule", description: "Run an instruction on a recurring schedule or timer", kind: "default" },
  { name: "/browser", description: "Browse, search, or interact with web applications", kind: "default" },
  { name: "/plan", description: "Step-by-step planning before execution", kind: "default" },
  { name: "/grill-me", description: "Interactive design interview to resolve decisions", kind: "default" },
  { name: "/teamwork", description: "Coordinate a team of autonomous agents", kind: "default" },
  { name: "/learn", description: "Persist a learned behavior or setup for future tasks", kind: "default" },
  { name: "/boost", description: "Deep thinking, strategic planning & rigorous verification", kind: "default" },
  { name: "/model", description: "Switch the active model", kind: "default" },
  { name: "/status", description: "Show session status", kind: "default" },
]

let cachedAgyCommands: { at: number; items: CommandEntry[] } | null = null
function listAgyCommands(): CommandEntry[] {
  if (cachedAgyCommands && Date.now() - cachedAgyCommands.at < 60_000) return cachedAgyCommands.items
  const seen = new Set<string>(AGY_BUILTIN_COMMANDS.map((c) => c.name))
  const out: CommandEntry[] = [...AGY_BUILTIN_COMMANDS]
  for (const dir of [join(homedir(), ".agents", "skills"), join(homedir(), ".claude", "skills")]) {
    if (!existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir)) {
        const name = `/${entry}`
        if (seen.has(name)) continue
        const skillMd = join(dir, entry, "SKILL.md")
        if (!existsSync(skillMd)) continue
        let desc = `Run ${entry} skill`
        try {
          const head = readFileSync(skillMd, "utf8").slice(0, 600)
          const m = head.match(/^description:\s*(.+)$/m)
          if (m?.[1]) desc = m[1].replace(/^["']|["']$/g, "").trim().slice(0, 120)
        } catch { /* ignore */ }
        seen.add(name)
        out.push({ name, description: desc, kind: "custom" })
      }
    } catch { /* ignore */ }
  }
  cachedAgyCommands = { at: Date.now(), items: out }
  return out
}

export async function handleCommandRoute(req: Request, url: URL): Promise<Response | null> {
  // ── Suggestions for a slash prefix ──
  // Body: { key, prefix } where prefix is what follows "/" ("" lists the menu
  // as it opens). Returns { commands: [{name, description}], source: "list" }:
  // always the catalog (lib/command-catalog.ts), never a keystroke. A cold
  // cache answers [] at once and warms behind it.
  if (url.pathname === "/api/command/suggest" && req.method === "POST") {
    const body = checked(await jsonObject<{ key?: string; prefix?: string }>(req, {}), { key: "string", prefix: "string" })
    const key = (body.key ?? "").trim()
    // Only the command token matters: everything after the first space is the
    // command's own argument, which the menu does not filter on.
    const prefix = (body.prefix ?? "").replace(/^\//, "").split(/\s/)[0] ?? ""
    if (!/^[A-Za-z0-9:_.-]*$/.test(prefix)) {
      return Response.json({ ok: false, error: "bad_prefix" }, { status: 400 })
    }
    const session = key ? resolveSession(key) : null
    if (!session) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })
    const all = session.agent === "gemini" ? listAgyCommands() : session.agent === "codex" ? [] : commandCatalog.peek(session.cwd)
    if (!all) void commandCatalog.probe(session.cwd)
    const commands = suggestFromList(all ?? [], prefix)
    return Response.json({ ok: true, key: session.key, prefix, commands, source: "list" })
  }

  // ── Every command the session knows about ──
  // Body: { key, force? }. Returns { commands: [{name, description, kind}] }
  // plus `cached`. Built from Claude Code's own init (lib/command-catalog.ts):
  // the init-only probe (< 1 s, no model call) when the cwd has no list yet,
  // refreshed by every headless turn's system/init.
  //   200 {ok, key, cached, commands}
  //   409 {ok:false, error:"aborted", key, partial:0}   the probe failed — retry later
  //   410 {ok:false, error:"target_gone"}
  if (url.pathname === "/api/command/list" && req.method === "POST") {
    const body = checked(await jsonObject<{ key?: string; force?: boolean }>(req, {}), { key: "string" })
    const key = (body.key ?? "").trim()
    // A terminal (lib/shell-sessions.ts) has no claude yet; its list is the
    // one claude would have in the shell's folder (the terminal's palette).
    const shell = key ? getShellSession(key) : undefined
    const session = shell
      ? { key: shell.key, cwd: shell.cwd, label: shell.name, agent: "claude" as const }
      : key ? resolveSession(key) : null
    if (!session) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })
    const aborted = () => Response.json({ ok: false, error: "aborted", key: session.key, partial: 0 }, { status: 409 })
    // Codex has a different command set and nothing to enumerate.
    if (session.agent === "codex") return aborted()
    if (session.agent === "gemini") {
      return Response.json({ ok: true, key: session.key, cached: true, commands: listAgyCommands() })
    }
    const t0 = Date.now()
    const { cached, commands } = await commandCatalog.list(session.cwd, { force: body.force === true })
    if (!commands) {
      companionLog(`\x1b[31mcommands\x1b[0m init probe failed in ${session.cwd} for ${session.label || session.key}`)
      return aborted()
    }
    if (!cached) companionLog(`\x1b[36mcommands\x1b[0m full list → ${commands.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s (init probe) for ${session.label || session.key}`)
    return Response.json({ ok: true, key: session.key, cached, commands })
  }

  return null
}
