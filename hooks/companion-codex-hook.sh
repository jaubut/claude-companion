#!/bin/bash
# Claude Companion - Codex hook bridge
#
# Codex and Claude use similar hook input JSON, but Codex's blocking output
# differs: empty stdout means continue, while deny/block is
# {"decision":"block","reason":"..."}. The server returns that Codex shape
# when this script marks the request with X-Companion-Agent: codex.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$HOOK_DIR/_lib.sh"

ENDPOINT="$1"
MODE="${2:-sync}"
MAX_TIME="${3:-300}"

if [ -z "$ENDPOINT" ]; then
  exit 0
fi

COMPANION_URL="http://localhost:4245"

if ! curl -s --max-time 1 "$COMPANION_URL/health" > /dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
TTY=$(companion_find_tty)
CWD=$(pwd -P 2>/dev/null || pwd)

call_server() {
  curl -s --max-time "$MAX_TIME" \
    -X POST "$COMPANION_URL/hooks/$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "X-Companion-Agent: codex" \
    -H "X-Companion-Tty: ${TTY}" \
    -H "X-Companion-Term-Program: ${TERM_PROGRAM:-}" \
    -H "X-Companion-Iterm-Session-Id: ${ITERM_SESSION_ID:-}" \
    -H "X-Companion-Cwd: ${CWD}" \
    -H "X-Companion-Pid: ${PPID:-}" \
    -H "X-Companion-Tmux-Pane: ${TMUX_PANE:-}" \
    -d "$INPUT" 2>/dev/null
}

if [ "$MODE" = "async" ]; then
  call_server > /dev/null 2>&1 &
  exit 0
fi

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
