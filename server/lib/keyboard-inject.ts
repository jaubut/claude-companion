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
}

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

async function runOsascript(script: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["osascript", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

async function focusTerminal(target: InjectTarget): Promise<boolean> {
  const tty = target.tty?.trim()
  if (!tty) return false

  const ttyEscaped = escapeForAppleScript(tty)
  const program = (target.termProgram ?? "").toLowerCase()

  if (program.includes("iterm")) {
    const ok = await runOsascript(`
      tell application "iTerm"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${ttyEscaped}" then
                select s
                tell w to select
                return
              end if
            end repeat
          end repeat
        end repeat
      end tell
    `)
    if (ok) return true
  }

  if (program.includes("apple_terminal") || program.includes("terminal")) {
    const ok = await runOsascript(`
      tell application "Terminal"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            if tty of t is "${ttyEscaped}" then
              set selected of t to true
              set frontmost of w to true
              return
            end if
          end repeat
        end repeat
      end tell
    `)
    if (ok) return true
  }

  // Last resort: try both without caring about TERM_PROGRAM.
  return runOsascript(`
    tell application "iTerm"
      try
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${ttyEscaped}" then
                select s
                tell w to select
                activate
                return
              end if
            end repeat
          end repeat
        end repeat
      end try
    end tell
    tell application "Terminal"
      try
        repeat with w in windows
          repeat with t in tabs of w
            if tty of t is "${ttyEscaped}" then
              set selected of t to true
              set frontmost of w to true
              activate
              return
            end if
          end repeat
        end repeat
      end try
    end tell
  `)
}

export async function injectText(text: string, target?: InjectTarget): Promise<boolean> {
  try {
    const pbcopy = Bun.spawn(["pbcopy"], { stdin: new Blob([text]) })
    await pbcopy.exited

    if (target?.tty) {
      await focusTerminal(target)
      await new Promise(r => setTimeout(r, 120))
    } else {
      await new Promise(r => setTimeout(r, 50))
    }

    const osascript = Bun.spawn(["osascript", "-e", `
      tell application "System Events"
        keystroke "v" using command down
        delay 0.1
        keystroke return
      end tell
    `])
    await osascript.exited

    return true
  } catch (err) {
    console.error("[companion] keyboard inject failed:", err)
    return false
  }
}
