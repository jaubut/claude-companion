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
# Force both keys inside [server] (replace existing values, add missing ones).
COLS=220 ROWS=60
mkdir -p "$(dirname "$CFG")"
touch "$CFG"
cfg_new="$(mktemp)"
awk -v cols="$COLS" -v rows="$ROWS" '
  function flush() { if (!hc) print "headless_cols = " cols; if (!hr) print "headless_rows = " rows; hc = hr = 1 }
  /^[[:space:]]*\[/ { if (insrv) flush(); insrv = ($0 ~ /^[[:space:]]*\[server\][[:space:]]*(#.*)?$/); if (insrv) { seen = 1; hc = hr = 0 } print; next }
  insrv && /^[[:space:]]*headless_cols[[:space:]]*=/ { print "headless_cols = " cols; hc = 1; next }
  insrv && /^[[:space:]]*headless_rows[[:space:]]*=/ { print "headless_rows = " rows; hr = 1; next }
  { print }
  END { if (insrv) flush(); if (!seen) printf "\n[server]\nheadless_cols = %s\nheadless_rows = %s\n", cols, rows }
' "$CFG" > "$cfg_new"
CFG_CHANGED=0
if ! cmp -s "$cfg_new" "$CFG"; then
  cat "$cfg_new" > "$CFG"
  CFG_CHANGED=1
  log "set headless size ${COLS}x${ROWS} in $CFG"
fi
rm -f "$cfg_new"

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
running_version() {
  "$BIN" status server --json 2>/dev/null \
    | grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' || true
}
if systemctl --user is-active --quiet herdr.service; then
  # Never restart by default: that would kill running dispatch workers' panes.
  # A running server keeps its old binary (reload-config doesn't upgrade it) and may
  # not re-apply headless_* — both need a restart, done only with HERDR_RESTART=1.
  need_restart=""
  rv=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do rv="$(running_version)"; [ -n "$rv" ] && break; sleep 1; done
  if [ -z "$rv" ]; then
    log "ERROR: herdr.service is active but the server is not answering"
    need_restart="herdr server not answering"
  elif [ "$rv" != "$VERSION" ]; then
    need_restart="running server is v$rv, binary is v$VERSION (version gate keeps spawns on tmux)"
  elif [ "$CFG_CHANGED" = 1 ]; then
    "$BIN" server reload-config || need_restart="reload-config failed; headless size not applied"
  fi
  # HERDR_RESTART=1 always restarts, e.g. the retry after a reload-config failure
  # (the config is already written, so CFG_CHANGED is 0 on that run).
  if [ -z "$need_restart" ] && [ "${HERDR_RESTART:-0}" = 1 ]; then
    need_restart="HERDR_RESTART=1 (re-apply config.toml headless size)"
  fi
  if [ -n "$need_restart" ]; then
    if [ "${HERDR_RESTART:-0}" = 1 ]; then
      log "restarting herdr.service: $need_restart"
      systemctl --user restart herdr.service
    else
      log "ERROR: $need_restart"
      log "check no dispatch worker is running (herdr workspace list), then re-run with HERDR_RESTART=1"
      exit 2
    fi
  fi
else
  systemctl --user start herdr.service
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do [ "$(running_version)" = "$VERSION" ] && break; sleep 1; done
[ "$(running_version)" = "$VERSION" ] || { log "ERROR: herdr server not running v$VERSION: $("$BIN" status server --json 2>&1 | head -c 300)"; exit 1; }
loginctl show-user "$USER" -p Linger | grep -q 'Linger=yes' || sudo loginctl enable-linger "$USER"
log "linger: $(loginctl show-user "$USER" -p Linger --value)"

# 5. Claude integration (pane state hook in ~/.claude/hooks)
"$BIN" integration status | grep -q '^claude: current' || "$BIN" integration install claude
"$BIN" integration status | grep '^claude:'

log "status: $("$BIN" status server --json | head -c 300)"
log "restart the companion to pick up HERDR_BIN: systemctl --user restart claude-companion"
