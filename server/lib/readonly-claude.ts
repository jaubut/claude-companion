import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseCliResult } from "./cli-json"
import { resolveClaudeBin } from "./receipt-sonnet"
import { agyBin, normalizeAgyCliModelFlag } from "./worker-invocation"

// One hardened, read-only headless `claude -p` (shared by the Body investigator
// and the front door's quick_look). Read-only by construction, verified on
// claude 2.1.289 (STATE.md, body-auto-investigate):
//   --setting-sources project,local    user settings (auto mode, broad allows, hooks) never load;
//                                      the investigator's cwd is ~/.claude-companion/investigate
//                                      (empty, ours), so no project settings or .mcp.json either.
//                                      quick_look runs IN a repo with "" = no settings file at all,
//                                      so the repo's own .claude/settings*.json allows never apply
//   --settings {"disableAllHooks":true} --strict-mcp-config --no-session-persistence
//   --permission-mode dontAsk          anything not allowlisted is denied, never prompted
//   --tools <list> --add-dir <dirs>    the only tools, the only readable roots
//   --allowedTools / --disallowedTools the caller's allowlist + the shared deny list
// The prompt goes on stdin; the env is allowlisted (no notes DB / Companion tokens).

export interface ReadonlySpec {
  model: string
  /** --setting-sources value. Default "project,local" (the empty investigate cwd has neither); "" = no settings file at all. */
  settingSources?: string
  system: string
  /** --tools value, e.g. "Read,Grep,Glob,Bash". */
  tools: string
  /** Extra readable roots; [] = the cwd only. */
  addDirs: string[]
  allowed: readonly string[]
  disallowed: readonly string[]
}

export const SECRET_PATHS: readonly string[] = ["~/.config/tls-agent/**", "~/.claude-companion/auth.token", "~/.claude-companion/handoff-claim.keys", "~/.claude-companion/.env", "**/.env",
  "**/.env.*", "~/.ssh/**", "~/.claude/.credentials.json", "~/.aws/**", "~/.config/gh/**", "~/.netrc", "**/*.pem", "**/*.p8", "**/*.p12", "/proc/**"]

/** Denied in every read-only run: writes, secret reads (Read or Bash), flags that turn a read into a write. */
export const BASE_DISALLOWED: readonly string[] = [
  "Edit", "Write", "NotebookEdit",
  ...SECRET_PATHS.map((p) => `Read(${p})`),
  "Bash(*tls-agent*)", "Bash(*.env*)", "Bash(*auth.token*)", "Bash(*handoff-claim*)", "Bash(*credentials*)", "Bash(*.ssh/*)", "Bash(*environ*)", "Bash(*secrets*)",
  "Bash(curl * -X*)", "Bash(curl * --request*)", "Bash(curl * -d*)", "Bash(curl * --data*)", "Bash(curl * -F*)", "Bash(curl * --form*)",
  "Bash(curl * -T*)", "Bash(curl * --upload*)", "Bash(curl * -o*)", "Bash(curl * -O*)", "Bash(curl * --output*)",
  "Bash(git *--output*)",
]

export function readonlyArgs(bin: string, spec: ReadonlySpec): string[] {
  return [
    bin, "-p", "--model", spec.model, "--output-format", "json",
    "--setting-sources", spec.settingSources ?? "project,local",
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--append-system-prompt", spec.system,
    "--tools", spec.tools,
    ...(spec.addDirs.length ? ["--add-dir", ...spec.addDirs] : []),
    "--allowedTools", ...spec.allowed,
    "--disallowedTools", ...spec.disallowed,
  ]
}

export function isReadonlyGeminiModel(model: string): boolean {
  return /^(gemini|orchestrator)/i.test(model.trim())
}

export function readonlyAgyArgs(
  prompt: string,
  spec: ReadonlySpec,
  opts: { timeoutMs?: number; addDirs?: string[] } = {},
): string[] {
  const fullPrompt = spec.system.trim() ? `${spec.system.trim()}\n\n${prompt}` : prompt
  const dirs = opts.addDirs ?? spec.addDirs
  const args = [
    `--print=${fullPrompt}`,
    "--mode", "plan",
    "--model", normalizeAgyCliModelFlag(spec.model),
    "--output-format", "text",
    "--disable-slash-commands",
  ]
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    args.push("--print-timeout", `${Math.max(5, Math.ceil(opts.timeoutMs / 1000))}s`)
  }
  for (const d of dirs) {
    if (d.trim()) args.push("--add-dir", d)
  }
  return args
}

const ENV_KEEP = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DOCKER_HOST"]

/** Allowlisted child env: no notes DB / Companion / broker tokens ever reach the child. */
export function readonlyEnv(
  env: Record<string, string | undefined> = process.env,
  home: string = process.env.HOME || homedir(),
  opts: { includeClaudeAuth?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ENV_KEEP) if (env[k]) out[k] = env[k]!
  if (opts.includeClaudeAuth !== false) {
    for (const [k, v] of Object.entries(env)) if (v && /^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CONFIG_DIR)$/.test(k)) out[k] = v
  }
  out.HOME ??= home
  out.PATH = [join(home, ".local/bin"), join(home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":")
  out.TERM = "dumb"
  return out
}

/** The one empty, stable cwd (the CLI leaves an empty ~/.claude/projects/<cwd>/memory per distinct cwd). */
export function readonlyCwd(home: string = process.env.HOME || homedir()): string {
  return join(home, ".claude-companion", "investigate")
}

export type ReadonlyRun = { ok: true; text: string } | { ok: false; error: string }

function timeoutText(ms: number): string {
  return ms >= 60_000 && ms % 60_000 === 0 ? `timed out after ${ms / 60_000} min` : `timed out after ${Math.round(ms / 1000)} s`
}

export interface ReadonlyRunOpts {
  timeoutMs: number
  cwd?: string
  home?: string
  spawn?: typeof Bun.spawn
  agy?: string
  claude?: string | null
}

/** Spawn read-only headless `agy --mode plan` (Gemini) or `claude -p` (Claude). Never throws. */
export async function runReadonlyClaude(prompt: string, spec: ReadonlySpec, opts: ReadonlyRunOpts): Promise<ReadonlyRun> {
  const gemini = isReadonlyGeminiModel(spec.model)
  const spawnFn = opts.spawn ?? Bun.spawn
  const bin = gemini ? (opts.agy ?? agyBin(opts.home)) : (opts.claude !== undefined ? opts.claude : resolveClaudeBin())
  if (!bin) return { ok: false, error: gemini ? "agy binary not found" : "claude binary not found" }
  const home = opts.home ?? (process.env.HOME || homedir())
  const emptyCwd = readonlyCwd(home)
  const cwd = gemini ? emptyCwd : (opts.cwd ?? emptyCwd)
  let proc: ReturnType<typeof Bun.spawn>
  try {
    mkdirSync(cwd, { recursive: true })
    if (gemini) {
      const extraDir = opts.cwd && opts.cwd !== emptyCwd ? [opts.cwd] : []
      const addDirs = [...new Set([...spec.addDirs, ...extraDir])]
      const argv = [bin, ...readonlyAgyArgs(prompt, spec, { timeoutMs: opts.timeoutMs, addDirs })]
      const env = { ...readonlyEnv(process.env, home, { includeClaudeAuth: false }), DISPATCH_HEADLESS: "1", CLAUDE_NO_AGENT_ENV: "1" }
      proc = spawnFn(argv, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    } else {
      const env = { ...readonlyEnv(process.env, home), DISPATCH_HEADLESS: "1" }
      proc = spawnFn(readonlyArgs(bin, spec), { cwd, env, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" })
    }
  } catch {
    return { ok: false, error: "spawn failed" }
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; try { proc.kill() } catch { /* gone */ } }, opts.timeoutMs)
  try {
    const [out] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()])
    const code = await proc.exited
    if (timedOut) return { ok: false, error: timeoutText(opts.timeoutMs) }
    const cliName = gemini ? "agy" : "claude"
    if (code !== 0) return { ok: false, error: `${cliName} exited ${code}` }
    const text = gemini ? (out.trim() || null) : parseCliResult(out)
    return text === null ? { ok: false, error: `no result in ${cliName} output` } : { ok: true, text }
  } catch {
    return { ok: false, error: gemini ? "agy run crashed" : "claude run crashed" }
  } finally {
    clearTimeout(timer)
  }
}
