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
// user — scraped with the same /help parser (lib/command-list.ts), then killed,
// confirmed dead, and its process seen to exit. The user's pane receives zero
// keystrokes.
//
// The hidden claude is side-effect free:
//   - HOME is a throwaway dir (lib/command-offpane-home.ts): the boot's writes
//     to .claude.json, history.jsonl ("/help"), sessions/<pid>.json and
//     transcripts land there and are deleted — never racing the user's own
//     claudes on ~/.claude.json;
//   - `--settings {"disableAllHooks":true,…}` — none of the user's hooks run
//     (companion hooks included) and no status line command runs;
//   - `--strict-mcp-config --mcp-config {"mcpServers":{}}` — no MCP server starts.
//     KNOWN GAP (accepted, Jeremie 2026-09-29): commands that MCP servers
//     expose as prompts (/mcp__<server>__<prompt>, 19 on the Mac at the time)
//     are therefore NOT in the list. Starting the user's MCP servers from a
//     hidden process is the side effect this design exists to avoid;
//   - COMPANION_SCRAPE=1 + CLAUDE_CODE_SCRAPE_SESSION=1 in its environment:
//     any hook that still runs can bail, and ps-discovery skips the process
//     by its tty (registry) or its ENVIRONMENT — never its command line, which
//     a user's `claude -p "…COMPANION_SCRAPE=1…"` could carry;
//   - DISABLE_AUTOUPDATER=1 — no claude or plugin update from a hidden process;
//   - lib/scrape-registry.ts drops anything from its pane/tty server-side.
//
// Cached per fingerprint (cwd + claude binary + version + mtimes of every file
// the list is built from), with a 24h safety TTL. A wizard/error is remembered
// per fingerprint for 10 minutes so a stuck project does not spawn a claude on
// every phone activation.

import { join } from "node:path"
import {
  closeHelpOverlay, HELP_CLOSE_OPEN_WAIT_MS, HELP_PAINT_MS, helpOverlayVisible, helpTab, listIncomplete, scrapeHelpTab,
  type CommandEntry, type HelpTab,
} from "./command-list"
import { paneHasDialog, paneInputReady } from "./tmux-pane"
import {
  isScrapeSessionName, markScrapeTarget, releaseScrapeTarget, SCRAPE_ENV, SCRAPE_ENV_CLAUDE, scrapeSessionName, scrapeSessionOwner,
} from "./scrape-registry"
import { detachedNewSessionArgs } from "./spawn-session"
import { defaultTmux, type ClaudeLaunch, type TmuxRunner } from "./command-offpane-launch"
import { createScrapeHome, knownHomesBase, removeScrapeHome, sweepOrphanHomes, type ScrapeHome } from "./command-offpane-home"

export type { ClaudeLaunch, TmuxResult, TmuxRunner } from "./command-offpane-launch"

export interface OffPaneTiming {
  bootTimeoutMs: number   // claude has this long to show its input box
  bootSettleMs: number    // onboarding/MCP dialogs paint AFTER the welcome box
  bootMissLimit: number   // consecutive failed captures before the pane counts as gone
  deadlineMs: number      // whole enumeration, boot included
  pollMs: number
  helpPaintMs: number     // the close path's paint window (lib/command-list.ts)
  helpOpenMs: number      // /help+Enter → overlay on screen, polled, at most this
  tabSwitchMs: number     // Tab → the tab's label on screen, polled, at most this
  keyMs: number
  pageSettleMs: number
  killAttempts: number
  killRetryMs: number
  pidExitMs: number       // after the kill: how long to wait for claude's pid to go
}

export const DEFAULT_TIMING: OffPaneTiming = {
  bootTimeoutMs: 30_000,
  bootSettleMs: 1_000,
  bootMissLimit: 3,
  deadlineMs: 120_000,
  pollMs: 150,
  helpPaintMs: HELP_PAINT_MS,
  // Polled, not slept: with two hidden claudes booting at once (the lister
  // runs 2 in parallel) /help took longer than the old fixed 1.8s to paint,
  // the first Tab landed before the overlay, and both lists came back
  // "incomplete" with an empty default tab — measured on this Mac.
  helpOpenMs: 10_000,
  tabSwitchMs: 5_000,
  // One Down per send-keys: a batch was seen to drop keys mid-repaint.
  keyMs: 45,
  pageSettleMs: 600,
  killAttempts: 5,
  killRetryMs: 200,
  pidExitMs: 3_000,
}

// Where the hidden session's throwaway HOME comes from. Injected by tests.
export interface HomeFactory {
  create: (sessionName: string, launch: ClaudeLaunch, cwd: string) => Promise<ScrapeHome>
  remove: (root: string) => Promise<void>
  // Orphan homes of dead servers (optional: test factories have none).
  sweep?: (keep: (name: string) => boolean, reapable: (name: string) => boolean, ownerDead: (pid: number) => boolean, selfPid: number) => Promise<void>
  // Where a session's home would be, for a reaped orphan (null: unknown).
  pathFor?: (sessionName: string) => Promise<string | null>
}

export const realHomes: HomeFactory = {
  create: (name, launch, cwd) => createScrapeHome(name, {
    home: launch.home, configDir: launch.configDir, configDirExplicit: launch.configDirExplicit, platform: process.platform, cwd,
  }),
  remove: removeScrapeHome,
  sweep: (keep, reapable, ownerDead, selfPid) => sweepOrphanHomes({ keep, reapable, ownerDead, selfPid }),
  pathFor: async (name) => {
    const base = await knownHomesBase()
    return base ? join(base, name) : null
  },
}

// Signal 0: true while the pid exists (EPERM = exists, not ours to signal).
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export interface LifecycleDeps {
  tmux: TmuxRunner
  sleep: (ms: number) => Promise<void>
  pidAlive?: (pid: number) => boolean
  homes?: HomeFactory
  selfPid?: number
  timing?: Partial<OffPaneTiming>
}

export interface OffPaneDeps extends LifecycleDeps {
  now: () => number
  launch: ClaudeLaunch
  sessionName?: () => string
}

export type OffPaneStatus =
  | "ok"          // whole list read — cacheable
  | "incomplete"  // page budget ran out or a tab bailed — serve, don't cache
  | "wizard"      // first-run wizard / trust / login dialog in the hidden session
  | "timeout"     // deadline hit (boot or paging)
  | "error"       // tmux failed, a capture/send failed, claude missing or exited
  | "pending"     // (lister only) still running; the caller stopped waiting
  | "unsupported" // (lister only) claude too old for the throwaway HOME — nothing spawned

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

// A tmux call that failed, or a pane that can no longer be read. Never turned
// into an empty page: a list built on one would be cached as "complete".
class ScrapeIOError extends Error {}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

const EMPTY_MCP = JSON.stringify({ mcpServers: {} })
// The scrape vars ride in the settings env too, so every process claude
// starts (hooks, if any run, and tools) inherits them.
const SCRAPE_SETTINGS = JSON.stringify({ disableAllHooks: true, env: { [SCRAPE_ENV]: "1", [SCRAPE_ENV_CLAUDE]: "1" } })

// The command tmux runs in the hidden session. `exec` so the pane (and the
// session) dies with claude, and the pane pid IS claude's pid. `home.cwd`
// wins over `cwd`: it differs only when cwd is the user's real HOME
// (lib/command-offpane-home.ts).
export function buildScrapeInner(cwd: string, launch: ClaudeLaunch, home: Pick<ScrapeHome, "env" | "unset"> & { cwd?: string }): string {
  const exports = [
    `export ${SCRAPE_ENV}=1`,
    `export ${SCRAPE_ENV_CLAUDE}=1`,
    "export DISABLE_AUTOUPDATER=1",
    ...Object.entries({ ...launch.env, ...home.env }).map(([k, v]) => `export ${k}=${shq(v)}`),
    ...home.unset.map((k) => `unset ${k}`),
  ]
  const argv = [
    shq(launch.bin),
    "--strict-mcp-config", "--mcp-config", shq(EMPTY_MCP),
    "--settings", shq(SCRAPE_SETTINGS),
  ]
  return `${exports.join("; ")}; cd ${shq(home.cwd ?? cwd)} && exec ${argv.join(" ")}`
}

// ── Session lifecycle ──────────────────────────────────────────────────────

interface ScrapeRecord { name: string; pane: string; tty: string; pid: number; home: string }

// Sessions currently being driven by THIS process — never reaped from under it.
const active = new Map<string, ScrapeRecord>()
// Not yet confirmed gone (kill unconfirmed, or claude's pid still alive):
// stays marked in the registry and is retried by every reap.
const pendingKill = new Map<string, ScrapeRecord>()
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDeps: LifecycleDeps | null = null
const PENDING_RETRY_MS = 30_000

// kill-session, then has-session to prove it. has-session exits 1 when the
// session (or the whole server) is gone; anything else — 0, or -1 for a
// wedged/unspawnable tmux — is not proof.
export async function killScrapeSession(
  tmux: TmuxRunner, name: string, sleep: (ms: number) => Promise<void>, attempts = DEFAULT_TIMING.killAttempts, retryMs = DEFAULT_TIMING.killRetryMs,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await tmux(["kill-session", "-t", `=${name}`]).catch(() => undefined)
    const probe = await tmux(["has-session", "-t", `=${name}`]).catch(() => ({ code: -1, stdout: "" }))
    if (probe.code === 1) return true
    await sleep(retryMs)
  }
  return false
}

async function waitPidExit(pid: number, alive: (pid: number) => boolean, sleep: (ms: number) => Promise<void>, ms: number, pollMs: number): Promise<boolean> {
  for (let waited = 0; ; waited += pollMs) {
    if (!alive(pid)) return true
    if (waited >= ms) return false
    await sleep(pollMs)
  }
}

// Kill → confirm with has-session → wait for claude's pid to exit → only then
// unmark the pane/tty and delete the throwaway HOME. Anything unconfirmed
// keeps the record tracked (and its pane/tty marked) for the next reap: a
// hidden claude still alive on a tty must never be discovered as a user session.
async function finishSession(rec: ScrapeRecord, deps: LifecycleDeps): Promise<boolean> {
  const t: OffPaneTiming = { ...DEFAULT_TIMING, ...deps.timing }
  const alive = deps.pidAlive ?? pidAlive
  const homes = deps.homes ?? realHomes
  const dead = await killScrapeSession(deps.tmux, rec.name, deps.sleep, t.killAttempts, t.killRetryMs).catch(() => false)
  const exited = dead && (rec.pid <= 0 || await waitPidExit(rec.pid, alive, deps.sleep, t.pidExitMs, t.pollMs))
  if (!exited) {
    pendingKill.set(rec.name, rec)
    schedulePendingRetry(deps)
    return false
  }
  pendingKill.delete(rec.name)
  releaseScrapeTarget(rec)
  if (rec.home) await homes.remove(rec.home).catch(() => undefined)
  return true
}

// The owner's pid is in the name: only this server's sessions, or a dead
// server's, are ours to reap. Another live companion's hidden claude is left
// alone (still marked hidden here, so we never list it either).
function reapable(name: string, selfPid: number, alive: (pid: number) => boolean): boolean {
  const owner = scrapeSessionOwner(name)
  if (owner === null) return false
  return owner === selfPid || !alive(owner)
}

function parsePaneList(out: string): ScrapeRecord[] {
  const recs: ScrapeRecord[] = []
  for (const line of out.split("\n")) {
    const [name = "", pane = "", tty = "", pid = ""] = line.trim().split("\t")
    if (!isScrapeSessionName(name)) continue
    recs.push({ name, pane, tty, pid: Number(pid) || 0, home: "" })
  }
  return recs
}

// Every cc-scrape-* pane is registered as hidden FIRST (so a discovery racing
// this reap can never pick one up), then the reapable ones — leftovers from a
// crashed/restarted server, and anything whose kill was not confirmed — are
// killed. Failed kills are retained for the retry timer. Orphan throwaway
// HOMEs are swept as well.
export async function reapScrapeSessions(deps: Partial<LifecycleDeps> = {}): Promise<string[]> {
  const full: LifecycleDeps = { tmux: defaultTmux, sleep: realSleep, ...deps }
  const alive = full.pidAlive ?? pidAlive
  const selfPid = full.selfPid ?? process.pid
  const homes = full.homes ?? realHomes
  const r = await full.tmux(["list-panes", "-a", "-F", "#{session_name}\t#{pane_id}\t#{pane_tty}\t#{pane_pid}"]).catch(() => ({ code: -1, stdout: "" }))
  const listed = r.code === 0 ? parsePaneList(r.stdout) : []
  for (const rec of listed) markScrapeTarget(rec)

  const todo = new Map<string, ScrapeRecord>()
  for (const rec of pendingKill.values()) todo.set(rec.name, rec)
  for (const rec of listed) {
    if (active.has(rec.name) || !reapable(rec.name, selfPid, alive)) continue
    const pending = pendingKill.get(rec.name)
    const home = pending?.home || (await homes.pathFor?.(rec.name).catch(() => null)) || ""
    todo.set(rec.name, { ...rec, home })
  }
  const reaped: string[] = []
  for (const rec of todo.values()) {
    if (active.has(rec.name)) continue
    if (await finishSession(rec, full) && listed.some((l) => l.name === rec.name)) reaped.push(rec.name)
  }
  // Still-live sessions of another server are not reapable, so their homes stay.
  await homes.sweep?.(
    (name) => active.has(name) || pendingKill.has(name),
    (name) => isScrapeSessionName(name) && reapable(name, selfPid, alive),
    (pid) => !alive(pid),
    selfPid,
  ).catch(() => undefined)
  return reaped
}

function schedulePendingRetry(deps: LifecycleDeps): void {
  retryDeps = deps
  if (retryTimer || pendingKill.size === 0) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    const d = retryDeps ?? deps
    void reapScrapeSessions(d).catch(() => []).finally(() => schedulePendingRetry(d))
  }, PENDING_RETRY_MS)
  ;(retryTimer as { unref?: () => void }).unref?.()
}

// Tests only.
export function pendingKills(): string[] {
  return [...pendingKill.keys()]
}
export function resetOffPaneState(): void {
  active.clear()
  pendingKill.clear()
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryDeps = null
}

// ── Enumeration ────────────────────────────────────────────────────────────

export async function enumerateCommandsOffPane(cwd: string, deps: OffPaneDeps): Promise<OffPaneResult> {
  const t: OffPaneTiming = { ...DEFAULT_TIMING, ...deps.timing }
  const { tmux, sleep, now } = deps
  const homes = deps.homes ?? realHomes
  const session = (deps.sessionName ?? scrapeSessionName)()
  const deadline = now() + t.deadlineMs
  const expired = () => now() >= deadline
  const result = (status: OffPaneStatus, commands: CommandEntry[] = [], rowsPerPage = 0, detail?: string): OffPaneResult =>
    ({ status, commands, rowsPerPage, session, detail })

  await reapScrapeSessions(deps).catch(() => [])

  const rec: ScrapeRecord = { name: session, pane: "", tty: "", pid: 0, home: "" }
  active.set(session, rec)
  try {
    let home: ScrapeHome
    try {
      home = await homes.create(session, deps.launch, cwd)
      rec.home = home.root
    } catch (err) {
      return result("error", [], 0, `throwaway home: ${err instanceof Error ? err.message : String(err)}`)
    }

    const inner = buildScrapeInner(cwd, deps.launch, home)
    const created = await tmux(detachedNewSessionArgs(session, inner, "#{pane_id}\t#{pane_tty}\t#{pane_pid}")).catch(() => ({ code: -1, stdout: "" }))
    const [pane = "", tty = "", pid = ""] = created.stdout.trim().split("\t")
    Object.assign(rec, { pane, tty, pid: Number(pid) || 0 })
    // Marked before claude has booted far enough to do anything.
    markScrapeTarget(rec)
    if (created.code !== 0 || !/^%\d+$/.test(pane)) return result("error", [], 0, "tmux new-session failed")

    const capture = async (): Promise<string | null> => {
      const r = await tmux(["capture-pane", "-p", "-t", pane])
      return r.code === 0 ? r.stdout : null
    }
    // One failed capture is retried once (a tmux server busy for a beat);
    // two in a row is an error, never an empty page.
    const mustCapture = async (): Promise<string> => {
      const text = await capture()
      if (text !== null) return text
      await sleep(t.pollMs)
      const again = await capture()
      if (again === null) throw new ScrapeIOError("capture-pane failed mid-scrape")
      return again
    }
    const sendArgs = async (args: string[]): Promise<void> => {
      const r = await tmux(["send-keys", "-t", pane, ...args])
      if (r.code !== 0) throw new ScrapeIOError(`send-keys ${args.join(" ")} failed`)
    }
    const send = (key: string) => sendArgs([key])
    const sendLiteral = (text: string) => sendArgs(["-l", text])
    // Poll the pane until `ok` holds (or `ms` / the deadline passes).
    const waitFor = async (ok: (text: string) => boolean, ms: number): Promise<boolean> => {
      const until = Math.min(deadline, now() + ms)
      for (;;) {
        if (ok(await mustCapture())) return true
        if (now() >= until) return false
        await sleep(t.pollMs)
      }
    }

    const boot = await waitForPrompt(capture, sleep, now, t, deadline)
    if (boot !== "ready") return result(boot === "gone" ? "error" : boot, [], 0, `boot: ${boot === "gone" ? "pane never came up (claude exited?)" : boot}`)

    const all: CommandEntry[] = []
    const outcomes: Array<{ aborted: boolean; wrongTab: boolean; incomplete: boolean }> = []
    let rowsPerPage = 0
    const tabs: HelpTab[] = ["default", "custom"]
    for (const [i, tab] of tabs.entries()) {
      // A fresh /help per tab: once the list has focus, Tab stops switching.
      await sendLiteral("/help")
      await send("Enter")
      const enterAt = now()
      // /help opens on General; each Tab moves one tab right. Every step waits
      // for the screen to show it, so a slow paint never eats a Tab. A step
      // that never shows is left to scrapeHelpTab's wrong-tab check
      // (→ incomplete, never cached).
      if (await waitFor(helpOverlayVisible, t.helpOpenMs)) {
        for (const step of (tab === "default" ? ["default"] : ["default", "custom"]) as HelpTab[]) {
          await send("Tab")
          if (!(await waitFor((text) => helpTab(text) === step, t.tabSwitchMs))) break
        }
      }
      const scrape = await scrapeHelpTab({
        tab,
        capture: mustCapture,
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
    // Always, whatever happened above: no orphan cc-scrape-* sessions, no
    // leftover HOME. An unconfirmed kill stays tracked (and marked) until a
    // reap confirms it. Still `active` while finishing, so a concurrent reap
    // never races this one over the same session.
    await finishSession(rec, deps).catch(() => false)
    active.delete(session)
  }
}

type BootOutcome = "ready" | "wizard" | "timeout" | "gone"

async function waitForPrompt(
  capture: () => Promise<string | null>,
  sleep: (ms: number) => Promise<void>,
  now: () => number,
  t: OffPaneTiming,
  deadline: number,
): Promise<BootOutcome> {
  const bootDeadline = Math.min(deadline, now() + t.bootTimeoutMs)
  let misses = 0
  for (;;) {
    const text = await capture()
    if (text === null) {
      // The pane is created synchronously by new-session, so a capture that
      // keeps failing means it is gone — claude (or the shell) exited. Fail
      // fast instead of burning the boot timeout.
      if (++misses >= t.bootMissLimit) return "gone"
    } else {
      misses = 0
      if (paneBlockedByWizard(text)) return "wizard"
      if (paneInputReady(text)) {
        // Trust / onboarding dialogs overlay the input box a beat AFTER the
        // welcome box paints — look again before calling it a prompt.
        await sleep(t.bootSettleMs)
        const again = await capture()
        if (again === null) return "gone"
        if (paneBlockedByWizard(again)) return "wizard"
        return "ready"
      }
    }
    if (now() >= bootDeadline) return "timeout"
    await sleep(t.pollMs)
  }
}

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
