#!/bin/bash
# Claude Companion — notify phone when Claude finishes a turn
# Only activates when the companion server is running

COMPANION_URL="http://localhost:4245"

# Check if companion is running
if ! curl -s --max-time 1 "$COMPANION_URL/api/status" > /dev/null 2>&1; then
  exit 0
fi

# Read hook input from stdin
INPUT=$(cat)

# Notify companion that Claude is waiting for input
curl -s --max-time 5 \
  -X POST "$COMPANION_URL/hooks/stop" \
  -H "Content-Type: application/json" \
  -d "$INPUT" > /dev/null 2>&1 &

exit 0
