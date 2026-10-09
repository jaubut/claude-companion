#!/bin/bash
# Claude Companion — start activity timer on new user prompt
#
# Synchronous, capped at 1 s: the server answers {"fromPhone":true} when this
# prompt is a phone inject it was waiting on, and we hand Claude a short
# context note. Server down, slow or any error → print nothing, exit 0.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$HOOK_DIR/_lib.sh"

COMPANION_URL="${COMPANION_URL:-http://localhost:4245}"

INPUT=$(cat)
TTY=$(companion_find_tty)
AGENT_PID=$(companion_find_agent_pid)
companion_headers

RESPONSE=$(curl -s --max-time 1 \
  -X POST "$COMPANION_URL/hooks/user-prompt-submit" \
  -H "Content-Type: application/json" \
  "${COMPANION_HDRS[@]}" \
  -d "$INPUT" 2>/dev/null)

case "$RESPONSE" in
  *'"fromPhone":true'*)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"This prompt was sent from Jeremie'"'"'s iPhone via Companion: prefer tappable links over Mac-only steps."}}'
    ;;
esac

exit 0
