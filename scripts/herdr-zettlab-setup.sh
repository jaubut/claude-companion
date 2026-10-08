#!/usr/bin/env bash
# Zettlab (Linux) host setup for phone spawns → herdr. Idempotent; re-run any time.
# Run from a real login shell, NOT the Claude Bash sandbox (it scrubs env, so
# systemctl --user can't reach the user bus). See docs/herdr-spawn.md.
#
#   1. herdr pinned binary (matches HERDR_PINNED_VERSIONS in ~/.claude/tools/herdr-client.ts)
#   2. ~/.config/herdr/config.toml: headless pane size 220x60 (Claude dialogs, /help scrape)
#   3. herdr.service (systemd --user) enabled + linger, so it survives logout/reboot
#   4. claude-companion drop-in: HERDR_BIN (the unit's PATH has no ~/.local/bin)
#   5. herdr's Claude integration (pane agent-state hook)
set -euo pipefail

VERSION="${HERDR_VERSION:-0.9.3}"
# sha256 of herdr-linux-x86_64 v0.9.3, from https://herdr.dev/latest.json
SHA256="${HERDR_SHA256:-18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7}"
BIN="$HOME/.local/bin/herdr"
UNIT_DIR="$HOME/.config/systemd/user"
CFG="$HOME/.config/herdr/config.toml"

log() { printf '[herdr-setup] %s\n' "$*"; }

# 1. binary
if [ "$("$BIN" --version 2>/dev/null || true)" != "herdr $VERSION" ]; then
  [ "$(uname -m)" = "x86_64" ] || { log "only linux-x86_64 is pinned here; set HERDR_SHA256 for $(uname -m)"; exit 1; }
  tmp="$(mktemp)"
  log "downloading herdr v$VERSION"
  curl -fsSL --retry 3 "https://github.com/herdrdev/herdr/releases/download/v$VERSION/herdr-linux-x86_64" -o "$tmp"
  echo "$SHA256  $tmp" | sha256sum -c --quiet || { rm -f "$tmp"; log "checksum mismatch"; exit 1; }
  mkdir -p "$(dirname "$BIN")"
  install -m 0755 "$tmp" "$BIN"
  rm -f "$tmp"
fi
log "$("$BIN" --version)"

# 2. headless pane size. A pane with no client attached gets [server] headless_*
# (default 120x40) — same reason the tmux path forces 220x60 (DETACHED_COLS/ROWS).
mkdir -p "$(dirname "$CFG")"
touch "$CFG"
if ! grep -q '^[[:space:]]*headless_cols' "$CFG"; then
  if grep -q '^\[server\]' "$CFG"; then
    log "WARN: $CFG has a [server] table without headless_cols — add headless_cols = 220 / headless_rows = 60 by hand"
  else
    printf '\n[server]\nheadless_cols = 220\nheadless_rows = 60\n' >> "$CFG"
    log "set headless size 220x60 in $CFG"
  fi
fi

# 3. systemd --user unit (shared with the dispatch herdr runner — one server per host)
mkdir -p "$UNIT_DIR"
if [ ! -f "$UNIT_DIR/herdr.service" ]; then
  cat > "$UNIT_DIR/herdr.service" <<'EOF'
[Unit]
Description=herdr headless server (dispatch workers + companion phone spawns — RES-RY7A)
After=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/bin/herdr server
ExecStop=%h/.local/bin/herdr server stop
Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
UnsetEnvironment=ANTHROPIC_API_KEY
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
  log "wrote $UNIT_DIR/herdr.service"
fi

# 4. the companion calls `herdr` via $HERDR_BIN (server/lib/herdr.ts)
mkdir -p "$UNIT_DIR/claude-companion.service.d"
cat > "$UNIT_DIR/claude-companion.service.d/herdr.conf" <<'EOF'
[Service]
# Phone spawns → herdr (docs/herdr-spawn.md). The unit PATH has no ~/.local/bin.
Environment=HERDR_BIN=%h/.local/bin/herdr
EOF

systemctl --user daemon-reload
systemctl --user enable herdr.service
if systemctl --user is-active --quiet herdr.service; then
  # Never restart here: that would kill running dispatch workers' panes.
  "$BIN" server reload-config || log "WARN: reload-config failed — new size applies after the next herdr restart"
else
  systemctl --user start herdr.service
fi
loginctl show-user "$USER" -p Linger | grep -q 'Linger=yes' || sudo loginctl enable-linger "$USER"
log "linger: $(loginctl show-user "$USER" -p Linger --value)"

# 5. Claude integration (pane state hook in ~/.claude/hooks)
"$BIN" integration status | grep -q '^claude: current' || "$BIN" integration install claude
"$BIN" integration status | grep '^claude:'

log "status: $("$BIN" status server --json | head -c 300)"
log "restart the companion to pick up HERDR_BIN: systemctl --user restart claude-companion"
