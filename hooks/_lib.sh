#!/bin/bash
# Shared helpers for Claude Companion hooks.
#
# Claude Code spawns hooks with stdin/stderr detached from the controlling
# terminal, so `tty` alone returns "not a tty" and the immediate parent also
# shows `??` (macOS) or `?` (Linux). Walking up the process tree finds the
# original claude-code process that owns the terminal.

# The companion's own hidden /help enumeration session (cc-scrape-*, see
# server/lib/command-offpane.ts) runs a real claude with hooks disabled and
# COMPANION_SCRAPE=1 / CLAUDE_CODE_SCRAPE_SESSION=1 exported. Should a hook run
# anyway, it must post nothing: no picker entry, no push, no approval card.
# Exiting here, while being sourced, ends the calling hook with 0 and no
# output — Claude Code's normal flow.
if [ -n "${COMPANION_SCRAPE:-}" ] || [ -n "${CLAUDE_CODE_SCRAPE_SESSION:-}" ]; then
  exit 0
fi

# Linux: read one ancestor from /proc/<pid>/stat with bash builtins only, setting
# _P_PPID / _P_TTYNR (0 = no tty). Fails (→ ps fallback) on macOS or when the
# pid is gone. comm sits in parens and may hold spaces, so split after the last
# ") ". The ps walk forked 2–3 processes per level (~37 ms per hook on Zettlab);
# this forks none.
_companion_stat() {
  local line rest
  { read -r line < "/proc/$1/stat"; } 2>/dev/null || return 1
  rest=${line##*) }
  set -- $rest
  _P_PPID=$2 _P_TTYNR=$5
}

# Find the controlling tty by walking up the parent process tree.
companion_find_tty() {
  local pid=$$
  local seen=0
  while [ -n "$pid" ] && [ "$pid" -gt 1 ] && [ "$seen" -lt 16 ]; do
    if _companion_stat "$pid"; then
      if [ "$_P_TTYNR" -ne 0 ]; then
        local major=$(( (_P_TTYNR >> 8) & 0xfff )) minor=$(( (_P_TTYNR & 0xff) | ((_P_TTYNR >> 12) & 0xfff00) ))
        # Unix98 pty slaves are majors 136–143; anything else (vt, serial) is rare → ask ps
        if [ "$major" -ge 136 ] && [ "$major" -le 143 ]; then
          echo "/dev/pts/$(( (major - 136) * 256 + minor ))"
          return
        fi
      else
        pid=$_P_PPID; seen=$((seen + 1)); continue
      fi
    fi
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
    if _companion_stat "$pid" && { read -r comm < "/proc/$pid/comm"; } 2>/dev/null; then
      case "$comm" in claude|codex) echo "$pid"; return ;; esac
      pid=$_P_PPID
    else
      comm=$(ps -p "$pid" -o comm= 2>/dev/null | tr -d ' ')
      case "$comm" in
        claude|codex)
          echo "$pid"
          return
          ;;
      esac
      pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
    fi
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
# X-Companion-Herdr-Pane is $HERDR_PANE_ID when the agent runs in a herdr
# pane (Mac): the server injects through `herdr agent prompt` there.
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
    -H "X-Companion-Tmux: ${TMUX:-}"
    -H "X-Companion-Task-Id: ${COMPANION_TASK_ID:-}"
    -H "X-Companion-Herdr-Pane: ${HERDR_PANE_ID:-}"
  )
}

# Long-poll POST for the approval hooks: `companion_long_poll <path>` sends
# $INPUT to $COMPANION_URL<path>, sets RESPONSE, returns curl's exit code.
#
# Claude Code ends a waiting hook when the prompt is answered in the terminal.
# curl must end with it: inside $(...) a SIGTERM to bash left curl orphaned,
# holding the request open, so the server never saw the hook go (hook_gone)
# and the phone card stayed up until the 290 s expiry. So curl runs in the
# background, and TERM/HUP/INT kill it, then exit 0 with no output (Claude
# Code's normal flow).
companion_long_poll() {
  local out rc
  out=$(mktemp "${TMPDIR:-/tmp}/companion-hook.XXXXXX") || return 1
  trap 'kill "$_COMPANION_CURL" 2>/dev/null; rm -f "'"$out"'"; exit 0' TERM HUP INT
  curl -s --max-time 295 \
    -X POST "$COMPANION_URL$1" \
    -H "Content-Type: application/json" \
    "${COMPANION_HDRS[@]}" \
    -d "$INPUT" > "$out" 2>/dev/null &
  _COMPANION_CURL=$!
  wait "$_COMPANION_CURL"
  rc=$?
  trap - TERM HUP INT
  RESPONSE=$(cat "$out")
  rm -f "$out"
  return $rc
}
