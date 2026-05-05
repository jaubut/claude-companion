#!/bin/bash
# Shared helpers for Claude Companion hooks.
#
# Claude Code spawns hooks with stdin/stderr detached from the controlling
# terminal, so `tty` alone returns "not a tty" and the immediate parent also
# shows `??`. Walking up the process tree finds the original claude-code
# process that owns the terminal.

companion_find_tty() {
  local pid=$$
  local seen=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$seen" -lt 16 ]; do
    local t
    t=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ')
    if [ -n "$t" ] && [ "$t" != "??" ]; then
      echo "/dev/$t"
      return
    fi
    pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
    seen=$((seen + 1))
  done
}
