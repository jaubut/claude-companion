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
git clone https://github.com/techlabstudio/claude-companion.git
cd claude-companion

# Install dependencies
bun install
cd client && bun install && bun run build && cd ..

# Add the hooks to Claude Code
cp hooks/*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/companion-*.sh
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
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/companion-post-tool-use.sh", "timeout": 5 }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/companion-user-prompt.sh", "timeout": 5 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "~/.claude/hooks/companion-stop.sh", "timeout": 5 }
        ]
      }
    ]
  }
}
```

The `PostToolUse` and `UserPromptSubmit` hooks drive the live "Whisking… 12s · 2.1k tokens · Bash" status pill on the phone so you can tell the difference between "still thinking" and "wedged".

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
| `COMPANION_NTFY_TOPIC` | *(unset)* | Enables push notifications. Full `https://ntfy.sh/<slug>` URL, or just the slug |
| `COMPANION_NTFY_TOKEN` | *(unset)* | Bearer token for self-hosted ntfy with auth |
| `COMPANION_URL` | *(unset)* | Tap-target URL for notifications (e.g. `http://192.168.1.42:4245` or your Tailscale hostname) |

## Push notifications (optional)

The companion pushes to your phone **only when no WebSocket client is connected** — if the tab is open, the WebSocket is faster. Push fires on:

- **Approval requests** (high priority — buzzes through silent mode)
- **Permission requests** (high priority)
- **Claude finishing a turn and waiting for your input** (default priority)

### Setup

1. Install the **ntfy** app on your phone ([iOS](https://apps.apple.com/us/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy))
2. Pick a long random topic slug — e.g. `claude-companion-<random 10-12 chars>`. Treat it as a password: anyone who knows the slug sees your notifications.
3. Subscribe to that topic in the ntfy app
4. Start the companion with the topic set:

```bash
export COMPANION_NTFY_TOPIC="claude-companion-<your-slug>"
export COMPANION_URL="http://$(ipconfig getifaddr en0):4245"
bun ~/claude-companion/cli.ts
```

Startup prints the configured topic. If `COMPANION_NTFY_TOPIC` is unset, push is silently disabled and the app works exactly as before.

Prefer self-hosted ntfy? Use a full URL like `https://ntfy.your-domain.com/claude-companion-xyz` and optionally set `COMPANION_NTFY_TOKEN` for bearer auth.

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
