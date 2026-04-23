#!/bin/bash
# Claude Companion — start activity timer on new user prompt

COMPANION_URL="http://localhost:4245"

if ! curl -s --max-time 1 "$COMPANION_URL/api/status" > /dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
TTY=$(tty 2>/dev/null || true)

curl -s --max-time 2 \
  -X POST "$COMPANION_URL/hooks/user-prompt-submit" \
  -H "Content-Type: application/json" \
  -H "X-Companion-Tty: ${TTY}" \
  -H "X-Companion-Term-Program: ${TERM_PROGRAM:-}" \
  -H "X-Companion-Iterm-Session-Id: ${ITERM_SESSION_ID:-}" \
  -H "X-Companion-Pid: ${PPID:-}" \
  -d "$INPUT" > /dev/null 2>&1 &

exit 0
