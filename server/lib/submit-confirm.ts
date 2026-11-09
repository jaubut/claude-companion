// Did an injected prompt actually get submitted?
//
// `tmux send-keys` exiting 0 only proves tmux accepted the bytes. A modal in
// the pane, a swallowed Enter or a TUI mid-redraw can eat the prompt, and the
// phone then shows a "Thinking" pill for a turn that never started (audit
// 2026-09-24: 3 injects into Zettlab pane %89 logged "delivered (tmux)" with
// no UserPromptSubmit hook and nothing in the transcript; ~30 lost
// historically).
//
// The proof of submission is Claude Code's own UserPromptSubmit hook for the
// same session. So an inject arms a watch BEFORE its Enter is sent (the hook
// can land before send-keys returns), waits up to SUBMIT_WINDOW_MS, presses
// Enter once more if nothing came, waits again, and otherwise reports
// `not_submitted` with a short pane excerpt.

import { keyGate } from "./key-gate"
import { companionLog } from "./log"
import { injectText, tmuxSendKeys, type InjectTarget } from "./keyboard-inject"
import { INJECT_SEND_MS, deliverViaHerdr, isHooklessInput } from "./herdr-inject"
import { type Herdr, herdrGateKey, herdrPaneOf, herdrSendKey, realHerdr } from "./herdr"
import { inputLine, unstyle } from "./command-menu"
import { type PaneRef, capturePane, paneKey, resolveTmuxRefFromTty, sendKeysArgs } from "./tmux-pane"
import { readClaudeSessionFile } from "./discover"

export const SUBMIT_WINDOW_MS = 3_000
// Text left the box but no hook yet: on a loaded host Claude Code runs its
// pre-prompt hooks before UserPromptSubmit reaches us — seen 6.6 s after the
// Enter on Zettlab (2026-10-03), past the 3 s window, so a delivered prompt was
// reported lost. One more wait in that case only. 3 s + this stays under the
// phone's 12 s inject timeout (the Enter-retry path skips it: it already waited
// a second window).
export const LATE_HOOK_GRACE_MS = 6_000

// Who a UserPromptSubmit hook (or a watch) is about. Any non-empty field that
// matches is enough: the hook's session key is derived from the same tty /
// session id the inject target was registered with.
export interface SubmitIdentity {
  key?: string
  sessionId?: string
  tty?: string
  // tmux pane id (%N): the one identity that survives /clear (new session id).
  // Bare id, as hooks report it; the tty beside it is unique per server-pty.
  pane?: string
}

// isHooklessInput lives in herdr-inject.ts (the herdr delivery needs it).
export { isHooklessInput }

// Timer seam so the tests drive the window with a fake clock.
export interface SubmitClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: SubmitClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface SubmitWatch {
  // Resolves true as soon as a matching hook has fired since the watch was
  // armed (immediately if one already did), false after `ms`.
  wait(ms: number, clock?: SubmitClock): Promise<boolean>
  close(): void
}

interface Watch {
  id: SubmitIdentity
  hits: number
  wake: (() => void) | null
  // Also resolved by a SessionEnd / SessionStart(clear) for the same session.
  boundary: boolean
  // The injected text; a hook with other text is the terminal's prompt.
  text?: string
  // A hook already got the "from the phone" flag for this watch.
  phoneSeen: boolean
}

const watches = new Set<Watch>()

function same(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a === b
}

function matches(w: SubmitIdentity, from: SubmitIdentity): boolean {
  return same(w.key, from.key) || same(w.sessionId, from.sessionId) || same(w.tty, from.tty) || same(w.pane, from.pane)
}

// No text on either side (older hook, text-less watch) → identity alone decides.
function sameText(injected: string | undefined, prompt: string | undefined): boolean {
  return injected === undefined || prompt === undefined || injected.trim() === prompt.trim()
}

// Called by the /hooks/user-prompt-submit route for every hook fire.
// Returns true when this hook consumes a phone origin (notePhoneOrigin) or is
// the first submit seen by a pending phone inject of a prompt (not a slash command / bash-mode input — those are
// armed with `boundary` and never reach Claude as a prompt): the route tells
// the hook so Claude gets a "sent from the phone" context note.
export function noteUserPromptSubmit(from: SubmitIdentity, prompt?: string, now: number = Date.now()): boolean {
  let fromPhone = takePhoneOrigin(from, prompt, now)
  for (const w of watches) {
    if (!matches(w.id, from)) continue
    if (!w.boundary && !w.phoneSeen && sameText(w.text, prompt)) fromPhone = w.phoneSeen = true
    w.hits++
    w.wake?.()
  }
  return fromPhone
}

// A phone prompt whose UserPromptSubmit hook has not come yet. Outlives the
// watch: a queued prompt fires its hook when Claude's turn ends, and the
// non-tmux delivery (AppleScript) arms no watch at all.
// ponytail: fixed TTL, a turn longer than this loses its phone note.
export const PHONE_ORIGIN_TTL_MS = 30 * 60_000
interface PhoneOrigin { id: SubmitIdentity; text: string; until: number }
const origins: PhoneOrigin[] = []

export function notePhoneOrigin(id: SubmitIdentity, text: string, now: number = Date.now()): { drop(): void } {
  const o: PhoneOrigin = { id, text, until: now + PHONE_ORIGIN_TTL_MS }
  origins.push(o)
  return { drop: () => { const i = origins.indexOf(o); if (i >= 0) origins.splice(i, 1) } }
}

// Consumes the oldest live origin matching this hook: same terminal/session,
// same text (a terminal prompt queued ahead must not take it), and never
// another session id on a reused tty.
function takePhoneOrigin(from: SubmitIdentity, prompt: string | undefined, now: number): boolean {
  for (let i = origins.length - 1; i >= 0; i--) if (origins[i]!.until <= now) origins.splice(i, 1)
  const i = origins.findIndex((o) =>
    matches(o.id, from) && sameText(o.text, prompt) && !(o.id.sessionId && from.sessionId && o.id.sessionId !== from.sessionId))
  if (i < 0) return false
  origins.splice(i, 1)
  return true
}

// Called by the SessionEnd hook and by SessionStart with source "clear": the
// session acted on a command (`/exit`, `/clear`). Only watches armed for a
// hookless input count it — a typed prompt is never "confirmed" by its
// session dying.
export function noteSessionBoundary(from: SubmitIdentity): void {
  // A pending phone prompt does not outlive its session.
  for (let i = origins.length - 1; i >= 0; i--) if (matches(origins[i]!.id, from)) origins.splice(i, 1)
  for (const w of watches) {
    if (!w.boundary || !matches(w.id, from)) continue
    w.hits++
    w.wake?.()
  }
}

export function watchSubmit(id: SubmitIdentity, opts: { boundary?: boolean; text?: string } = {}): SubmitWatch {
  const w: Watch = { id, hits: 0, wake: null, boundary: !!opts.boundary, text: opts.text, phoneSeen: false }
  watches.add(w)
  return {
    wait(ms, clock = realClock) {
      if (w.hits > 0) return Promise.resolve(true)
      // A zero window is a synchronous peek, not a timer (the fake test clock
      // would never fire it).
      if (ms <= 0) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        const done = (seen: boolean) => {
          w.wake = null
          clock.clearTimeout(timer)
          resolve(seen)
        }
        const timer = clock.setTimeout(() => done(false), ms)
        w.wake = () => done(true)
      })
    },
    close() {
      w.wake = null
      watches.delete(w)
    },
  }
}

// Tests only.
export function activeWatchCount(): number {
  return watches.size
}

export type ConfirmResult =
  | { ok: true; confirmed: true; retried: boolean }
  // No hook, but the pane shows Claude mid-turn AND our text sitting in its
  // queue: Claude Code queues a prompt typed during a turn and fires the hook
  // when the turn ends. Both are read from a fresh capture — a cached "busy"
  // status is not evidence (review of PR #51).
  | { ok: true; confirmed: false; queued: true }
  // A slash command / bash-mode input with no hook and no session boundary:
  // delivered, and unconfirmable by design — never a failure.
  | { ok: true; confirmed: false; command: true }
  | { ok: false; error: "not_submitted"; excerpt: string }

// Mid-turn, Claude Code holds a typed prompt until the next tool boundary and
// only then fires UserPromptSubmit — seconds after any fixed window (log
// 2026-09-25: 6/6 "not submitted" verdicts got their hook 2–9 s late) — and
// the pane need not show the text anywhere. So Claude Code's own session
// status, read fresh at verdict time, is the queued signal; the pane
// heuristic below stays as the fallback.
export interface ConfirmDeps {
  watch: SubmitWatch
  // The injected text: the retry only fires while it is still in the box.
  text: string
  pressEnter: () => Promise<boolean>
  // A bounded `capture-pane -e` (null on failure/timeout).
  capture: () => Promise<string | null>
  // Fresh read of Claude Code's `status` for the session: true while "busy".
  busy?: () => Promise<boolean>
  // The text is a slash command or `!` bash-mode input (isHooklessInput).
  hookless?: boolean
  windowMs?: number
  // Extra wait when our text left the box but no hook came (LATE_HOOK_GRACE_MS).
  lateGraceMs?: number
  clock?: SubmitClock
}

const BUSY_RE = /esc to interrupt/i
// A numbered picker or a yes/no confirm. An Enter here answers it.
const PICKER_RE = /^\s*❯\s*\d+\.|Do you want to/m

// Last few non-blank lines of the pane, capped — enough for the phone to show
// what ate the prompt (a modal, a picker) without shipping the scrollback.
export function paneExcerpt(pane: string | null, lines = 8, maxChars = 600): string {
  if (!pane) return ""
  const tail = unstyle(pane).split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-lines).join("\n")
  return tail.length > maxChars ? tail.slice(-maxChars) : tail
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

// The first characters of the injected text, whitespace-folded. Long text
// wraps in the box, so only a prefix is compared.
function textPrefix(text: string): string {
  return norm(text).slice(0, 16)
}

// Our text is still typed (not dim) on the input line: the Enter was lost.
function stillInBox(pane: string, prefix: string): boolean {
  const typed = inputLine(pane)
  return !!prefix && !!typed && norm(typed).startsWith(prefix)
}

// Claude is mid-turn and our text shows above the box (the queued-prompt
// list), not only on the input line.
function queuedBehindTurn(pane: string, prefix: string): boolean {
  const plain = unstyle(pane)
  if (!prefix || !BUSY_RE.test(plain)) return false
  const lines = plain.split("\n")
  let promptIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) if (/^❯/.test(lines[i] ?? "")) { promptIdx = i; break }
  return lines.slice(0, promptIdx < 0 ? lines.length : promptIdx).some((l) => norm(l).includes(prefix))
}

export async function confirmSubmit(deps: ConfirmDeps): Promise<ConfirmResult> {
  const r = await confirmTyped(deps)
  if (!r.ok && deps.hookless) return { ok: true, confirmed: false, command: true }
  return r
}

async function confirmTyped(deps: ConfirmDeps): Promise<ConfirmResult> {
  const windowMs = deps.windowMs ?? SUBMIT_WINDOW_MS
  const prefix = textPrefix(deps.text)
  if (await deps.watch.wait(windowMs, deps.clock)) return { ok: true, confirmed: true, retried: false }

  const before = await deps.capture()
  if (before === null) return { ok: false, error: "not_submitted", excerpt: "" }
  // The hook may have landed while we were capturing: never press a spurious
  // Enter into an idle box.
  if (await deps.watch.wait(0, deps.clock)) return { ok: true, confirmed: true, retried: false }

  // Retry ONLY when our own text is visibly sitting unsent in the input box
  // and nothing modal is on screen. Anything else — an empty box, a picker, a
  // panel — means the text went somewhere else, and an Enter there would
  // answer a prompt nobody chose (review of PR #51, item 1).
  let retried = false
  if (stillInBox(before, prefix) && !PICKER_RE.test(unstyle(before))) {
    retried = true
    await deps.pressEnter()
    if (await deps.watch.wait(windowMs, deps.clock)) return { ok: true, confirmed: true, retried: true }
  }

  const after = await deps.capture()
  if (after !== null && queuedBehindTurn(after, prefix)) return { ok: true, confirmed: false, queued: true }
  // A picker still means the text went into it, busy or not.
  const last = after ?? before
  if (!PICKER_RE.test(unstyle(last)) && (await deps.busy?.())) return { ok: true, confirmed: false, queued: true }
  // Our text is gone from the input line and nothing modal took it: it was
  // most likely submitted and the hook is just late. Wait once more.
  // Never for hookless input (/cmd, !cmd): no hook is coming.
  if (!deps.hookless && !retried && after !== null && !PICKER_RE.test(unstyle(after)) && !stillInBox(after, prefix)) {
    if (await deps.watch.wait(deps.lateGraceMs ?? LATE_HOOK_GRACE_MS, deps.clock)) return { ok: true, confirmed: true, retried: false }
  }
  return { ok: false, error: "not_submitted", excerpt: paneExcerpt(after ?? before) }
}

// What the inject routes answer with.
export type InjectOutcome =
  | { ok: true; confirmed: boolean; retried?: boolean; queued?: boolean; command?: boolean }
  | { ok: false; error: "deliver_failed" }
  | { ok: false; error: "not_submitted"; excerpt: string }
  // herdr refused the prompt: the agent sits at an approval/question
  // (agent_blocked). Same code as the pre-inject pane_not_ready refusal.
  | { ok: false; error: "pane_not_ready"; reason: "agent_blocked"; excerpt: string }

// Should the inject route write the user_prompt feed event (and start the
// "Thinking" pill) itself? Only when nothing else will: a delivery that
// cannot be confirmed (no tmux pane — the macOS AppleScript path, where
// issue #8 saw the hook go missing). A confirmed inject already has its
// event from the hook, a queued one gets it when the turn ends, and an
// unsubmitted one must not show as sent at all (audit 2026-09-24: this
// echo is what put a "Thinking" pill on three prompts Claude never got).
// A slash command / bash-mode input is never echoed either: it starts no
// turn, so a "Thinking" pill for it would never end.
export function echoPromptOnInject(res: InjectOutcome): boolean {
  return res.ok && !res.confirmed && !res.queued && !res.command
}

// Why a delivery failed, for the log and the phone. macOS has two paths
// (tmux, then an AppleScript paste that needs Accessibility); Linux has only
// tmux, so a session outside tmux cannot be typed into at all — relaunching
// it inside tmux (`cc-tmux`) is the fix, not a macOS permission.
export function deliveryFailedHint(platform: string = process.platform): string {
  return platform === "darwin"
    ? "tmux send-keys failed, or osascript: Accessibility permission?"
    : "session is not running inside tmux — relaunch it in tmux (e.g. cc-tmux) so the phone can type into it"
}

export interface ConfirmTarget extends InjectTarget {
  key?: string
  sessionId?: string
  agent?: string
  agentStatus?: string
  pid?: string
}

// A pane we can both re-press Enter in and read back. Linux sessions without
// a recorded pane resolve it from the tty, as injectText does.
async function confirmPane(target: ConfirmTarget): Promise<PaneRef | null> {
  const pane = target.tmuxPane?.trim() ?? ""
  if (/^%\d+$/.test(pane)) return { pane, socket: target.tmuxSocket ?? "" }
  if (target.tty && process.platform === "linux") return resolveTmuxRefFromTty(target.tty)
  return null
}

function pressEnterIn(ref: PaneRef): () => Promise<boolean> {
  return async () => {
    try {
      const r = await keyGate.send(paneKey(ref.pane, ref.socket), "Enter", (signal) => tmuxSendKeys(sendKeysArgs(ref, "Enter"), 2000, signal), { timeoutMs: INJECT_SEND_MS })
      return r.ok
    } catch {
      return false
    }
  }
}

// injectText + submit confirmation. Only Claude sessions in a tmux pane are
// confirmed: that is where the hook is guaranteed and the pane is readable.
// Everything else keeps the old "delivered = sent" answer (confirmed: false).
const CAPTURE_TIMEOUT_MS = 1_500

// One send-and-confirm at a time per pane: a hook matches its watch by
// session, so two overlapping injects into one pane could each be "confirmed"
// by the other's hook. Serialising the whole lifecycle, and arming the watch
// only once this inject holds the pane, gives every hook exactly one owner.
// A hook from the user typing locally in that window can still confirm — the
// hook carries no text to tell them apart.
const paneLocks = new Map<string, Promise<unknown>>()
function withPaneLock<T>(pane: string, fn: () => Promise<T>): Promise<T> {
  const prev = paneLocks.get(pane) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  const tail = next.catch(() => undefined)
  paneLocks.set(pane, tail)
  void tail.then(() => { if (paneLocks.get(pane) === tail) paneLocks.delete(pane) })
  return next
}

// injectText + submit confirmation. Only Claude sessions in a tmux pane are
// confirmed: that is where the hook is guaranteed and the pane is readable.
// Everything else keeps the old "delivered = sent" answer (confirmed: false).
// `herdr` is a test seam.
// A Claude prompt (not /cmd or !cmd) is recorded as a phone origin until its
// hook consumes it; a failed or already-confirmed inject drops the record.
export async function injectConfirmed(text: string, target: ConfirmTarget | undefined, herdr: Herdr = realHerdr): Promise<InjectOutcome> {
  const origin = target && (target.agent ?? "claude") === "claude" && !isHooklessInput(text)
    ? notePhoneOrigin({ key: target.key, sessionId: target.sessionId, tty: target.tty }, text)
    : null
  const res = await injectRouted(text, target, herdr)
  if (origin && (!res.ok || res.confirmed)) origin.drop()
  return res
}

async function injectRouted(text: string, target: ConfirmTarget | undefined, herdr: Herdr): Promise<InjectOutcome> {
  const herdrPane = herdrPaneOf(target)
  if (target && herdrPane) return injectHerdr(text, target, herdrPane, herdr)
  const ref = target && (target.agent ?? "claude") === "claude" ? await confirmPane(target) : null
  if (!target || !ref) {
    return (await injectText(text, target)) ? { ok: true, confirmed: false } : { ok: false, error: "deliver_failed" }
  }
  // (socket, pane) is the lock's identity: two servers' panes sharing an id
  // are two keyboards.
  const pane = paneKey(ref.pane, ref.socket)
  return withPaneLock(pane, async (): Promise<InjectOutcome> => {
    const hookless = isHooklessInput(text)
    const watch = watchSubmit({ key: target.key, sessionId: target.sessionId, tty: target.tty, pane: ref.pane }, { boundary: hookless, text })
    try {
      if (!(await injectText(text, { ...target, tmuxPane: ref.pane, tmuxSocket: ref.socket }))) return { ok: false, error: "deliver_failed" }
      const r = await confirmSubmit({
        watch,
        text,
        pressEnter: pressEnterIn(ref),
        capture: () => capturePane(ref.pane, AbortSignal.timeout(CAPTURE_TIMEOUT_MS), { escapes: true, socket: ref.socket }),
        busy: busyOf(target),
        hookless,
      })
      return confirmOutcome(r, pane)
    } finally {
      watch.close()
    }
  })
}

const busyOf = (target: ConfirmTarget) => async () => !!target.pid && (await readClaudeSessionFile(target.pid))?.status === "busy"

function confirmOutcome(r: ConfirmResult, where: string): InjectOutcome {
  const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"; const green = "\x1b[32m"; const yellow = "\x1b[33m"
  const line = !r.ok ? `${red}not submitted${reset} — no UserPromptSubmit hook`
    : r.confirmed ? `${green}submit confirmed${reset}${r.retried ? " (after Enter retry)" : ""}`
    : "command" in r ? `${dim}command sent${reset} — slash / bash-mode input fires no UserPromptSubmit (unconfirmable, not an error)`
    : `${yellow}submit queued${reset} — Claude mid-turn, text in its queue`
  companionLog(`${line} → ${where}`)
  if (!r.ok) return r
  if (r.confirmed) return { ok: true, confirmed: true, retried: r.retried }
  return "command" in r ? { ok: true, confirmed: false, command: true } : { ok: true, confirmed: false, queued: true }
}

// The herdr twin of the tmux path above: same pane lock, same watch armed
// before the Enter, same confirmSubmit (#51). Delivery is `herdr agent
// prompt`; the Enter retry and the read-back go through `pane send-keys` /
// `pane read`. Never AppleScript.
async function injectHerdr(text: string, target: ConfirmTarget, pane: string, h: Herdr): Promise<InjectOutcome> {
  const where = herdrGateKey(pane)
  return withPaneLock(where, async (): Promise<InjectOutcome> => {
    const hookless = isHooklessInput(text)
    const watch = watchSubmit({ key: target.key, sessionId: target.sessionId, tty: target.tty }, { boundary: hookless, text })
    try {
      const d = await deliverViaHerdr(pane, text, { typed: hookless, herdr: h })
      if (!d.ok) {
        companionLog(`\x1b[31mdeliver failed\x1b[0m (herdr ${pane}) — ${d.reason}`)
        if (!d.blocked) return { ok: false, error: "deliver_failed" }
        return { ok: false, error: "pane_not_ready", reason: "agent_blocked", excerpt: paneExcerpt(await h.read(pane)) }
      }
      companionLog(`\x1b[32mdelivered (herdr)\x1b[0m → ${pane}`)
      if ((target.agent ?? "claude") !== "claude") return { ok: true, confirmed: false }
      const r = await confirmSubmit({
        watch,
        text,
        pressEnter: async () => {
          try {
            return await keyGate.send(where, "Enter", () => herdrSendKey(pane, "Enter", h), { timeoutMs: INJECT_SEND_MS })
          } catch {
            return false
          }
        },
        capture: () => h.read(pane),
        busy: busyOf(target),
        hookless,
      })
      return confirmOutcome(r, where)
    } finally {
      watch.close()
    }
  })
}
