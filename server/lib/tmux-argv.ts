// The one place a tmux argv is built. Every tmux subprocess in server/lib goes
// through tmuxArgv (tmux-argv.test.ts greps for strays).
//
// Why: pane ids (%N) are per tmux SERVER. A session on the durable `cc` socket
// (tmux -L cc) and one on the default socket can both be %3; addressing a cc
// pane on the default server types into a different terminal. So a session
// whose hook reported a socket ($TMUX's first comma field) is always addressed
// with `-S <socket>`, and never retried on the default server. No socket →
// plain `tmux …`, exactly as before.

// $TMUX_PANE is always "%N". Anything else (a session name, a quoted string,
// a stale target) is refused before tmux is spawned.
export const TMUX_PANE_RE = /^%\d+$/

// A socket is an absolute path. Anything else is dropped at the header parse.
export function validSocket(socket: string | undefined): string {
  const s = (socket ?? "").trim()
  return s.startsWith("/") && !/[\0\n\r]/.test(s) ? s : ""
}

// $TMUX is "<socket path>,<server pid>,<session index>".
export function socketFromTmuxEnv(tmux: string | undefined): string {
  return validSocket((tmux ?? "").split(",")[0])
}

export function tmuxArgv(socket: string | undefined, args: readonly string[]): string[] {
  return socket ? ["tmux", "-S", socket, ...args] : ["tmux", ...args]
}

// Identity of one pane across servers: the key-gate lock key. Default-socket
// panes keep their bare "%N" key, so nothing changes for them.
export function paneKey(pane: string, socket?: string): string {
  return socket ? `${socket}|${pane}` : pane
}

// For log lines: "%3" or "%3 @ /tmp/tmux-1000/cc".
export function paneLabel(pane: string, socket?: string): string {
  return socket ? `${pane} @ ${socket}` : pane
}
