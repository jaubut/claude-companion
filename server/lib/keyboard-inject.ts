// Inject text into the active terminal via clipboard + osascript

export async function injectText(text: string): Promise<boolean> {
  try {
    // Copy text to clipboard
    const pbcopy = Bun.spawn(["pbcopy"], { stdin: "pipe" })
    const writer = pbcopy.stdin.getWriter()
    await writer.write(new TextEncoder().encode(text))
    await writer.close()
    await pbcopy.exited

    // Small delay to ensure clipboard is ready
    await new Promise(r => setTimeout(r, 50))

    // Paste + Enter via osascript
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
