// Inject text into a specific Claude Code terminal via clipboard + osascript.
//
// Without a target, falls back to the previous behavior — paste into whatever
// macOS app is frontmost. With a target, focuses the owning terminal first
// (iTerm or macOS Terminal, matched by tty) so multi-session users can pick
// which instance their reply lands in.

interface InjectTarget {
  tty?: string
  termProgram?: string
  iTermSessionId?: string
  // When the target session is running inside tmux, this is the pane id
  // (e.g. "%12"). Routing by pane id avoids the AppleScript focus race
  // entirely — tmux's server holds the pty master and emits a real Enter
  // key event that Ink's TUI treats as a true keypress (raw \n via stdin
  // does not, see claude-code issue #15553).
  tmuxPane?: string
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

async function runOsa(script: string): Promise<OsaResult> {
  try {
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    const code = proc.exitCode ?? 0
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code }
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
async function deliverToTty(target: InjectTarget, text: string): Promise<boolean> {
  const tty = target.tty?.trim()
  if (!tty) return false
  const ttyEscaped = escapeForAppleScript(tty)
  const textEscaped = escapeForAppleScript(text)
  const program = (target.termProgram ?? "").toLowerCase()

  async function tryTerminal(): Promise<boolean> {
    // Two-phase delivery to stop the intermittent misroute:
    //   1. do script "..." in t — types text into the target tab's pty
    //   2. Verify that the FRONT tab of the front Terminal window matches
    //      the target tty BEFORE firing the System Events keystroke. If the
    //      window raise didn't take effect (known flaky macOS behavior with
    //      multiple terminal windows), skip the keystroke rather than sending
    //      Enter to the wrong window — we'd rather fail loudly than deliver
    //      to a random session.
    const r = await runOsa(`
      tell application "Terminal"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            if tty of t is "${ttyEscaped}" then
              set selected of t to true
              set index of w to 1
              do script "${textEscaped}" in t
            end if
          end repeat
        end repeat
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

      tell application "System Events"
        keystroke return
      end tell
      return "MATCH"
    `)
    if (!r.ok) return false
    if (r.stdout.startsWith("WRONG_WINDOW")) {
      const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"
      process.stderr.write(`${dim}[companion]${reset} ${red}inject refused${reset} — front tty ${r.stdout.slice(13)} doesn't match target ${tty} (focus race; retry)\n`)
      return false
    }
    return r.stdout === "MATCH"
  }

  async function tryITerm(): Promise<boolean> {
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
    `)
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
                do script "${textEscaped}" in t
              end if
            end repeat
          end repeat
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

export async function injectText(text: string, target?: InjectTarget): Promise<boolean> {
  return withInjectLock(() => injectTextLocked(text, target))
}

// $TMUX_PANE is always "%N" (pane id). Reject anything else — stale targets,
// session names, or accidentally-shell-quoted strings — before we spawn tmux.
const TMUX_PANE_RE = /^%\d+$/

interface TmuxResult {
  ok: boolean
  reason: string
}

async function tmuxSendKeys(args: readonly string[], timeoutMs: number): Promise<TmuxResult> {
  try {
    const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => { try { proc.kill() } catch { /* already exited */ } }, timeoutMs)
    try {
      const stderr = (await new Response(proc.stderr).text()).trim()
      await proc.exited
      const code = proc.exitCode ?? 1
      if (code === 0) return { ok: true, reason: "" }
      return { ok: false, reason: stderr || `exit ${code}` }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

async function deliverViaTmux(paneId: string, text: string): Promise<TmuxResult> {
  // Two send-keys calls — first with `-l` (literal) so the text is typed
  // exactly as-is regardless of contents, second to send Enter as a real
  // key event. tmux holds the pty master, so the Enter byte sequence
  // arrives as a key event that Ink's onSubmit fires on (a raw \n in
  // stdin does not — see claude-code issue #15553).
  if (!TMUX_PANE_RE.test(paneId)) return { ok: false, reason: `invalid pane id "${paneId}"` }
  const literal = await tmuxSendKeys(["send-keys", "-t", paneId, "-l", text], 2000)
  if (!literal.ok) return { ok: false, reason: `send-keys -l: ${literal.reason}` }
  const enter = await tmuxSendKeys(["send-keys", "-t", paneId, "Enter"], 2000)
  if (!enter.ok) return { ok: false, reason: `send-keys Enter: ${enter.reason}` }
  return { ok: true, reason: "" }
}

async function injectTextLocked(text: string, target?: InjectTarget): Promise<boolean> {
  const dim = "\x1b[2m"; const reset = "\x1b[0m"; const red = "\x1b[31m"; const yellow = "\x1b[33m"; const cyan = "\x1b[36m"; const green = "\x1b[32m"
  try {
    // Preferred path: tmux send-keys when the target is inside a tmux
    // pane. This bypasses AppleScript entirely — no focus race, no
    // window-raise dance, no swap bug regardless of how many sessions
    // are open or which Mac window is frontmost.
    if (target?.tmuxPane) {
      const result = await deliverViaTmux(target.tmuxPane, text)
      if (result.ok) {
        process.stderr.write(`${dim}[companion]${reset} ${green}delivered (tmux)${reset} → ${target.tmuxPane}\n`)
        return true
      }
      // tmux failed — pane id stale, tmux not installed, session exited,
      // or send-keys timed out. Fall through to AppleScript only if we
      // also have a tty (the targeted, focus-safe path). Without a tty
      // the only fallback would be the untargeted clipboard paste into
      // whatever is frontmost — refuse loudly instead.
      process.stderr.write(`${dim}[companion]${reset} ${yellow}tmux send-keys failed${reset} pane=${target.tmuxPane} — ${result.reason}\n`)
      if (!target.tty) {
        process.stderr.write(`${dim}[companion]${reset} ${red}deliver failed${reset} — no tty fallback for pane ${target.tmuxPane}\n`)
        return false
      }
      process.stderr.write(`${dim}[companion]${reset} ${yellow}retrying via osascript${reset} → ${target.tty}\n`)
    }
    // Targeted path: deliver directly to the tab's pty. Doesn't steal focus,
    // doesn't touch the clipboard, doesn't race with the window manager.
    if (target?.tty) {
      const delivered = await deliverToTty(target, text)
      if (delivered) {
        process.stderr.write(`${dim}[companion]${reset} ${cyan}delivered${reset} → ${target.tty}\n`)
        return true
      }
      // Fall-through: no tab currently backs that tty. Refuse rather than
      // silently landing in the frontmost window.
      process.stderr.write(`${dim}[companion]${reset} ${red}deliver failed${reset} — no tab for tty ${target.tty}\n`)
      return false
    }

    // Untargeted path: clipboard + Cmd+V+Enter into whatever is frontmost.
    // Kept for the "fire into wherever Jeremie is looking" case.
    const pbcopy = Bun.spawn(["pbcopy"], { stdin: new Blob([text]) })
    await pbcopy.exited
    await new Promise(r => setTimeout(r, 50))

    const r = await runOsa(`
      tell application "System Events"
        keystroke "v" using command down
        delay 0.1
        keystroke return
      end tell
    `)
    if (!r.ok) {
      process.stderr.write(`${dim}[companion]${reset} ${red}paste failed${reset} — osascript exit=${r.exitCode} ${yellow}${r.stderr || "(no stderr — check Accessibility permission)"}${reset}\n`)
      return false
    }
    return true
  } catch (err) {
    console.error("[companion] keyboard inject failed:", err)
    return false
  }
}
