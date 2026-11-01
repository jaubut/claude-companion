#!/usr/bin/env bash
# The brain's read-only browser on Zettlab (docs/web-read.md).
#
#   web-browser.sh setup   once, from a real login shell (not the Claude sandbox):
#                          pinned Playwright Chromium + companion-browser.service
#   web-browser.sh run     what the unit runs: Xvfb :99 + Chromium, CDP on 127.0.0.1 only
#   web-browser.sh login   short-lived x11vnc on 127.0.0.1:5999 so Jeremie can log in
#
# Dedicated profile under the companion state dir, never Jeremie's own.
set -euo pipefail

PW_VERSION="${PLAYWRIGHT_VERSION:-1.56.1}"
DISPLAY_NUM="${COMPANION_WEB_DISPLAY:-99}"
CDP_PORT="${COMPANION_WEB_CDP_PORT:-9333}"
VNC_PORT=5999
PROFILE="$HOME/.claude-companion/web-browser-profile"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="companion-browser.service"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '[web-browser] %s\n' "$*"; }

chrome_bin() {
  find "$HOME/.cache/ms-playwright" -type f \( -path '*/chrome-linux/chrome' -o -path '*/chrome-linux64/chrome' \) 2>/dev/null | sort -V | tail -1
}

setup() {
  log "installing Chromium from playwright@$PW_VERSION"
  bunx "playwright@$PW_VERSION" install chromium
  [ -n "$(chrome_bin)" ] || { log "no Chromium under ~/.cache/ms-playwright"; exit 1; }
  command -v Xvfb >/dev/null || log "MISSING Xvfb: sudo apt-get install -y xvfb"
  command -v x11vnc >/dev/null || log "MISSING x11vnc (login only): sudo apt-get install -y x11vnc"
  log "system libraries, once (needs sudo): sudo $(command -v bunx) playwright@$PW_VERSION install-deps chromium"
  mkdir -p "$UNIT_DIR" "$PROFILE"
  chmod 700 "$PROFILE"
  cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Companion read-only browser (Chromium under Xvfb, CDP on 127.0.0.1:$CDP_PORT) — docs/web-read.md
After=network-online.target

[Service]
Type=simple
ExecStart=$REPO/scripts/web-browser.sh run
Environment=COMPANION_WEB_CDP_PORT=$CDP_PORT
Restart=on-failure
RestartSec=10
MemoryMax=2G

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  log "started $UNIT; check: ss -ltn | grep $CDP_PORT (must show 127.0.0.1 only)"
}

run() {
  local chrome
  chrome="$(chrome_bin)"
  [ -n "$chrome" ] || { log "Chromium not installed: run web-browser.sh setup"; exit 1; }
  mkdir -p "$PROFILE"
  # A crash leaves the profile locked; only this unit ever uses the profile.
  rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
  Xvfb ":$DISPLAY_NUM" -screen 0 1280x1000x24 -nolisten tcp &
  sleep 1
  # exec: when Chromium exits the unit stops, systemd kills Xvfb with the cgroup and restarts both.
  DISPLAY=":$DISPLAY_NUM" exec "$chrome" \
    --user-data-dir="$PROFILE" \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CDP_PORT" \
    --no-first-run --no-default-browser-check \
    --disable-features=Translate,MediaRouter \
    --autoplay-policy=no-user-gesture-required \
    --window-size=1280,1000 --window-position=0,0 \
    about:blank
}

login() {
  command -v x11vnc >/dev/null || { log "sudo apt-get install -y x11vnc"; exit 1; }
  local pass pwfile
  pass="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 8)"
  pwfile="$(mktemp)"
  trap 'rm -f "$pwfile"' EXIT
  x11vnc -storepasswd "$pass" "$pwfile" >/dev/null 2>&1
  log "VNC on 127.0.0.1:$VNC_PORT, one connection, gives up after 10 min unused"
  log "one-time password: $pass"
  x11vnc -display ":$DISPLAY_NUM" -localhost -rfbport "$VNC_PORT" -rfbauth "$pwfile" -once -timeout 600 -noxdamage -quiet
  log "VNC closed"
}

case "${1:-}" in
  setup) setup ;;
  run) run ;;
  login) login ;;
  *) echo "usage: web-browser.sh setup|run|login" >&2; exit 2 ;;
esac
