#!/bin/bash
# Claude Companion — start activity timer on new user prompt

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$HOOK_DIR/_lib.sh"

COMPANION_URL="http://localhost:4245"

if ! curl -s --max-time 1 "$COMPANION_URL/health" > /dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
TTY=$(companion_find_tty)

curl -s --max-time 2 \
  -X POST "$COMPANION_URL/hooks/user-prompt-submit" \
  -H "Content-Type: application/json" \
  -H "X-Companion-Tty: ${TTY}" \
  -H "X-Companion-Term-Program: ${TERM_PROGRAM:-}" \
  -H "X-Companion-Iterm-Session-Id: ${ITERM_SESSION_ID:-}" \
  -H "X-Companion-Pid: ${PPID:-}" \
    -H "X-Companion-Tmux-Pane: ${TMUX_PANE:-}" \
  -d "$INPUT" > /dev/null 2>&1 &

exit 0
