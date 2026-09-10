#!/bin/bash
# Claude Companion — notify server when a Claude Code session ends so the
# phone picker drops that terminal immediately (instead of waiting 60min for
# the inactivity prune).

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

# Sends the full header block like every other hook: the tmux pane lets the
# server drop just this session instead of every session sharing its cwd, which
# is what kept killing a sibling worker's entry in the picker.
curl -s --max-time 3 \
  -X POST "$COMPANION_URL/hooks/session-end" \
  -H "Content-Type: application/json" \
  "${COMPANION_HDRS[@]}" \
  -d "$INPUT" > /dev/null 2>&1 &

exit 0
