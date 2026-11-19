#!/bin/sh
# headersHelper for the `board` MCP server (canvas-board-sync A1). Claude Code
# runs it at connect time and sends the JSON it prints as request headers, so
# the token is never stored in ~/.claude.json, an argv or a commit.
# Token: $COMPANION_PEER_ZETTLAB_TOKEN (Mac → Zettlab), else
# $COMPANION_AUTH_TOKEN, else ~/.claude-companion/auth.token (the brain host).
# None → exit 1 with no output (/mcp shows `board` failed, no secret anywhere).
token="${COMPANION_PEER_ZETTLAB_TOKEN:-${COMPANION_AUTH_TOKEN:-}}"
if [ -z "$token" ] && [ -r "$HOME/.claude-companion/auth.token" ]; then
  token="$(tr -d '[:space:]' < "$HOME/.claude-companion/auth.token")"
fi
[ -n "$token" ] || exit 1
case "${COMPANION_HOST_ROLE:-$(uname -s)}" in
  mac|Darwin) host=mac ;;
  zettlab|Linux) host=zettlab ;;
  *) host="$(hostname -s)" ;;
esac
caller="${COMPANION_BOARD_CALLER:-${CLAUDE_CODE_SESSION_ID:-session}}"
# Only [A-Za-z0-9._:-] reach the JSON: nothing to escape, nothing to inject.
safe() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._:-'; }
printf '{"Authorization":"Bearer %s","X-Board-Caller":"%s:%s"}\n' "$(safe "$token")" "$(safe "$host")" "$(safe "$caller")"
