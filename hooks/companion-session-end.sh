#!/bin/bash
# Claude Companion — notify server when a Claude Code session ends so the
# phone picker drops that terminal immediately (instead of waiting 60min for
# the inactivity prune).

COMPANION_URL="http://localhost:4245"

if ! curl -s --max-time 1 "$COMPANION_URL/api/status" > /dev/null 2>&1; then
  exit 0
fi

INPUT=$(cat)

curl -s --max-time 3 \
  -X POST "$COMPANION_URL/hooks/session-end" \
  -H "Content-Type: application/json" \
  -d "$INPUT" > /dev/null 2>&1 &

exit 0
