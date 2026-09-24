# Hook change: forward the tmux socket (`X-Companion-Tmux-Socket`)

Pane ids (`%N`) are per tmux **server**. For a session on the durable `cc`
socket (`tmux -L cc -f ~/.tmux/cc.conf`), `%3` names a different terminal than
`%3` on the default server. The server now addresses every pane with
`tmux -S <socket>` whenever the hook reports one (`server/lib/tmux-argv.ts`).

The hooks send `$TMUX`'s first comma field (`<socket>,<pid>,<idx>`) as
`X-Companion-Tmux-Socket`, next to `X-Companion-Tmux-Pane`. Outside tmux it is
empty, and the server keeps its old behaviour (plain `tmux`, default server).
A value that is not an absolute path is dropped on the server side.

## Apply

The installed hooks in `~/.claude/hooks/` (and `~/.codex/hooks/`) are copies of
this repo's `hooks/`. After merging, either:

```bash
bun cli.ts init        # re-copies hooks/ → ~/.claude/hooks, ~/.codex/hooks (idempotent)
```

or apply the patch below by hand (`_lib.sh` covers every Claude hook;
`companion-codex-hook.sh` is the Codex one):

```bash
# strips a/hooks/ → _lib.sh; the codex hunk belongs in ~/.codex/hooks (skip it here)
cd ~/.claude/hooks && patch -p2 --dry-run < /path/to/this.patch   # then without --dry-run
```

Order doesn't matter: an old hook just sends no socket header (old
behaviour), and the new header is ignored by an old server.

Check: in a `cc` tmux session, `echo "${TMUX%%,*}"` should print
`/tmp/tmux-$UID/cc`; after the next prompt, companion.log's
`delivered (tmux)` line reads `→ %N @ /tmp/tmux-$UID/cc`.

## Patch

```diff
diff --git a/hooks/_lib.sh b/hooks/_lib.sh
index 591f34d..683fb62 100755
--- a/hooks/_lib.sh
+++ b/hooks/_lib.sh
@@ -66,13 +66,19 @@ companion_find_agent_pid() {
 # X-Companion-Task-Id carries the orchestrator task this worker was dispatched
 # as (COMPANION_TASK_ID, exported into its tmux session at dispatch). Empty for
 # every session a human started, which is exactly what the server expects.
+#
+# X-Companion-Tmux-Socket is $TMUX's first comma field (the tmux server's
+# socket path). Pane ids are per server, so the server needs it to address a
+# pane on the durable `cc` socket (tmux -L cc) rather than the default one.
 companion_headers() {
+  local tmux_socket="${TMUX:-}"
   COMPANION_HDRS=(
     -H "X-Companion-Tty: ${TTY}"
     -H "X-Companion-Term-Program: ${TERM_PROGRAM:-}"
     -H "X-Companion-Iterm-Session-Id: ${ITERM_SESSION_ID:-}"
     -H "X-Companion-Pid: ${AGENT_PID:-${PPID:-}}"
     -H "X-Companion-Tmux-Pane: ${TMUX_PANE:-}"
+    -H "X-Companion-Tmux-Socket: ${tmux_socket%%,*}"
     -H "X-Companion-Task-Id: ${COMPANION_TASK_ID:-}"
   )
 }
diff --git a/hooks/companion-codex-hook.sh b/hooks/companion-codex-hook.sh
index 0d3e902..184d560 100755
--- a/hooks/companion-codex-hook.sh
+++ b/hooks/companion-codex-hook.sh
@@ -28,6 +28,7 @@ TTY=$(companion_find_tty)
 CWD=$(pwd -P 2>/dev/null || pwd)
 
 call_server() {
+  local tmux_socket="${TMUX:-}"
   curl -s --max-time "$MAX_TIME" \
     -X POST "$COMPANION_URL/hooks/$ENDPOINT" \
     -H "Content-Type: application/json" \
@@ -38,6 +39,7 @@ call_server() {
     -H "X-Companion-Cwd: ${CWD}" \
     -H "X-Companion-Pid: ${PPID:-}" \
     -H "X-Companion-Tmux-Pane: ${TMUX_PANE:-}" \
+    -H "X-Companion-Tmux-Socket: ${tmux_socket%%,*}" \
     -d "$INPUT" 2>/dev/null
 }
 
```

## Follow-up (by hand, after merge — not in this PR)

`~/.bashrc` `claude()` switches its `has-session` / `new-session` calls to
`tmux -L cc -f ~/.tmux/cc.conf …`. Phone-spawned sessions
(`server/lib/spawn-session.ts`) stay on the default server by design.
