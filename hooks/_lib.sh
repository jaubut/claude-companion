#!/bin/bash
# Shared helpers for Claude Companion hooks.
#
# Claude Code spawns hooks with stdin/stderr detached from the controlling
# terminal, so `tty` alone returns "not a tty" and the immediate parent also
# shows `??` (macOS) or `?` (Linux). Walking up the process tree finds the
# original claude-code process that owns the terminal.

# Find the controlling tty by walking up the parent process tree.
companion_find_tty() {
  local pid=$$
  local seen=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$seen" -lt 16 ]; do
    local t
    t=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ')
    if [ -n "$t" ] && [ "$t" != "??" ] && [ "$t" != "?" ]; then
      case "$t" in
        /*) echo "$t" ;;
        *)  echo "/dev/$t" ;;
      esac
      return
    fi
    pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
    seen=$((seen + 1))
  done
}

# Find the parent claude (or codex) process pid by walking up the tree.
# Returns empty if none found. Used so the hook sends a pid that survives the
# hook's own exit — otherwise the server's opportunistic prune kills the
# entry the moment the hook script terminates.
companion_find_agent_pid() {
  local pid=$$
  local seen=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$seen" -lt 16 ]; do
    local comm
    comm=$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ')
    case "$comm" in
      claude|codex)
        echo "$pid"
        return
        ;;
    esac
    pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
    seen=$((seen + 1))
  done
}

# The header block every companion hook sends, as curl -H argument pairs in the
# global array COMPANION_HDRS:
#
#   companion_headers
#   curl -s -X POST "$COMPANION_URL/hooks/x" \
#     -H "Content-Type: application/json" "${COMPANION_HDRS[@]}" -d "$INPUT"
#
# An array, not a flat string: TERM_PROGRAM and ITERM_SESSION_ID can contain
# spaces, and word-splitting a string would shred one header into several bogus
# curl arguments. Every hook here is #!/bin/bash, so arrays are available.
#
# Reads TTY and AGENT_PID from the caller — both walk the process tree, and the
# long-polling hooks compute them once and reuse them across a retry.
#
# X-Companion-Agent is deliberately NOT here: companion-codex-hook.sh layers its
# own agent + cwd headers on top of the same six.
#
# X-Companion-Task-Id carries the orchestrator task this worker was dispatched
# as (COMPANION_TASK_ID, exported into its tmux session at dispatch). Empty for
# every session a human started, which is exactly what the server expects.
companion_headers() {
  COMPANION_HDRS=(
    -H "X-Companion-Tty: ${TTY}"
    -H "X-Companion-Term-Program: ${TERM_PROGRAM:-}"
    -H "X-Companion-Iterm-Session-Id: ${ITERM_SESSION_ID:-}"
    -H "X-Companion-Pid: ${AGENT_PID:-${PPID:-}}"
    -H "X-Companion-Tmux-Pane: ${TMUX_PANE:-}"
    -H "X-Companion-Task-Id: ${COMPANION_TASK_ID:-}"
  )
}
