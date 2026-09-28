// Full slash-command enumeration WITHOUT touching the user's pane.
//
// Phase 16b read the list by typing /help into the session's own live pane and
// paging it with Down for 12-40s. On a Mac terminal that is a person watching
// their command menu scroll by itself, and every phone inject in the meantime
// had to abort the scrape or be refused (seen 2026-09-28: "full list aborted
// after 72 in 11.9s", "command scrape aborted for inject → ttys007").
//
// Now the server owns the pane it drives: a throwaway detached tmux session
// (`cc-scrape-*`, 220x60) running `claude` in the SAME cwd — so project
// `.claude/` skills, commands and plugins resolve exactly as they do for the
// user — scraped with the same /help parser (lib/command-list.ts), then killed.
// The user's pane receives zero keystrokes.
//
// The session is invisible: COMPANION_SCRAPE=1 makes the hook scripts exit
// before posting, and lib/scrape-registry.ts makes the server drop anything
// that still arrives from its pane/tty (hooks, ps-discovery).
//
// The result is cached per (cwd, claude version, mtimes of the skill/command
// roots) — the list only changes when one of those does, so there is no clock.

import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { closeHelpOverlay, HELP_CLOSE_OPEN_WAIT_MS, HELP_PAINT_MS, listIncomplete, scrapeHelpTab, type CommandEntry, type HelpTab } from "./command-list"
import { paneHasDialog, paneInputReady } from "./tmux-pane"
import { markScrapeTarget, releaseScrapeTarget, SCRAPE_ENV, SCRAPE_SESSION_PREFIX, isScrapeSessionName } from "./scrape-registry"
import { buildInner, detachedNewSessionArgs } from "./spawn-session"

export interface TmuxResult { code: number; stdout: string }
export type TmuxRunner = (args: string[]) => Promise<TmuxResult>

export interface OffPaneTiming {
  bootTimeoutMs: number   // claude has this long to show its input box
  bootSettleMs: number    // onboarding/MCP dialogs paint AFTER the welcome box
  deadlineMs: number      // whole enumeration, boot included
  pollMs: number
  helpPaintMs: number
  tabSwitchMs: number
  keyMs: number
  pageSettleMs: number
}

export const DEFAULT_TIMING: OffPaneTiming = {
  bootTimeoutMs: 30_000,
  bootSettleMs: 1_000,
  deadlineMs: 120_000,
  pollMs: 150,
  helpPaintMs: HELP_PAINT_MS,
  tabSwitchMs: 700,
  // One Down per send-keys: a batch was seen to drop keys mid-repaint.
  keyMs: 45,
  pageSettleMs: 600,
}

export interface OffPaneDeps {
  tmux: TmuxRunner
  sleep: (ms: number) => Promise<void>
  now: () => number
  timing?: Partial<OffPaneTiming>
  // Unique suffix for the session name. Default: pid + counter.
  sessionName?: () => string
}

export type OffPaneStatus =
  | "ok"          // whole list read — cacheable
  | "incomplete"  // page budget ran out or a tab bailed — serve, don't cache
  | "wizard"      // first-run wizard / trust / MCP dialog in the hidden session
  | "timeout"     // deadline hit (boot or paging)
  | "error"       // tmux failed, session died

export interface OffPaneResult {
  status: OffPaneStatus
  commands: CommandEntry[]
  rowsPerPage: number
  session: string
  detail?: string
}

// First-run wizard / trust dialog / login screens. Any of these means the
// hidden claude is not at a prompt and pressing keys would answer a question
// on the user's behalf — bail, never cache.
const WIZARD_RE = /Choose the text style|Select login method|Let['’]s get started|Security notes|Press Enter to continue|terminal setup|Detected a custom API key|Is this a project you created|trust the files/i

export function paneBlockedByWizard(pane: string): boolean {
  return WIZARD_RE.test(pane) || paneHasDialog(pane)
}

let nameSeq = 0
function defaultSessionName(): string {
  return `${SCRAPE_SESSION_PREFIX}${process.pid}-${++nameSeq}`
}

// Spawn tmux, bounded. A wedged tmux must not hold the enumeration forever.
export const defaultTmux: TmuxRunner = async (args) => {
  try {
    const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => { try { p.kill() } catch { /* gone */ } }, 5_000)
    try {
      const stdout = await new Response(p.stdout).text()
      return { code: await p.exited, stdout }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { code: -1, stdout: "" }
  }
}

// Sessions currently being driven by THIS process — never reaped from under it.
const active = new Set<string>()

// Kill every cc-scrape-* session this process is not using right now: leftovers
// from a crashed or restarted server. Cheap; runs before each enumeration.
export async function reapScrapeSessions(tmux: TmuxRunner = defaultTmux): Promise<string[]> {
  const r = await tmux(["list-sessions", "-F", "#{session_name}"])
  if (r.code !== 0) return []
  const orphans = r.stdout.split("\n").map((s) => s.trim()).filter((s) => isScrapeSessionName(s) && !active.has(s))
  for (const name of orphans) await tmux(["kill-session", "-t", `=${name}`])
  return orphans
}

export async function enumerateCommandsOffPane(cwd: string, deps: OffPaneDeps): Promise<OffPaneResult> {
  const t: OffPaneTiming = { ...DEFAULT_TIMING, ...deps.timing }
  const { tmux, sleep, now } = deps
  const session = (deps.sessionName ?? defaultSessionName)()
  const deadline = now() + t.deadlineMs
  const expired = () => now() >= deadline
  const result = (status: OffPaneStatus, commands: CommandEntry[] = [], rowsPerPage = 0, detail?: string): OffPaneResult =>
    ({ status, commands, rowsPerPage, session, detail })

  await reapScrapeSessions(tmux).catch(() => [])

  const inner = buildInner(cwd, "claude", { [SCRAPE_ENV]: "1" })
  active.add(session)
  const created = await tmux(detachedNewSessionArgs(session, inner, "#{pane_id} #{pane_tty}"))
  const [pane = "", tty = ""] = created.stdout.trim().split(/\s+/)
  const target = { pane, tty }
  // Marked before claude has booted far enough to fire SessionStart.
  markScrapeTarget(target)
  try {
    if (created.code !== 0 || !/^%\d+$/.test(pane)) return result("error", [], 0, "tmux new-session failed")

    const capture = async (): Promise<string | null> => {
      const r = await tmux(["capture-pane", "-p", "-t", pane])
      return r.code === 0 ? r.stdout : null
    }
    const send = async (...keys: string[]): Promise<void> => { await tmux(["send-keys", "-t", pane, ...keys]) }
    const sendLiteral = async (text: string): Promise<void> => { await tmux(["send-keys", "-t", pane, "-l", text]) }

    const boot = await waitForPrompt(capture, sleep, now, t, deadline)
    if (boot !== "ready") return result(boot, [], 0, `boot: ${boot}`)

    const all: CommandEntry[] = []
    const outcomes: Array<{ aborted: boolean; wrongTab: boolean; incomplete: boolean }> = []
    let rowsPerPage = 0
    const tabs: HelpTab[] = ["default", "custom"]
    for (const [i, tab] of tabs.entries()) {
      // A fresh /help per tab: once the list has focus, Tab stops switching.
      await sendLiteral("/help")
      await send("Enter")
      const enterAt = now()
      await sleep(t.helpPaintMs)
      for (let k = 0; k < (tab === "default" ? 1 : 2); k++) {
        await send("Tab")
        await sleep(t.tabSwitchMs)
      }
      const scrape = await scrapeHelpTab({
        tab,
        capture: async () => await capture() ?? "",
        pageDown: async (rows) => {
          for (let k = 0; k < rows && !expired(); k++) {
            await send("Down")
            await sleep(t.keyMs)
          }
          await sleep(t.pageSettleMs)
        },
        aborted: expired,
      })
      all.push(...scrape.commands)
      rowsPerPage = rowsPerPage || scrape.rowsPerPage
      outcomes.push(scrape)
      if (scrape.aborted) return result("timeout", all, rowsPerPage, `paging ${tab}`)
      // Only the NEXT /help needs a clean prompt; the last tab's overlay dies
      // with the session.
      if (i < tabs.length - 1) {
        await closeHelpOverlay({
          capture,
          escape: () => send("Escape"),
          clearLine: () => send("C-u"),
          sleep,
          now,
          pollMs: t.pollMs,
          enterAt,
          paintMs: t.helpPaintMs,
          openWaitMs: HELP_CLOSE_OPEN_WAIT_MS,
          clearWaitMs: 1_500,
        })
      }
    }
    return result(listIncomplete(outcomes) ? "incomplete" : "ok", all, rowsPerPage)
  } catch (err) {
    return result("error", [], 0, err instanceof Error ? err.message : String(err))
  } finally {
    // Always, whatever happened above: no orphan cc-scrape-* sessions.
    await tmux(["kill-session", "-t", `=${session}`]).catch(() => undefined)
    active.delete(session)
    // Wall clock, like every reader of the registry.
    releaseScrapeTarget(target)
  }
}

type BootOutcome = "ready" | "wizard" | "timeout" | "error"

async function waitForPrompt(
  capture: () => Promise<string | null>,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  t: OffPaneTiming,
  deadline: number,
): Promise<BootOutcome> {
  const bootDeadline = Math.min(deadline, now() + t.bootTimeoutMs)
  let seen = false
  let misses = 0
  for (;;) {
    const text = await capture()
    if (text === null) {
      // The pane vanished after we had seen it: claude (or the shell) exited.
      if (seen && ++misses >= 3) return "error"
    } else {
      seen = true
      misses = 0
      if (paneBlockedByWizard(text)) return "wizard"
      if (paneInputReady(text)) {
        // MCP-enable / trust dialogs overlay the input box a beat AFTER the
        // welcome box paints — look again before calling it a prompt.
        await sleep(t.bootSettleMs)
        const again = await capture()
        if (again !== null && paneBlockedByWizard(again)) return "wizard"
        return "ready"
      }
    }
    if (now() >= bootDeadline) return "timeout"
    await sleep(t.pollMs)
  }
}

// ── Cache ──────────────────────────────────────────────────────────────────

// What the list depends on besides the cwd: the claude build (built-ins,
// bundled plugins) and the roots skills/commands/plugins are read from. A
// directory's mtime moves when an entry is added or removed — a new skill
// folder, a deleted command file — which is exactly when the list changes.
export function fingerprintRoots(cwd: string, home = homedir()): string[] {
  return [
    join(home, ".claude", "skills"),
    join(home, ".claude", "commands"),
    join(home, ".claude", "plugins"),
    join(cwd, ".claude"),
    join(cwd, ".claude", "skills"),
    join(cwd, ".claude", "commands"),
  ]
}

async function mtimeOf(path: string): Promise<string> {
  try { return String((await stat(path)).mtimeMs) } catch { return "-" }
}

// `claude --version` as the hidden session would run it. The server may run
// under launchd with a bare PATH, so the usual install locations are added.
const VERSION_TTL_MS = 60_000
let versionMemo: { at: number; value: string } | null = null
export async function claudeVersion(now = Date.now()): Promise<string> {
  if (versionMemo && now - versionMemo.at < VERSION_TTL_MS) return versionMemo.value
  const home = homedir()
  const extra = [join(home, ".local", "bin"), join(home, ".claude", "local"), join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
  const PATH = [process.env.PATH ?? "", ...extra].filter(Boolean).join(":")
  let value = "unknown"
  try {
    const bin = Bun.which("claude", { PATH })
    if (bin) {
      const p = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, PATH } })
      const timer = setTimeout(() => { try { p.kill() } catch { /* gone */ } }, 5_000)
      const out = (await new Response(p.stdout).text()).trim()
      clearTimeout(timer)
      if ((await p.exited) === 0 && out) value = out
    }
  } catch { /* unknown */ }
  versionMemo = { at: now, value }
  return value
}

export async function defaultFingerprint(cwd: string): Promise<string> {
  const [version, ...mtimes] = await Promise.all([claudeVersion(), ...fingerprintRoots(cwd).map(mtimeOf)])
  return [cwd, version, ...mtimes].join("|")
}

export interface ListerDeps {
  enumerate: (cwd: string) => Promise<OffPaneResult>
  fingerprint: (cwd: string) => Promise<string>
}

export interface ListOutcome {
  cached: boolean
  result: OffPaneResult
}

// Cache + de-duplication + one hidden claude at a time.
//
// - A hit needs the same fingerprint: nothing changed, nothing re-runs.
// - Concurrent callers for the same fingerprint share one enumeration (the
//   phone warms on every session activation — two sessions in one project
//   must not spawn two claudes).
// - Enumerations for different fingerprints run one after another: each is a
//   full claude process.
export function createCommandLister(deps: ListerDeps) {
  const cache = new Map<string, CommandEntry[]>()   // cwd → list for `keys`
  const keys = new Map<string, string>()            // cwd → fingerprint of that list
  const inflight = new Map<string, Promise<OffPaneResult>>()
  let chain: Promise<unknown> = Promise.resolve()

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run
  }

  async function list(cwd: string, opts: { force?: boolean } = {}): Promise<ListOutcome> {
    const fp = await deps.fingerprint(cwd)
    const hit = cache.get(cwd)
    if (hit && !opts.force && keys.get(cwd) === fp) {
      return { cached: true, result: { status: "ok", commands: hit, rowsPerPage: 0, session: "" } }
    }
    let job = inflight.get(fp)
    if (!job) {
      job = serial(() => deps.enumerate(cwd)).then((res) => {
        // Only a whole list is cached: a partial one would be served until
        // the next skill change.
        if (res.status === "ok" && res.commands.length) {
          cache.set(cwd, res.commands)
          keys.set(cwd, fp)
        }
        return res
      }).finally(() => inflight.delete(fp))
      inflight.set(fp, job)
    }
    return { cached: false, result: await job }
  }

  return { list, clear: () => { cache.clear(); keys.clear() } }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const commandLister = createCommandLister({
  enumerate: (cwd) => enumerateCommandsOffPane(cwd, { tmux: defaultTmux, sleep: realSleep, now: Date.now }),
  fingerprint: defaultFingerprint,
})
