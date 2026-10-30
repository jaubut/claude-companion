#!/bin/bash
# Claude Companion — start activity timer on new user prompt
#
# Synchronous, capped at 1 s. The server answers this hook's exact stdout
# (X-Companion-Hook-Output: claude): the "sent from the iPhone" note when this
# prompt is a phone inject it was waiting on, plus the canvas notes linked to
# this session (live references, server/lib/canvas.ts). 204 = nothing to add.
# Server down, slow or any error → print nothing, exit 0.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
. "$HOOK_DIR/_lib.sh"

COMPANION_URL="${COMPANION_URL:-http://localhost:4245}"

INPUT=$(cat)
TTY=$(companion_find_tty)
AGENT_PID=$(companion_find_agent_pid)
companion_headers

# -f: HTTP errors fail. Any curl failure (incl. a timeout after a partial
# body) discards the response.
RESPONSE=$(curl -sf --max-time 1 \
  -X POST "$COMPANION_URL/hooks/user-prompt-submit" \
  -H "Content-Type: application/json" \
  -H "X-Companion-Hook-Output: claude" \
  "${COMPANION_HDRS[@]}" \
  -d "$INPUT" 2>/dev/null) || RESPONSE=""

case "$RESPONSE" in
  '{"hookSpecificOutput":'*) printf '%s\n' "$RESPONSE" ;;
esac

exit 0
