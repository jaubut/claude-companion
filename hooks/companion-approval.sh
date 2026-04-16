#!/bin/bash
# Claude Companion — phone approval hook
# Only activates when the companion server is running on port 4245
# If server is not running, silently passes through (no blocking)

COMPANION_URL="http://localhost:4245"

# Check if companion is running
if ! curl -s --max-time 1 "$COMPANION_URL/api/status" > /dev/null 2>&1; then
  # Companion not running — pass through silently
  exit 0
fi

# Read hook input from stdin
INPUT=$(cat)

# Forward to companion server and wait for phone decision
RESPONSE=$(curl -s --max-time 300 \
  -X POST "$COMPANION_URL/hooks/pre-tool-use" \
  -H "Content-Type: application/json" \
  -d "$INPUT" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  # Server error or timeout — pass through
  exit 0
fi

# Return the decision to Claude Code
echo "$RESPONSE"
exit 0
