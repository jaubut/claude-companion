// Inject text into a specific Claude Code terminal via clipboard + osascript.
//
// Without a target, falls back to the previous behavior — paste into whatever
// macOS app is frontmost. With a target, focuses the owning terminal first
// (iTerm or macOS Terminal, matched by tty) so multi-session users can pick
// which instance their reply lands in.

import { companionLog } from "./log"
import { keyGate } from "./key-gate"
import { deliverViaTmux, tmuxSendKeys, TMUX_PANE_RE, type TmuxSender } from "./tmux-inject"
export { deliverViaTmux, tmuxSendKeys, type TmuxResult } from "./tmux-inject"
import { type PaneRef, paneKey, resolveTmuxRefFromTty, tmuxArgv, tmuxSocketFlags } from "./tmux-pane"
import { type Herdr, herdrGateKey, herdrPaneOf } from "./herdr"
import { INJECT_QUEUE_MS, INJECT_SEND_MS, deliverViaHerdr, herdrPickerIO } from "./herdr-inject"

export interface InjectTarget {
  tty?: string
  termProgram?: string
  iTermSessionId?: string
  // When the target session is running inside tmux, this is the pane id
  // (e.g. "%12"). Routing by pane id avoids the AppleScript focus race
  // entirely — tmux's server holds the pty master and emits a real Enter
  // key event that Ink's TUI treats as a true keypress (raw \n via stdin
  // does not, see claude-code issue #15553).
  tmuxPane?: string
  // The tmux server that pane is on ($TMUX's socket path); "" / absent = the
  // default server. Pane ids are only unique per server (lib/tmux-pane.ts).
  tmuxSocket?: string
  // herdr pane ($HERDR_PANE_ID). Used only when there is no tmuxPane: text
  // goes through `herdr agent prompt`, keys through `herdr pane send-keys`.
  herdrPane?: string
}

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

interface OsaResult {
  ok: boolean
  stdout: string
  stderr: string
  exitCode: number
}

async function runOsa(script: string, signal?: AbortSignal): Promise<OsaResult> {
  try {
    signal?.throwIfAborted()
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const kill = () => { try { proc.kill() } catch { /* already exited */ } }
    signal?.addEventListener("abort", kill, { once: true })
    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      await proc.exited
      const code = proc.exitCode ?? 0
      return { ok: code === 0 && !signal?.aborted, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code }
    } finally { signal?.removeEventListener("abort", kill) }
  } catch (err) {
    return { ok: false, stdout: "", stderr: String(err), exitCode: -1 }
  }
}

// The AppleScripts below explicitly return "MATCH" on hit and "MISS" on no
// match, so JS can tell the difference — previously the `repeat` loops exited
// with code 0 on miss, silently reporting success.
async function focusTerminal(target: InjectTarget): Promise<boolean> {
  const tty = target.tty?.trim()
  if (!tty) return false

  const ttyEscaped = escapeForAppleScript(tty)
  const program = (target.termProgram ?? "").toLowerCase()

  async function tryITerm(): Promise<boolean> {
    const r = await runOsa(`
      tell application "iTerm"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${ttyEscaped}" then
                select s
                tell w to select
                return "MATCH"
              end if
            end repeat
          end repeat
        end repeat
        return "MISS"
      end tell
    `)
    return r.ok && r.stdout === "MATCH"
  }

  async function tryTerminal(): Promise<boolean> {
    // Terminal.app quirk: `set frontmost of window to true` is accepted
    // silently but does not raise the window in recent macOS. `set index of
    // window to 1` actually moves it to the front and gets frontmost=true.
    const r = await runOsa(`
      tell application "Terminal"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            if tty of t is "${ttyEscaped}" then
              set selected of t to true
              set index of w to 1
              return "MATCH"
            end if
          end repeat
        end repeat
        return "MISS"
      end tell
    `)
    return r.ok && r.stdout === "MATCH"
  }

  // Prefer the app the hook reported, but fall through to the other — users
  // with multiple terminal apps can have stale termProgram metadata.
  if (program.includes("iterm")) {
    if (await tryITerm()) return true
    if (await tryTerminal()) return true
    return false
  }
  if (program.includes("apple_terminal") || program.includes("terminal")) {
    if (await tryTerminal()) return true
    if (await tryITerm()) return true
    return false
  }
  // No hint: try both, only touch apps that are already running so we don't
  // wake up iTerm on a Terminal-only setup.
  const r = await runOsa(`
    tell application "System Events"
      set iTermRunning to (name of processes) contains "iTerm2"
      set terminalRunning to (name of processes) contains "Terminal"
    end tell
    if terminalRunning then
      try
        tell application "Terminal"
          activate
          repeat with w in windows
            repeat with t in tabs of w
              if tty of t is "${ttyEscaped}" then
                set selected of t to true
                set index of w to 1
                return "MATCH"
              end if
            end repeat
          end repeat
        end tell
      end try
    end if
    if iTermRunning then
      try
        tell application "iTerm"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if tty of s is "${ttyEscaped}" then
                  select s
                  tell w to select
                  activate
                  return "MATCH"
                end if
              end repeat
            end repeat
          end repeat
        end tell
      end try
    end if
    return "MISS"
  `)
  return r.ok && r.stdout === "MATCH"
}

// Targeted delivery — write directly to the specific tab's pty via Terminal's
// `do script` or iTerm's `write text`. No clipboard, no focus, no frontmost
// race. Works regardless of which window is visually active.
async function deliverToTty(target: InjectTarget, text: string, canDeliver?: () => boolean, signal?: AbortSignal): Promise<boolean> {
  const tty = target.tty?.trim()
  if (!tty) return false
  const ttyEscaped = escapeForAppleScript(tty)
  const textEscaped = escapeForAppleScript(text)
  const program = (target.termProgram ?? "").toLowerCase()

  async function tryTerminal(): Promise<boolean> {
    if (canDeliver && !canDeliver()) return false
    // Guarded delivery separates text from Enter, rechecking identity after focus
    // settles. Both stages verify the front tty; unguarded callers keep one script.
    const r = await runOsa(`
      tell application "Terminal"
        activate
        set matchedTab to false
        repeat with w in windows
          repeat with t in tabs of w
            if tty of t is "${ttyEscaped}" then
              do script "${textEscaped}" in t
              set selected of t to true
              set index of w to 1
              set matchedTab to true
              exit repeat
            end if
          end repeat
          if matchedTab is true then exit repeat
        end repeat
        if matchedTab is false then return "MISS"
      end tell
      delay 0.08
      tell application "System Events"
        tell process "Terminal"
          set frontmost to true
          try
            perform action "AXRaise" of window 1
          end try
          -- Extended poll — up to 1.2s for focus to settle. On a cold switch
          -- between two Terminal windows this routinely takes >400ms.
          repeat with i from 1 to 60
            try
              if focused of window 1 is true then exit repeat
            end try
            delay 0.02
          end repeat
        end tell
        delay 0.12
      end tell

      -- Now verify the front tab's tty actually matches our target. If the
      -- AXRaise didn't win the race, bail out WITHOUT sending Enter — the
      -- alternative is sending Enter into a random session.
      set frontTty to ""
      try
        tell application "Terminal"
          set frontTty to tty of selected tab of front window
        end tell
      end try
      if frontTty is not "${ttyEscaped}" then return "WRONG_WINDOW:" & frontTty

      ${canDeliver ? "" : `tell application "System Events"
        keystroke return
      end tell`}
      return "MATCH"
    `, signal)
    if (!r.ok) return false
    if (r.stdout.startsWith("WRONG_WINDOW")) {
      const reset = "\x1b[0m"; const red = "\x1b[31m"
      companionLog(`${red}inject refused${reset} — front tty ${r.stdout.slice(13)} doesn't match target ${tty} (focus race; retry)`)
      return false
    }
    if (!canDeliver || r.stdout !== "MATCH") return r.stdout === "MATCH"
    if (!canDeliver()) return false
    const submitted = await runOsa(`
      tell application "Terminal"
        if tty of selected tab of front window is not "${ttyEscaped}" then return "WRONG_WINDOW"
      end tell
      tell application "System Events"
        keystroke return
      end tell
      return "MATCH"
    `, signal)
    return submitted.ok && submitted.stdout === "MATCH"
  }

  async function tryITerm(): Promise<boolean> {
    if (canDeliver && !canDeliver()) return false
    // iTerm's `write text` submits on its own — no extra keystroke needed.
    const r = await runOsa(`
      tell application "iTerm"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${ttyEscaped}" then
                tell s to write text "${textEscaped}"
                return "MATCH"
              end if
            end repeat
          end repeat
        end repeat
        return "MISS"
      end tell
    `, signal)
    return r.ok && r.stdout === "MATCH"
  }

  if (program.includes("iterm")) {
    if (await tryITerm()) return true
    return await tryTerminal()
  }
  if (program.includes("apple_terminal") || program.includes("terminal")) {
    if (await tryTerminal()) return true
    return await tryITerm()
  }
  // No hint — only touch apps that are already running.
  if (canDeliver && !canDeliver()) return false
  if (canDeliver) {
    const apps = await runOsa(`
      tell application "System Events"
        set runningApps to ""
        if (name of processes) contains "Terminal" then set runningApps to runningApps & "Terminal "
        if (name of processes) contains "iTerm2" then set runningApps to runningApps & "iTerm"
        return runningApps
      end tell
    `, signal)
    if (!apps.ok) return false
    if (apps.stdout.includes("Terminal") && await tryTerminal()) return true
    return apps.stdout.includes("iTerm") && await tryITerm()
  }
  const r = await runOsa(`
    tell application "System Events"
      set iTermRunning to (name of processes) contains "iTerm2"
      set terminalRunning to (name of processes) contains "Terminal"
    end tell
    if terminalRunning then
      try
        tell application "Terminal"
          activate
          set matchedTab to false
          repeat with w in windows
            repeat with t in tabs of w
              if tty of t is "${ttyEscaped}" then
                do script "${textEscaped}" in t
                set selected of t to true
                set index of w to 1
                set matchedTab to true
                exit repeat
              end if
            end repeat
            if matchedTab is true then exit repeat
          end repeat
          if matchedTab is false then return "MISS"
        end tell
        tell application "System Events"
          tell process "Terminal"
            set frontmost to true
            try
              perform action "AXRaise" of window 1
            end try
            repeat with i from 1 to 20
              try
                if focused of window 1 is true then exit repeat
              end try
              delay 0.02
            end repeat
          end tell
          delay 0.08
          keystroke return
        end tell
        return "MATCH"
      end try
    end if
    if iTermRunning then
      try
        tell application "iTerm"
          repeat with w in windows
            repeat with t in tabs of w
              repeat with s in sessions of t
                if tty of s is "${ttyEscaped}" then
                  tell s to write text "${textEscaped}"
                  return "MATCH"
                end if
              end repeat
            end repeat
          end repeat
        end tell
      end try
    end if
    return "MISS"
  `)
  return r.ok && r.stdout === "MATCH"
}

// Serialize all injects through one queue. Two `injectText` calls running
// in parallel race each other's window-raise + keystroke-return phases:
// inject A's `do script` types into tab A (pending), B's `do script` types
// into tab B (pending), then the two `keystroke return` calls submit
// against whichever window happens to be frontmost at the moment of each —
// often producing the "swap" symptom (A's text lands in B's session, B's
// in A's). The lock guarantees the full type→raise→verify→return cycle for
// one inject finishes before the next starts, killing the race.
let injectQueue: Promise<unknown> = Promise.resolve()
function withInjectLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = injectQueue.catch(() => undefined).then(fn)
  injectQueue = next.catch(() => undefined)
  return next
}

// Optional identity guard runs after locks, immediately before typing. Other options are test seams.
export interface InjectOpts { deadline?: number; sendKeys?: TmuxSender; herdr?: Herdr; canDeliver?: () => boolean }

export async function injectText(text: string, target?: InjectTarget, opts: InjectOpts = {}): Promise<boolean> {
  const deadline = opts.deadline ?? Date.now() + INJECT_QUEUE_MS
  const sendKeys = opts.sendKeys ?? tmuxSendKeys
  // A herdr pane is addressed explicitly too, and never falls back to
  // AppleScript: its tty belongs to no Terminal/iTerm tab.
  const herdrPane = herdrPaneOf(target)
  if (herdrPane) {
    const r = await deliverViaHerdr(herdrPane, text, { deadline, herdr: opts.herdr, canDeliver: opts.canDeliver })
    companionLog(r.ok ? `\x1b[32mdelivered (herdr)\x1b[0m → ${herdrPane}` : `\x1b[31mdeliver failed\x1b[0m (herdr ${herdrPane}) — ${r.reason}`)
    return r.ok
  }
  // A tmux pane is addressed explicitly and serialised per pane by the key
  // gate: no global lock (that is for the AppleScript focus race), so one
  // wedged pane cannot stall injects into every other session.
  if (target?.tmuxPane) {
    const reset = "\x1b[0m"; const red = "\x1b[31m"; const yellow = "\x1b[33m"; const green = "\x1b[32m"
    const result = await deliverViaTmux(target.tmuxPane, text, sendKeys, deadline, target.tmuxSocket, opts.canDeliver)
    if (result.ok) {
      companionLog(`${green}delivered (tmux)${reset} → ${paneKey(target.tmuxPane, target.tmuxSocket)}`)
      return true
    }
    if (result.reason === "target_changed") return false
    // tmux failed (stale pane, no tmux, timed out, queue wedged past the
    // deadline). Fall back to AppleScript only with a tty (targeted,
    // focus-safe); without one the only fallback is a frontmost paste — refuse.
    companionLog(`${yellow}tmux send-keys failed${reset} pane=${paneKey(target.tmuxPane, target.tmuxSocket)} — ${result.reason}`)
    if (!target.tty) {
      companionLog(`${red}deliver failed${reset} — no tty fallback for pane ${target.tmuxPane}`)
      return false
    }
    companionLog(`${yellow}retrying via osascript${reset} → ${target.tty}`)
    const { tmuxPane: _dropped, tmuxSocket: _droppedSocket, ...rest } = target
    return withInjectLock(() => injectTextLocked(text, rest, deadline, sendKeys, opts.canDeliver))
  }
  return withInjectLock(() => injectTextLocked(text, target, deadline, sendKeys, opts.canDeliver))
}

// tty → pane resolution lives in lib/tmux-pane.ts; re-exported for callers
// that import it from here.
export { resolveTmuxPaneFromTty, resolveTmuxRefFromTty } from "./tmux-pane"

async function injectTextLocked(text: string, target: InjectTarget | undefined, deadline: number, sendKeys: TmuxSender, canDeliver?: () => boolean): Promise<boolean> {
  const reset = "\x1b[0m"; const red = "\x1b[31m"; const yellow = "\x1b[33m"; const cyan = "\x1b[36m"; const green = "\x1b[32m"
  try {
    if (canDeliver && !canDeliver()) return false
    // (A target with a tmux pane was handled in injectText, outside the lock.)
    // Targeted path: the tab's pty. No focus steal, clipboard, or WM race.
    if (target?.tty) {
      // Linux path: tty but no tmuxPane (hook race during server-spawn or
      // bare-pts session). tmux knows the pty→pane mapping — resolve via
      // `tmux list-panes` and route through the same send-keys path the
      // macOS targeted path uses. Without this, deliverToTty's AppleScript
      // would fail on Linux every time and we'd fall through to the
      // pbcopy/osascript untargeted path (also macOS-only). This makes
      // phone-spawned Linux sessions actually receive injects.
      if (process.platform === "linux") {
        const ref = await resolveTmuxRefFromTty(target.tty)
        if (ref) {
          const where = paneKey(ref.pane, ref.socket)
          const result = await deliverViaTmux(ref.pane, text, sendKeys, deadline, ref.socket, canDeliver)
          if (result.ok) {
            companionLog(`${green}delivered (tmux)${reset} → ${where} (resolved from ${target.tty})`)
            return true
          }
          companionLog(`${red}deliver failed${reset} — tmux send-keys to ${where}: ${result.reason}`)
          return false
        }
        companionLog(`${red}deliver failed${reset} — no tmux pane backs ${target.tty}`)
        return false
      }
      let delivered: boolean
      if (canDeliver) {
        let work: Promise<boolean> | undefined
        try {
          delivered = await keyGate.send(`tty|${target.tty.trim()}`, "Enter", (signal) => {
            work = deliverToTty(target, text, () => !signal.aborted && canDeliver(), signal)
            return work
          }, { startBy: deadline, timeoutMs: INJECT_SEND_MS })
        } catch { delivered = false }
        // The gate can time out first; keep the focus lock until osascript exits.
        finally { await work }
      } else delivered = await deliverToTty(target, text)
      if (delivered) {
        companionLog(`${cyan}delivered${reset} → ${target.tty}`)
        return true
      }
      // Fall-through: no tab currently backs that tty. Refuse rather than
      // silently landing in the frontmost window.
      companionLog(`${red}deliver failed${reset} — no tab for tty ${target.tty}`)
      return false
    }

    // Untargeted path: clipboard + Cmd+V+Enter into whatever is frontmost.
    // Kept for the "fire into wherever Jeremie is looking" case.
    const pbcopy = Bun.spawn(["pbcopy"], { stdin: new Blob([text]) })
    await pbcopy.exited
    await new Promise(r => setTimeout(r, 50))

    if (canDeliver && !canDeliver()) return false
    const r = await runOsa(`
      tell application "System Events"
        keystroke "v" using command down
        delay 0.1
        keystroke return
      end tell
    `)
    if (!r.ok) {
      companionLog(`${red}paste failed${reset} — osascript exit=${r.exitCode} ${yellow}${r.stderr || "(no stderr — check Accessibility permission)"}${reset}`)
      return false
    }
    return true
  } catch (err) {
    companionLog(`keyboard inject failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    return false
  }
}

// ── AskUserQuestion picker IO ─────────────────────────────────────────────
//
// The picker is driven by question-driver.ts, which only needs a way to read
// the pane and press keys. tmux gives both (capture-pane + send-keys) and is
// the path every Linux-host session and every Mac cc-tmux session takes. A plain
// iTerm/Terminal tty gets keys via System Events but no readable pane, so the
// driver runs blind there.

import type { PickerIO } from "./question-driver"

async function tmuxCapture({ pane, socket }: PaneRef): Promise<string | null> {
  try {
    const p = Bun.spawn([...tmuxArgv(socket), "capture-pane", "-p", "-t", pane], { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(p.stdout).text()
    return (await p.exited) === 0 ? out : null
  } catch {
    return null
  }
}

function tmuxPickerIO(ref: PaneRef): PickerIO {
  const send = (...rest: string[]) => tmuxSendKeys([...tmuxSocketFlags(ref.socket), "send-keys", "-t", ref.pane, ...rest], 2000)
  return {
    capture: () => tmuxCapture(ref),
    key: async (name) => (await send(name)).ok,
    // -l = literal so a digit lands as the character, not a key name.
    digit: async (n) => (await send("-l", String(n))).ok,
    text: async (t) => (await send("-l", t)).ok,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

// macOS key codes: Tab 48, Enter 36.
function ttyPickerIO(target: InjectTarget): PickerIO {
  async function press(body: string): Promise<boolean> {
    const focused = await focusTerminal(target)
    if (!focused) return false
    await new Promise((r) => setTimeout(r, 80))
    const r = await runOsa(`
      tell application "System Events"
        ${body}
      end tell
    `)
    return r.ok
  }
  return {
    capture: null,
    key: (name) => press(`key code ${name === "Tab" ? 48 : 36}`),
    digit: (n) => press(`keystroke "${n}"`),
    text: (t) => press(`keystroke "${escapeForAppleScript(t)}"`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

// Pick the IO for a question target: tmux pane (recorded, or resolved from the
// tty on Linux where every session lives in tmux), else a macOS tty. Returns
// null when there is nothing to drive. Serialised with the text-inject lock so
// a phone prompt can't interleave with picker keys.
export async function withPickerIO<T>(
  target: InjectTarget, run: (io: PickerIO, via: string) => Promise<T>,
  opts: { herdr?: Herdr } = {}, // tests: a fake herdr for the herdr picker IO
): Promise<T | null> {
  return withInjectLock(async () => {
    const pane = target.tmuxPane?.trim() ?? ""
    let ref: PaneRef | null = TMUX_PANE_RE.test(pane) ? { pane, socket: target.tmuxSocket ?? "" } : null
    if (!ref && target.tty && process.platform === "linux") ref = await resolveTmuxRefFromTty(target.tty)
    if (ref) return run(tmuxPickerIO(ref), paneKey(ref.pane, ref.socket))
    const herdrPane = herdrPaneOf(target)
    if (herdrPane) return run(herdrPickerIO(herdrPane, opts.herdr), herdrGateKey(herdrPane))
    if (target.tty && process.platform === "darwin") return run(ttyPickerIO(target), target.tty)
    return null
  })
}
