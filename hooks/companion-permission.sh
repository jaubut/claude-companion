#!/bin/bash
# Claude Companion — forward permission prompts to phone
# Handles multi-choice permission dialogs (y/n/always)

COMPANION_URL="http://localhost:4245"

# Check if companion is running
if ! curl -s --max-time 1 "$COMPANION_URL/api/status" > /dev/null 2>&1; then
  exit 0
fi

# Read hook input from stdin
INPUT=$(cat)

# Forward to companion server and wait for phone decision
RESPONSE=$(curl -s --max-time 300 \
  -X POST "$COMPANION_URL/hooks/permission-request" \
  -H "Content-Type: application/json" \
  -d "$INPUT" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  exit 0
fi

echo "$RESPONSE"
exit 0
