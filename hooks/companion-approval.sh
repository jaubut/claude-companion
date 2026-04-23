#!/bin/bash
# Claude Companion — phone approval hook
# Forwards PreToolUse to the companion server and waits for the phone decision.

COMPANION_URL="http://localhost:4245"

if ! curl -s --max-time 1 "$COMPANION_URL/api/status" > /dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
TTY=$(tty 2>/dev/null || true)

RESPONSE=$(curl -s --max-time 300 \
  -X POST "$COMPANION_URL/hooks/pre-tool-use" \
  -H "Content-Type: application/json" \
  -H "X-Companion-Tty: ${TTY}" \
  -H "X-Companion-Term-Program: ${TERM_PROGRAM:-}" \
  -H "X-Companion-Iterm-Session-Id: ${ITERM_SESSION_ID:-}" \
  -H "X-Companion-Pid: ${PPID:-}" \
  -d "$INPUT" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  exit 0
fi

echo "$RESPONSE"
exit 0
