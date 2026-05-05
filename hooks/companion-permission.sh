#!/bin/bash
# Claude Companion — forward permission prompts to phone.
# Resilient to server restart — see companion-approval.sh for the same
# pattern; both hooks are long-polls and need the retry to avoid silently
# falling through when the daemon restarts mid-wait.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$HOOK_DIR/_lib.sh"

COMPANION_URL="http://localhost:4245"

if ! curl -s --max-time 1 "$COMPANION_URL/health" > /dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
TTY=$(companion_find_tty)

call_server() {
  curl -s --max-time 300 \
    -X POST "$COMPANION_URL/hooks/permission-request" \
    -H "Content-Type: application/json" \
    -H "X-Companion-Tty: ${TTY}" \
    -H "X-Companion-Term-Program: ${TERM_PROGRAM:-}" \
    -H "X-Companion-Iterm-Session-Id: ${ITERM_SESSION_ID:-}" \
    -H "X-Companion-Pid: ${PPID:-}" \
    -H "X-Companion-Tmux-Pane: ${TMUX_PANE:-}" \
    -d "$INPUT" 2>/dev/null
}

RESPONSE=$(call_server)
curl_exit=$?

if [ $curl_exit -ne 0 ]; then
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s --max-time 1 "$COMPANION_URL/health" > /dev/null 2>&1; then
      RESPONSE=$(call_server)
      break
    fi
    sleep 1
  done
fi

if [ -z "$RESPONSE" ]; then
  exit 0
fi

echo "$RESPONSE"
exit 0
