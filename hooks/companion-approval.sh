#!/bin/bash
# Claude Companion — phone approval hook
# Forwards PreToolUse to the companion server and waits for the phone decision.
#
# Resilient to companion-server restarts: if the curl loses its connection
# mid-wait (e.g. `launchctl kickstart -k`), we wait briefly for the server
# to come back and re-issue the request — Claude is still blocked here, so
# the user gets a fresh approval card on their phone instead of silently
# falling through to the default.

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
    -X POST "$COMPANION_URL/hooks/pre-tool-use" \
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

# Transport-level failure (server restart killed the connection) → wait up
# to 10s for the server to come back, then retry once. A clean empty
# response from a live server falls through unchanged (Claude default).
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
