// Reading a tmux pane and recognising what Claude Code is showing in it.
// Used by the dialog watcher (mirror what's on screen) and the orchestrator
// wiring (don't type into a worker until its input box is up).

import { TMUX_PANE_RE, tmuxArgv } from "./tmux-argv"

// `signal` (optional) kills the capture: a stalled tmux must not hold up a
// caller that has a deadline (command-scrape's dirty-pane verification).
// `escapes` adds `-e`: SGR attributes are kept, so a parser can tell Claude
// Code's dim predicted reply from text the user typed (lib/command-menu.ts).
// `socket`: the session's tmux server (lib/tmux-argv.ts); omit for default.
export async function capturePane(
  sessionName: string,
  signal?: AbortSignal,
  opts: { escapes?: boolean; socket?: string } = {},
): Promise<string | null> {
  try {
    const args = tmuxArgv(opts.socket, ["capture-pane", "-t", sessionName, "-p", ...(opts.escapes ? ["-e"] : [])])
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" })
    const kill = () => { try { p.kill() } catch { /* already gone */ } }
    if (signal?.aborted) kill()
    signal?.addEventListener("abort", kill, { once: true })
    try {
      const out = await new Response(p.stdout).text()
      return (await p.exited) === 0 && !signal?.aborted ? out : null
    } finally {
      signal?.removeEventListener("abort", kill)
    }
  } catch {
    return null
  }
}

// A freshly-spawned Claude renders its boot screen (welcome box + the input
// frame + the auto-mode/shortcuts footer) only once the TUI is ready to accept
// keystrokes. ps-discovery surfaces the process seconds earlier, and keys sent
// before the box is up are silently dropped. Gate on these markers.
export function paneInputReady(pane: string): boolean {
  return /Welcome back|auto mode|for shortcuts|to interrupt/.test(pane)
}

// Onboarding dialogs (new-MCP-server enable, folder-trust) overlay the input box
// AFTER the welcome/footer renders — so paneInputReady alone is fooled and the
// prompt lands on the dialog. Detect them and Escape to dismiss before sending.
export function paneHasDialog(pane: string): boolean {
  return /new MCP servers found|wish to enable|Do you trust|Select any you wish|enable this MCP/i.test(pane)
}

// Which tmux session owns this pane? The worker-identity resolver's tier 2:
// a hook carries $TMUX_PANE (%N), the orchestrator knows the session name it
// spawned (cc-<project>), and this is the only bridge between them.
//
// Called only when a cwd holds two or more candidate tasks, so the common
// single-worker path never pays for a subprocess. Null on anything unexpected
// — a malformed pane id, a dead pane, a slow tmux — and the caller refuses to
// guess rather than treating the failure as a match.
// `socket` scopes the lookup to the pane's own server: a %N absent there is
// null, never looked up on the default server.
export async function tmuxSessionForPane(pane: string, socket?: string): Promise<string | null> {
  if (!TMUX_PANE_RE.test(pane)) return null
  try {
    const p = Bun.spawn(tmuxArgv(socket, ["display-message", "-p", "-t", pane, "#S"]), {
      stdout: "pipe",
      stderr: "ignore",
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      p.kill()
    }, 1_000)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(timer)
    if (timedOut || code !== 0) return null
    return out.trim() || null
  } catch {
    return null
  }
}
