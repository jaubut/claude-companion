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
// user — scraped with the same /help parser (lib/command-list.ts), then killed
// and confirmed dead. The user's pane receives zero keystrokes.
//
// The hidden claude is side-effect free:
//   - `--settings {"disableAllHooks":true}` — none of the user's hooks run
//     (companion hooks included) and no status line command runs. Verified on
//     2.1.284: /hooks in the hidden pane reads "disabled · 34 hooks not
//     running";
//   - `--strict-mcp-config --mcp-config {"mcpServers":{}}` — no user/project MCP
//     server is started;
//   - COMPANION_SCRAPE=1 + CLAUDE_CODE_SCRAPE_SESSION=1 exported, so any hook
//     that still runs (a managed-settings hook, stale scripts) can bail;
//   - DISABLE_AUTOUPDATER=1 — a hidden process never swaps the install;
//   - `--session-id <uuid>` so, should a transcript ever be written, the exact
//     file is known and deleted after the kill (none is written today: /help
//     is a local command, no message is ever sent);
//   - lib/scrape-registry.ts drops anything from its pane/tty server-side.
//
// Cached per fingerprint (cwd + claude binary + version + mtimes of every file
// the list is built from), with a 24h safety TTL.

import { randomUUID } from "node:crypto"
import { readdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { closeHelpOverlay, HELP_CLOSE_OPEN_WAIT_MS, HELP_PAINT_MS, listIncomplete, scrapeHelpTab, type CommandEntry, type HelpTab } from "./command-list"
import { paneHasDialog, paneInputReady } from "./tmux-pane"
import { isScrapeSessionName, markScrapeTarget, releaseScrapeTarget, SCRAPE_ENV, SCRAPE_ENV_CLAUDE, scrapeSessionName } from "./scrape-registry"
import { detachedNewSessionArgs } from "./spawn-session"
import {
  claudeVersion, computeFingerprint, defaultTmux, defaultWhich, resolveClaudeLaunch,
  type ClaudeLaunch, type TmuxRunner,
} from "./command-offpane-launch"

export type { ClaudeLaunch, TmuxResult, TmuxRunner } from "./command-offpane-launch"

export interface OffPaneTiming {
  bootTimeoutMs: number   // claude has this long to show its input box
  bootSettleMs: number    // onboarding/MCP dialogs paint AFTER the welcome box
  bootMissLimit: number   // consecutive failed captures before the pane counts as gone
  deadlineMs: number      // whole enumeration, boot included
  pollMs: number
  helpPaintMs: number
  tabSwitchMs: number
  keyMs: number
  pageSettleMs: number
  killAttempts: number
  killRetryMs: number
}

export const DEFAULT_TIMING: OffPaneTiming = {
  bootTimeoutMs: 30_000,
  bootSettleMs: 1_000,
  bootMissLimit: 3,
  deadlineMs: 120_000,
  pollMs: 150,
  helpPaintMs: HELP_PAINT_MS,
  tabSwitchMs: 700,
  // One Down per send-keys: a batch was seen to drop keys mid-repaint.
  keyMs: 45,
  pageSettleMs: 600,
  killAttempts: 5,
  killRetryMs: 200,
}

export interface OffPaneDeps {
  tmux: TmuxRunner
  sleep: (ms: number) => Promise<void>
  now: () => number
  launch: ClaudeLaunch
  timing?: Partial<OffPaneTiming>
  sessionName?: () => string
  sessionId?: () => string
  // Deletes `<configDir>/projects/*/<id>.jsonl` if one appeared.
  removeTranscript?: (configDir: string, sessionId: string) => Promise<void>
}

export type OffPaneStatus =
  | "ok"          // whole list read — cacheable
  | "incomplete"  // page budget ran out or a tab bailed — serve, don't cache
  | "wizard"      // first-run wizard / trust / login dialog in the hidden session
  | "timeout"     // deadline hit (boot or paging)
  | "error"       // tmux failed, a capture/send failed, claude missing or exited
  | "pending"     // (lister only) still running; the caller stopped waiting

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
const NO_HOOKS = JSON.stringify({ disableAllHooks: true })

// The command tmux runs in the hidden session. `exec` so the pane (and the
// session) dies with claude — a crashed claude reads as a vanished pane.
export function buildScrapeInner(cwd: string, launch: ClaudeLaunch, sessionId: string): string {
  const exports = [
    `export ${SCRAPE_ENV}=1`,
    `export ${SCRAPE_ENV_CLAUDE}=1`,
    "export DISABLE_AUTOUPDATER=1",
    ...Object.entries(launch.env).map(([k, v]) => `export ${k}=${shq(v)}`),
  ]
  const argv = [
    shq(launch.bin),
    "--strict-mcp-config", "--mcp-config", shq(EMPTY_MCP),
    "--settings", shq(NO_HOOKS),
    "--session-id", shq(sessionId),
  ]
  return `${exports.join("; ")}; cd ${shq(cwd)} && exec ${argv.join(" ")}`
}

// ── Session lifecycle ──────────────────────────────────────────────────────

// Sessions currently being driven by THIS process — never reaped from under it.
const active = new Set<string>()
// Killed but not yet confirmed dead: stays marked in the registry and is
// retried by every reap until tmux says it is gone.
const pendingKill = new Map<string, { pane: string; tty: string }>()
let retryTimer: ReturnType<typeof setTimeout> | null = null
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

// Kill every cc-scrape-* session this process is not using right now: leftovers
// from a crashed or restarted server, and kills that were not confirmed.
export async function reapScrapeSessions(
  tmux: TmuxRunner = defaultTmux, sleep: (ms: number) => Promise<void> = realSleep,
): Promise<string[]> {
  const r = await tmux(["list-sessions", "-F", "#{session_name}"])
  const listed = r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()) : []
  const names = new Set([...listed.filter(isScrapeSessionName), ...pendingKill.keys()])
  const reaped: string[] = []
  for (const name of names) {
    if (active.has(name)) continue
    if (await killScrapeSession(tmux, name, sleep)) {
      const target = pendingKill.get(name)
      pendingKill.delete(name)
      if (target) releaseScrapeTarget(target)
      if (listed.includes(name)) reaped.push(name)
    }
  }
  return reaped
}

function schedulePendingRetry(tmux: TmuxRunner): void {
  if (retryTimer || pendingKill.size === 0) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void reapScrapeSessions(tmux).catch(() => []).finally(() => schedulePendingRetry(tmux))
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
}

export async function removeTranscriptFile(configDir: string, sessionId: string): Promise<void> {
  const root = join(configDir, "projects")
  let dirs: string[] = []
  try { dirs = await readdir(root) } catch { return }
  await Promise.all(dirs.map((d) => unlink(join(root, d, `${sessionId}.jsonl`)).catch(() => undefined)))
}

// ── Enumeration ────────────────────────────────────────────────────────────

export async function enumerateCommandsOffPane(cwd: string, deps: OffPaneDeps): Promise<OffPaneResult> {
  const t: OffPaneTiming = { ...DEFAULT_TIMING, ...deps.timing }
  const { tmux, sleep, now } = deps
  const session = (deps.sessionName ?? scrapeSessionName)()
  const sessionId = (deps.sessionId ?? randomUUID)()
  const deadline = now() + t.deadlineMs
  const expired = () => now() >= deadline
  const result = (status: OffPaneStatus, commands: CommandEntry[] = [], rowsPerPage = 0, detail?: string): OffPaneResult =>
    ({ status, commands, rowsPerPage, session, detail })

  await reapScrapeSessions(tmux, sleep).catch(() => [])

  active.add(session)
  const inner = buildScrapeInner(cwd, deps.launch, sessionId)
  const created = await tmux(detachedNewSessionArgs(session, inner, "#{pane_id} #{pane_tty}")).catch(() => ({ code: -1, stdout: "" }))
  const [pane = "", tty = ""] = created.stdout.trim().split(/\s+/)
  const target = { pane, tty }
  // Marked before claude has booted far enough to do anything.
  markScrapeTarget(target)
  try {
    if (created.code !== 0 || !/^%\d+$/.test(pane)) return result("error", [], 0, "tmux new-session failed")

    const capture = async (): Promise<string | null> => {
      const r = await tmux(["capture-pane", "-p", "-t", pane])
      return r.code === 0 ? r.stdout : null
    }
    const mustCapture = async (): Promise<string> => {
      const text = await capture()
      if (text === null) throw new ScrapeIOError("capture-pane failed mid-scrape")
      return text
    }
    const sendArgs = async (args: string[]): Promise<void> => {
      const r = await tmux(["send-keys", "-t", pane, ...args])
      if (r.code !== 0) throw new ScrapeIOError(`send-keys ${args.join(" ")} failed`)
    }
    const send = (key: string) => sendArgs([key])
    const sendLiteral = (text: string) => sendArgs(["-l", text])

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
      await sleep(t.helpPaintMs)
      for (let k = 0; k < (tab === "default" ? 1 : 2); k++) {
        await send("Tab")
        await sleep(t.tabSwitchMs)
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
    // Always, whatever happened above: no orphan cc-scrape-* sessions. An
    // unconfirmed kill stays tracked (and marked) until a reap confirms it.
    const dead = await killScrapeSession(tmux, session, sleep, t.killAttempts, t.killRetryMs).catch(() => false)
    active.delete(session)
    if (dead) {
      releaseScrapeTarget(target)
    } else {
      pendingKill.set(session, target)
      schedulePendingRetry(tmux)
    }
    await (deps.removeTranscript ?? removeTranscriptFile)(deps.launch.configDir, sessionId).catch(() => undefined)
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

// ── Cache, de-duplication, concurrency ─────────────────────────────────────

export interface PreparedList {
  fingerprint: string
  enumerate: () => Promise<OffPaneResult>
}

export interface ListerDeps {
  // Resolve claude + fingerprint for a cwd. An `error` result (claude not
  // on PATH) is answered at once, never after a timeout.
  prepare: (cwd: string) => Promise<PreparedList | { error: string }>
  now?: () => number
  ttlMs?: number
  maxParallel?: number
  // How long one request waits for a running enumeration before answering
  // "retry later". The enumeration keeps going and caches when it lands.
  waitMs?: number
}

export interface ListOutcome {
  cached: boolean
  result: OffPaneResult
}

// A safety net only: the fingerprint catches every change we know of; this
// catches the ones we don't (a plugin updated in place, a new built-in behind
// a server-side flag).
export const LIST_TTL_MS = 24 * 60 * 60 * 1000
// Under the iOS client's 60s request timeout, with room for the response.
export const LIST_WAIT_MS = 50_000
export const MAX_PARALLEL = 2

const errResult = (status: OffPaneStatus, detail: string): OffPaneResult => ({ status, commands: [], rowsPerPage: 0, session: "", detail })

// - A hit needs the same fingerprint and < 24h age: nothing changed, nothing re-runs.
// - Concurrent callers for the same fingerprint share one enumeration (the
//   phone warms on every session activation — two sessions in one project
//   must not spawn two claudes).
// - Different fingerprints run in parallel, at most `maxParallel` at a time:
//   each is a full claude process.
export function createCommandLister(deps: ListerDeps) {
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? LIST_TTL_MS
  const maxParallel = Math.max(1, deps.maxParallel ?? MAX_PARALLEL)
  const waitMs = deps.waitMs ?? LIST_WAIT_MS
  const cache = new Map<string, { fp: string; at: number; commands: CommandEntry[] }>()
  const inflight = new Map<string, Promise<OffPaneResult>>()
  let running = 0
  const queue: Array<() => void> = []

  const limit = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (running >= maxParallel) await new Promise<void>((r) => queue.push(r))
    running++
    try {
      return await fn()
    } finally {
      running--
      queue.shift()?.()
    }
  }

  async function list(cwd: string, opts: { force?: boolean } = {}): Promise<ListOutcome> {
    let prep: PreparedList | { error: string }
    try { prep = await deps.prepare(cwd) } catch (err) { prep = { error: err instanceof Error ? err.message : String(err) } }
    if ("error" in prep) return { cached: false, result: errResult("error", prep.error) }
    const fp = prep.fingerprint

    const hit = cache.get(cwd)
    if (hit && !opts.force && hit.fp === fp && now() - hit.at < ttl) {
      return { cached: true, result: { status: "ok", commands: hit.commands, rowsPerPage: 0, session: "" } }
    }

    let job = inflight.get(fp)
    if (!job) {
      const run = prep.enumerate
      job = limit(run)
        .catch((err): OffPaneResult => errResult("error", err instanceof Error ? err.message : String(err)))
        .then((res) => {
          // Only a whole list is cached: a partial one would be served until
          // the next skill change.
          if (res.status === "ok" && res.commands.length) cache.set(cwd, { fp, at: now(), commands: res.commands })
          return res
        })
        .finally(() => inflight.delete(fp))
      inflight.set(fp, job)
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const gaveUp = new Promise<OffPaneResult>((r) => {
      timer = setTimeout(() => r(errResult("pending", `still enumerating after ${waitMs}ms`)), waitMs)
    })
    try {
      return { cached: false, result: await Promise.race([job, gaveUp]) }
    } finally {
      clearTimeout(timer)
    }
  }

  return { list, clear: () => cache.clear() }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Launch resolution is memoised briefly: the phone warms every session at
// once, and each would otherwise ask tmux for its environment.
const LAUNCH_TTL_MS = 60_000
let launchMemo: { at: number; value: ClaudeLaunch | null } | null = null
async function currentLaunch(): Promise<ClaudeLaunch | null> {
  if (launchMemo && Date.now() - launchMemo.at < LAUNCH_TTL_MS) return launchMemo.value
  const value = await resolveClaudeLaunch({ tmux: defaultTmux, which: defaultWhich, processEnv: process.env, home: homedir() })
  launchMemo = { at: Date.now(), value }
  return value
}

export async function prepareRealList(cwd: string): Promise<PreparedList | { error: string }> {
  const launch = await currentLaunch()
  if (!launch) return { error: "claude not on PATH (tmux server env or usual install dirs)" }
  const version = await claudeVersion(launch)
  return {
    fingerprint: await computeFingerprint(cwd, launch, version),
    enumerate: () => enumerateCommandsOffPane(cwd, { tmux: defaultTmux, sleep: realSleep, now: Date.now, launch }),
  }
}

export const commandLister = createCommandLister({ prepare: prepareRealList })
