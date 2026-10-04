# Hooks: forwarding the tmux socket

Pane ids (`%N`) are per tmux **server**. For a session on the durable `cc`
socket (`tmux -L cc -f ~/.tmux/cc.conf`), `%3` names a different terminal than
`%3` on the default server. The server addresses every pane with
`tmux -S <socket>` whenever the hook reports one (`tmuxArgv` /
`tmuxSocketFlags` in `server/lib/tmux-pane.ts`; `server/lib/tmux-argv.test.ts`
greps `server/lib` for any tmux spawn that bypasses it).

The hooks send the whole `$TMUX` (`<socket>,<pid>,<idx>`) as
`X-Companion-Tmux`, next to `X-Companion-Tmux-Pane` (`hooks/_lib.sh`,
`hooks/companion-codex-hook.sh`). The server keeps the first comma field if it
is an absolute path. Outside tmux it is empty and the server keeps its old
behaviour (plain `tmux`, default server).

## Apply

The installed hooks in `~/.claude/hooks/` (and `~/.codex/hooks/`) are copies of
this repo's `hooks/`. After merging:

```bash
bun cli.ts init        # re-copies hooks/ → ~/.claude/hooks, ~/.codex/hooks (idempotent)
```

Order doesn't matter: an old hook just sends no `$TMUX` header (old
behaviour), and the header is ignored by an old server.

Check: in a `cc` tmux session, `echo "${TMUX%%,*}"` prints
`/tmp/tmux-$UID/cc`; after the next prompt, companion.log's
`delivered (tmux)` line reads `→ /tmp/tmux-$UID/cc|%N`.

## Follow-up (by hand, after merge — not in this PR)

`~/.bashrc` `claude()` switches its `has-session` / `new-session` calls to
`tmux -L cc -f ~/.tmux/cc.conf …`. Phone-spawned sessions follow
`COMPANION_TMUX_SOCKET` (unset → default server).
