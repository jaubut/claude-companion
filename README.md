# Claude Companion

Phone-based approval remote for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Approve or deny tool calls from your phone while Claude runs in your terminal.

```
Terminal (Mac)                    Phone (iPhone/Android)
┌──────────────────┐              ┌──────────────────┐
│ claude           │              │ Claude Companion  │
│                  │   webhook    │                   │
│ Edit file.ts?    │ ──────────> │  ┌─────┐ ┌─────┐ │
│ waiting...       │             │  │Deny │ │Allow│ │
│                  │ <────────── │  └─────┘ └─────┘ │
│ ✓ approved       │   decision  │                   │
└──────────────────┘              └──────────────────┘
```

## How it works

1. A lightweight server runs on your machine (port 4245)
2. A Claude Code [hook](https://docs.anthropic.com/en/docs/claude-code/hooks) intercepts tool calls before execution
3. The hook sends the tool details to the companion server
4. Your phone shows the request with Approve/Deny buttons
5. The decision flows back to Claude Code

**Smart auto-judge**: Routine operations (reads, greps, safe git commands, `ls`, etc.) are auto-approved. Only genuinely risky or unknown commands reach your phone. Dangerous operations (`rm -rf /`, `git push --force`, `sudo`) are auto-denied.

**Zero interference**: If the companion server isn't running, the hook silently passes through. Your normal Claude Code workflow is completely unaffected.

## Install

```bash
# Clone + install
git clone https://github.com/jaubut/claude-companion.git
cd claude-companion
bun install

# One-shot: build the client, copy hooks to ~/.claude/hooks/,
# patch ~/.claude/settings.json, print the pairing token.
bun cli.ts init
```

`init` is idempotent — safe to re-run. It backs up `settings.json` before
every write and only adds companion entries that aren't already present, so
your other hooks are never touched.

To remove later: `bun cli.ts uninstall` (also backs up first).

## Usage

```bash
# Start the companion server
bun claude-companion/cli.ts

# Or add an alias to your shell
echo 'alias companion="bun ~/claude-companion/cli.ts"' >> ~/.zshrc
```

The server prints the pairing **URL** + **token** on every boot. Open
`http://<your-ip>:4245` on your phone (or use the iOS app), paste both into
the Settings screen, and you're connected. Works great over
[Tailscale](https://tailscale.com) for remote access.

### One-tap pairing via QR

```bash
bun cli.ts pair                    # auto-detects LAN IP
bun cli.ts pair --url <override>   # e.g. for a Tailscale Serve URL
```

Prints a QR + plaintext fallback. In the iOS app's **Settings** screen tap
"Scan QR from Mac" and point the camera at the terminal — both URL and
token fill in automatically. Payload is versioned JSON
(`{"v":1,"url":"…","token":"…"}`) so future formats won't be silently
misparsed by older clients.

Run `claude` normally in any terminal. Approvals that need your attention
will appear on your phone.

### Auto-start at login

```bash
bun cli.ts daemon install
```

Writes a macOS LaunchAgent at
`~/Library/LaunchAgents/com.techlabstudio.claude-companion.plist` and loads
it. The server starts automatically when you log in and `KeepAlive` brings
it back within ~5 seconds if it ever crashes. Logs land in
`~/.claude-companion/companion.log`.

```bash
bun cli.ts daemon status     # is it loaded? running? what PID?
bun cli.ts daemon logs       # tail -f the server log
bun cli.ts daemon uninstall  # unload + remove the plist
```

If port `4245` is already taken when you install, the command refuses with
the offending PID — kill that process first to avoid a launchd restart loop.

### Menu bar status

```bash
bun cli.ts menubar install
```

Builds a tiny SwiftPM macOS app (`mac/`), bundles it into
`Companion.app`, ad-hoc-signs it, and loads a separate LaunchAgent so it
launches at login. The menu bar icon polls `/health` every 3 seconds and
flips between green (running) and red (offline). The dropdown shows
client + pending counts, plus quick actions:

- **Open Dashboard** — opens the PWA in your default browser
- **Copy Pairing Token** — copies the bearer token from
  `~/.claude-companion/auth.token` to the clipboard
- **Restart Server** — `launchctl kickstart -k` on the server agent
- **Show Logs** — opens the companion log
- **Quit**

```bash
bun cli.ts menubar status     # bundle built? agent loaded? running PID?
bun cli.ts menubar build      # rebuild the .app without touching launchd
bun cli.ts menubar uninstall  # unload + remove the agent
```

Requires the Xcode Command Line Tools (for `swift build`).

### Subcommands

```
bun cli.ts                   Start the server in the foreground
bun cli.ts init              Install hooks + patch settings.json + print pairing
bun cli.ts uninstall         Remove companion hook entries from settings.json
bun cli.ts print-token       Print pairing URL + token without starting the server
bun cli.ts daemon <action>   Manage the server LaunchAgent (install/uninstall/status/logs)
bun cli.ts menubar <action>  Manage the menu bar app (install/uninstall/status/build)
bun cli.ts help              Show usage
```

## Auto-judge rules

The companion doesn't send everything to your phone. It uses a three-tier system:

| Verdict | What happens | Examples |
|---------|-------------|----------|
| **Auto-allow** | Passes through silently | `ls`, `git status`, `cat`, `grep`, Read, Glob |
| **Auto-deny** | Blocked immediately | `rm -rf /`, `git push --force`, `sudo`, `DROP TABLE` |
| **Ask phone** | Sent to your phone for approval | `npm install`, unknown scripts, file writes to `.env` |

Customize the rules in `server/lib/auto-judge.ts`.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `COMPANION_PORT` | `4245` | Server port |
| `COMPANION_URL` | `/` | Tap-target for notifications — e.g. `https://mac.tailnet.ts.net` |
| `APNS_TEAM_ID` | — | Apple Developer team ID (10-char) |
| `APNS_KEY_ID` | — | ID of the APNs auth key (.p8) from the Apple Developer portal |
| `APNS_KEY_P8_PATH` | — | Absolute path to the `.p8` private key file on disk |
| `APNS_BUNDLE_ID` | — | iOS app bundle identifier (e.g. `com.techlabstudio.companion`) |

If any APNs env var is missing, the push layer is a silent no-op — the rest of Companion keeps working.

## Push notifications (native iOS app, APNs)

Push is served by a native iOS companion app (separate bundle) that registers its APNs device token with the local Companion server. The Mac signs a JWT with your APNs auth key and POSTs directly to Apple — no cloud relay, no VAPID, no PWA.

Pushes fire on:
- **Approval / permission requests** — `interruption-level: time-sensitive`, sound, category `approval`
- **Claude finishing a turn and waiting for input** — `interruption-level: passive`, no sound, category `waiting_input`

The iOS app is expected to suppress the `waiting_input` notification locally when it's already foregrounded on that session.

### API

```bash
# iOS app registers its APNs token
POST /api/register-token
{ "token": "<hex device token>", "environment": "sandbox"|"production", "device_name": "iPhone 15" }

# Unregister on sign-out / app uninstall cleanup
DELETE /api/register-token
{ "token": "<hex device token>" }
```

Tokens live in a SQLite database at `~/.claude-companion/companion.db` (auto-created). Dead tokens (APNs 410 / BadDeviceToken / Unregistered) are pruned automatically on the next send.

## Requirements

- [Bun](https://bun.sh) v1.0+
- Claude Code CLI
- A phone with a web browser

## How it's built

- **Server**: Bun + Hono (50 lines of WebSocket + HTTP hook handler)
- **Client**: React + Tailwind (mobile-optimized PWA)
- **Hook**: 20-line bash script that `curl`s the companion server
- **Auto-judge**: Pattern matcher for safe/dangerous commands

No native dependencies. No PTY hacks. Just Claude Code hooks + a WebSocket.

## License

MIT
