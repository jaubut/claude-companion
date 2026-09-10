#!/bin/bash
# Claude Companion — heartbeat + token snapshot after every tool call

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$HOOK_DIR/_lib.sh"

COMPANION_URL="http://localhost:4245"

if ! curl -s --max-time 1 "$COMPANION_URL/health" > /dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)
TTY=$(companion_find_tty)
AGENT_PID=$(companion_find_agent_pid)
companion_headers

curl -s --max-time 2 \
  -X POST "$COMPANION_URL/hooks/post-tool-use" \
  -H "Content-Type: application/json" \
  "${COMPANION_HDRS[@]}" \
  -d "$INPUT" > /dev/null 2>&1 &

exit 0
