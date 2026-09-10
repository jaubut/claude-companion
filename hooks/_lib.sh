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
