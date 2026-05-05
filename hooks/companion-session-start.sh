#!/bin/bash
# Claude Companion — register session as soon as Claude Code opens so the
# phone picker shows idle sessions without waiting for a tool call.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$HOOK_DIR/_lib.sh"

COMPANION_URL="http://localhost:4245"

if ! curl -s --max-time 1 "$COMPANION_URL/health" > /dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
TTY=$(companion_find_tty)

curl -s --max-time 3 \
  -X POST "$COMPANION_URL/hooks/session-start" \
  -H "Content-Type: application/json" \
  -H "X-Companion-Tty: ${TTY}" \
  -H "X-Companion-Term-Program: ${TERM_PROGRAM:-}" \
  -H "X-Companion-Iterm-Session-Id: ${ITERM_SESSION_ID:-}" \
  -H "X-Companion-Pid: ${PPID:-}" \
    -H "X-Companion-Tmux-Pane: ${TMUX_PANE:-}" \
  -d "$INPUT" > /dev/null 2>&1 &

exit 0
