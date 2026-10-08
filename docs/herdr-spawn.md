# Phone spawn → herdr (Mac + Zettlab)

`POST /api/spawn-session` with `app: "auto"` (the phone default) starts the agent in a
**herdr workspace** when herdr's gate passes (`gateReason()` in
`~/.claude/tools/herdr-client.ts`: server up, protocol 22, version in
`DISPATCH_HERDR_VERSIONS`, default `0.9.3`). Gate fails → the old tmux path:
Terminal/iTerm on the Mac, a detached 220x60 tmux session on Linux. A failure *after* the
gate never falls back (a workspace may exist; a fallback would start a second agent).

| app | Mac | Linux (Zettlab) |
|---|---|---|
| `auto` | herdr → Terminal/iTerm tmux | herdr → detached tmux |
| `herdr` | herdr only | herdr only |
| `tmux` | detached tmux | detached tmux |
| `terminal` / `iterm` | that app | error (macOS-only) |

Same code path on both hosts (`spawnInHerdr`, `spawnMacAuto` in
`server/lib/spawn-session.ts`): `~` → `~/work` on Linux, folder trust pre-seeded, kimi
sources `~/.config/kimi/kimi.env` in the pane, env held to `ENV_TOKEN` and passed via `--env`.
Hooks forward `$HERDR_PANE_ID` (`X-Companion-Herdr-Pane`), so phone messages, approvals
and picker keys go through `herdr agent prompt` / `pane send-keys`.

Not changed: the Zettlab `~/.bashrc` `claude()` tmux wrapper (manual SSH launches) and
dispatch workers (`DISPATCH_WORKER=1`, hidden from the picker). Both share the one herdr
server per host.

## Zettlab host setup

Run in a real SSH login shell — not the Claude Bash sandbox (it scrubs env, so
`systemctl --user` can't reach the user bus):

```bash
~/claude-companion/scripts/herdr-zettlab-setup.sh
systemctl --user restart claude-companion
```

It is idempotent and:

1. installs herdr `0.9.3` to `~/.local/bin/herdr` (sha256-checked) if the version differs;
2. forces `[server] headless_cols = 220`, `headless_rows = 60` in `~/.config/herdr/config.toml`
   (overwrites existing values, adds whichever key is missing)
   — a pane with no client attached gets this size (default 120x40), and Claude Code
   dialogs + the `/help` scrape need the rows (same reason as tmux `DETACHED_COLS/ROWS`);
3. ensures `herdr.service` (systemd `--user`, shared with the dispatch herdr runner) is
   enabled + started, and linger is on — never restarts a running server by default (that
   would kill worker panes). If the running server's version differs from the binary
   (reload-config doesn't upgrade it, so the version gate would keep spawns on tmux) or
   `reload-config` fails, the script stops with exit 2: check no dispatch worker runs
   (`herdr workspace list`), then re-run with `HERDR_RESTART=1`. It ends by checking that the
   running server reports `0.9.3`. If a pane is still 120x40 after the first spawn, restart
   herdr the same way;
4. adds `claude-companion.service.d/herdr.conf` with `HERDR_BIN=%h/.local/bin/herdr`
   (the companion unit's PATH has no `~/.local/bin`; without it the gate reads
   `herdr-down` and every spawn silently stays on tmux);
5. installs herdr's Claude integration (`herdr integration install claude`) if not current.

Check:

```bash
systemctl --user status herdr claude-companion
loginctl show-user "$USER" -p Linger        # Linger=yes → survives logout/reboot
herdr status server --json                   # version 0.9.3, protocol 22
herdr integration status | grep '^claude:'   # claude: current
grep "herdr skipped" ~/.claude-companion/companion.log | tail -3   # gate fallbacks, if any
```

## Mac: see Zettlab sessions in the herdr window

```bash
herdr machine add aubut@zettlab --label zettlab   # Tailscale SSH (MagicDNS name)
herdr machine status
herdr --machine zettlab workspace list            # phone-spawned cc-* workspaces
```

The machine then shows in the Mac herdr sidebar. Attaching resizes the pane to the Mac
window; detaching returns it to the 220x60 headless size.

## Manual acceptance (Zettlab)

1. Phone → spawn in `~` → `cc-work` appears in the picker within ~5 s;
   `herdr workspace list` shows it; the companion log has no `herdr skipped` line for it.
2. Send a message → delivered + confirmed (`delivered (herdr)` / `submit confirmed → herdr|…`).
3. Trigger a tool needing approval → card on the phone → approve works.
4. `/exit` in the session → drops from the picker.
5. Same workspace visible on the Mac (`herdr --machine zettlab`).
6. `sudo reboot` → `systemctl --user status herdr` active before any login.
