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
# Clone
git clone https://github.com/jaubut/claude-companion.git
cd claude-companion

# Install dependencies
bun install
cd client && bun install && bun run build && cd ..

# Add the hook to Claude Code
cp hooks/companion-approval.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/companion-approval.sh
```

Add the hook to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/companion-approval.sh",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

## Usage

```bash
# Start the companion server
bun claude-companion/cli.ts

# Or add an alias to your shell
echo 'alias companion="bun ~/claude-companion/cli.ts"' >> ~/.zshrc
```

Then open `http://<your-ip>:4245` on your phone. Works great over [Tailscale](https://tailscale.com) for remote access.

Run `claude` normally in any terminal. Approvals that need your attention will appear on your phone.

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
| `COMPANION_VAPID_SUBJECT` | `mailto:companion@localhost` | Written into the VAPID keypair on first run. Most push gateways require a valid-looking `mailto:` — change before generating keys in production |

## Push notifications (Web Push — no extra app)

Push uses the browser's native notification system via VAPID. No ntfy, no native app — the same companion URL you already open on your phone handles both the UI and the notifications through a service worker.

The server pushes only when **no WebSocket client is connected** (tab closed/backgrounded). If the tab is open, the WebSocket is the faster path.

Pushes fire on:
- **Approval requests** — high urgency, `requireInteraction: true`
- **Permission requests** — high urgency, `requireInteraction: true`
- **Claude finishing a turn and waiting for input** — normal urgency

### First-time setup on iPhone (iOS 16.4+)

iOS requires **HTTPS** and the site must be installed on the Home Screen as a PWA before Safari will allow Web Push. Easiest route on a local network:

```bash
# Serve your local companion over HTTPS on your tailnet
tailscale serve --bg --https=4244 http://localhost:4245

# You'll get something like https://your-mac.tailnet.ts.net — use that URL:
export COMPANION_URL="https://your-mac.tailnet.ts.net"
bun ~/claude-companion/cli.ts
```

Then on the iPhone (connected to the same tailnet):
1. Open `https://your-mac.tailnet.ts.net` in **Safari** (not Chrome)
2. Share icon → **Add to Home Screen**
3. Open the newly-installed "Claude" app from the Home Screen
4. Tap the bell icon in the top bar → grant notification permission
5. Optional: `curl -X POST $COMPANION_URL/api/push/test` to verify

### Android (Chrome)

No PWA install required — HTTPS + granting notification permission is enough. Open the companion URL, tap the bell, done.

### Keys + subscriptions

- VAPID keypair lives at `~/.claude-companion/vapid.json` (0600 perms, auto-generated on first run)
- Subscriptions at `~/.claude-companion/subscriptions.json` — one record per subscribed device; revoked endpoints are pruned automatically

To wipe all devices, delete `subscriptions.json`. To rotate the VAPID keypair (invalidates all existing subscriptions), delete `vapid.json`.

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
