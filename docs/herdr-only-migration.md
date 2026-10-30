# Herdr-only migration plan: retire the `tmux -L cc` path

Status: PLAN for review (2026-10-30). No code changes in this PR.
Decision (Jeremie): Companion goes herdr-only, and the `tmux -L cc` path is retired.
Scope: the Companion server (Mac and Zettlab), the Zettlab systemd units, the `claude()` shell wrappers, and the Mac Canvas terminal node.

## 0. Where things stand (Zettlab, observed 2026-10-30)

- **Agents already run in herdr.**
  - herdr 0.9.5 runs as `herdr.service` (linger).
  - It hosts the brain (workspace `brain`, pane `w3T:p1`, `claude --remote-control brain`, `COMPANION_TASK_ID=brain`), every `builder-zettlab-*` worker, and the phone-spawned `cc-*` sessions.
  - This plan was written from a herdr pane (`w3V:p1`).
- **What's left on `tmux -L cc`:** `_boot_holder` (the resurrect anchor), `cc-aubut-` (a `claude` in `~` that the `claude()` wrapper launched on 2026-10-27), and three phone shells (`sh-work`, `sh-work-2`, `sh-work-3`). The shells are the ones that keep coming back after a reboot.
- **The units that keep tmux alive:**
  - `tmux-resurrect-boot.service` (enabled): starts `tmux -L cc` at boot, runs tmux-resurrect `restore.sh`, then `cc-claude-resume`. At stop it runs `cc-claude-snapshot --force` and resurrect `save.sh`.
  - `tmux-cc-save.timer` → `tmux-cc-save.service`: every 5 minutes, `cc-claude-snapshot` plus resurrect `save.sh`.
  - Resurrect restores every saved session, the phone shells included. That is why stale `sh-work*` come back.
- **The interactive path into tmux:** the `claude()` wrapper in `~/.bashrc` (and `~/.zshrc` on the Mac) puts an interactive `claude` into `tmux -L cc new-session -s cc-<dir>`, unless `$TMUX`, `HERDR_ENV=1` or `CLAUDE_NO_TMUX` is set. This is the last way an agent lands on tmux on purpose.
- **herdr clutter:** herdr has its own leftovers. The `work` shell workspaces `w2F`, `w2M`, `w2N`, `w2P` are empty panes, because workspace auto-close is off (`COMPANION_HERDR_AUTOCLOSE` unset; herdr 0.9.x has no atomic conditional close).

## 1. The key risk: does herdr cover inject + mirror? Mostly yes, with three real gaps

| need | tmux today | herdr today (0.9.5) | verdict |
|---|---|---|---|
| Spawn an agent | `tmux new-session` (spawn-session.ts, Linux detached / Mac Terminal+iTerm) | `workspace create` + `agent start` (`spawnInHerdr`, live on both hosts since #150/#153) | ✅ exists, default path |
| Type a prompt + confirm submit | `send-keys -l` + Enter, submit check by capture | `agent prompt` / `pane send-text` + `send-keys` (herdr-inject.ts, "delivered (herdr)" + "submit confirmed" verified) | ✅ exists |
| Keys (Esc, picker arrows, dialog answers) | `send-keys` through the key gate (tmux-pane.ts) | `pane send-keys` (exit 0, no stdout → `silentSuccess`, #155) | ✅ exists |
| Read the screen (dialogs, pickers, idle check, auto-compact) | `capture-pane -p` plain / `-e` coloured, per consumer | `pane read --source visible --format text\|ansi` (#157 parity: dialog mirror, auto-compact, `/` suggestions) | ✅ exists; same plain-vs-coloured rule |
| Phone pane mirror (#234 / pane-mirror.ts) | tmux MirrorSource: `capture-pane -e` poll + `send-keys -H` | herdr MirrorSource (the original source; tmux was added second) | ✅ exists. **Gap A:** resize. herdr has no per-pane resize API for a single pane in a workspace (`pane resize` resizes a split), so the mirror uses the frame size it reads. That is acceptable: the herdr source already works this way today |
| Plain shell from the phone (`sh-*`, shell-sessions.ts) | `tmux new-session` tagged `@companion_shell`; tmux *is* the record | none: a shell is not an agent, so nothing registers it | **Gap B:** needs a herdr record (see Stage 2) |
| Live terminal bridge for those shells (terminal-bridge.ts, `/api/terminal`) | `tmux attach-session` under a PTY, raw byte stream | `herdr agent attach <agent>` attaches ONE agent terminal, but shells aren't agents. `herdr --session` attaches the whole multi-workspace UI, not one pane | **Gap C:** no raw single-pane attach for a plain shell. Use the pane-mirror WS instead (read + send-keys), which is screen polling, not a PTY stream |
| Mac Canvas terminal node | `TerminalAttach.swift`: SwiftTerm running `tmux attach` / `ssh -t zettlab tmux attach` (PRJ-FL49 core call) | same gap as C | **Gap C** (consumer outside this repo; the Mac repo checkout here is stale, so not verified) |
| Off-pane slash-command list (command-offpane*.ts) | a throwaway detached tmux session `cc-scrape-*` (220x60) runs a hidden `claude` with a temp HOME, hooks off and no MCP, scrapes `/help` by capture-pane, then is killed and confirmed dead | not ported | **Gap D:** a hidden herdr workspace would be visible in herdr's UI and detected as an agent by herdr's Claude integration, and its env must carry the temp HOME (`--env`). Port with those two checks, or drop it if #157's `/` suggestions already cover the list |
| Orchestrator "Run live" workers (orchestrator-db `tmux_session`/`tmux_socket`, dispatch-tasks/poller DTO `tmuxSession`/`tmuxSocket` → iOS side chat) | local tmux worker per live row | brain workers already run in herdr (`builder-zettlab-*`, reaper #227) | **partial:** the live-row DTO still names a tmux session. It needs a `herdrPane` field (additive) before the tmux fields go |
| Durability across reboot | resurrect + `cc-claude-resume` (`claude --resume <sid>`) | herdr keeps each pane's Claude session id (`~/.config/herdr/session.json`) and resumed all 7 Mac panes after the 0.9.5 server restart | ✅ for agents; shells are not resumed, which is the point |
| Server restart without killing agents | tmux server outlives Companion | `herdr update --handoff` = live handoff. **`herdr server stop` SIGKILLs every pane, and `herdr.service`'s `ExecStop` is `herdr server stop`** | ⚠ see Risk 1 |

**The seam.** `server/lib/session-pane.ts` `sessionPaneOf()` is the one place that picks the driver: "tmux when the session has a tmux pane, else herdr". dialog-watch, pickers, model control and inject read and type through it. `discover.ts` maps ttys to tmux panes for ps-discovered sessions. Retiring tmux on the driving side means removing one branch in `sessionPaneOf`, plus the tmux discovery in `discover.ts` (Stage 5), not touching every consumer.

**Bottom line.** Agent inject and output mirroring work on herdr today and have been verified on both hosts. The gaps are:
- **B and C:** plain shells and the raw terminal stream that the phone Terminal view and the Mac Canvas node attach to.
- **D:** off-pane commands.

None of the three blocks retiring tmux for agents. B and C decide whether the phone and Canvas terminal views survive.

## 2. Biggest risks

1. **Brain safety lives in `herdr.service`, not tmux.**
   - The brain and every worker already run in herdr. A `systemctl --user restart herdr.service` (or a reboot without handoff) SIGKILLs them all. They come back only through herdr's own agent resume.
   - Cutting tmux makes herdr the single point of failure for every session. Fix this first (Stage 0): make `ExecStop` hand off or detach rather than run `server stop`, or at least document "never restart herdr.service, use `herdr update --handoff`".
   - Also verify that resume works after a cold reboot on Zettlab. It is only proven for the Mac server restart.
2. **Gap C (terminal stream).** If the phone Terminal view and the Mac Canvas terminal must stay real PTYs (vim, Ctrl-C, scrollback), herdr has no equivalent for plain shells. The fallback, pane-mirror polling, is good for agents and weak for a shell running vim.
3. **The version pin.** Spawn uses herdr only when its version is in `HERDR_PINNED_VERSIONS` / `DISPATCH_HERDR_VERSIONS`. Today an unpinned version silently falls back to tmux. Once tmux is gone there is no fallback, so an unpinned upgrade breaks every spawn. The gate must become a loud error plus an upgrade checklist.
4. **Mac differs from Zettlab.** The Mac `auto` fallback is Terminal/iTerm running tmux, and the Mac server can't hand off on a brew upgrade. Run every stage on Zettlab first, then on the Mac.

## 3. Staged cutover

Each stage is shippable alone. The brain, the companion server and the running workers are never restarted by a stage. Code changes go through `/change` with the plan in STATE.md.

### Stage 0: make herdr safe to depend on (ops + one small PR)
- `herdr.service`: replace `ExecStop=herdr server stop` with no ExecStop (systemd SIGTERMs the server at shutdown anyway), and write down in `docs/herdr-spawn.md` that upgrades go through `herdr update --handoff`. Do this on a quiet window, because a daemon-reload doesn't restart the unit.
- Prove a cold-reboot resume on Zettlab. Reboot with only throwaway sessions running, then confirm that herdr resumes the claude panes and that Companion re-binds them.
- Spike Gap C. Does `herdr agent attach` / `pane input` give a raw single-pane stream for a non-agent pane? Settle it with one throwaway workspace, never a live pane.
- **Rollback:** restore the unit file from `.bak`, then `daemon-reload`.

### Stage 1: stop creating new tmux sessions (code, Zettlab then Mac)
- `spawn-session.ts`: `app: "auto"` → herdr only. A gate failure becomes an error (`herdr_unavailable: <reason>`), never a tmux fallback, the same as takeover today. `app: "tmux"` returns 400 `tmux_retired`. Mac Terminal/iTerm: keep or drop is Jeremie's call; they are tmux under the hood.
- The version gate becomes a hard error, with the pinned list moved to one env var on both hosts.
- `claude()` wrappers in `~/.bashrc` and `~/.zshrc` (claude-config): launch into herdr instead of `tmux -L cc` (`herdr workspace create` + `agent start`, as spawn does), or simply run `command claude` when already inside herdr.
- Existing tmux sessions keep working. Inject, mirror and dialogs still resolve their tmux pane, and the read paths are untouched.
- **Rollback:** revert the PR. The fallback code is still there.

### Stage 2: shells on herdr (Gaps B and C)
- `shell-sessions.ts`: a phone shell becomes a herdr workspace labelled `sh-<dir>` with a known metadata tag (`pane report-metadata` or workspace label). The record is read back from `herdr pane list` instead of tmux options. A restart still loses nothing.
- `terminal-bridge.ts`: if the Stage 0 spike finds a raw attach, keep the PTY bridge pointed at it. If not, the phone Terminal view switches to the pane-mirror WS (`/api/pane-mirror`, herdr MirrorSource), which also needs an iOS change.
- Mac Canvas terminal node: the same choice, in the Mac repo (follow-up task, agent:builder).
- **Rollback:** revert. Existing tmux shells were never touched.

### Stage 3: off-pane commands (Gap D)
- `command-offpane*.ts`: run the hidden capture in a hidden herdr workspace (`workspace create` + `pane run` + `pane read`), or drop off-pane commands if the herdr `/` suggestions path from #157 already covers them. Decide after measuring how often off-pane runs today.
- **Rollback:** revert.

### Stage 3b: "Run live" rows (orchestrator)
- Live workers spawn through `spawnInHerdr`. Add an additive `herdrPane` field to the live-row DTO (`dispatch-tasks.ts`, `dispatch-poller.ts`) so iOS opens the side chat by pane. `tmuxSession`/`tmuxSocket` become null for new rows.
- **Rollback:** revert. Old rows keep their tmux identity.

### Stage 4: retire the tmux ops (Zettlab, then Mac)
Only after Stages 1–3 have run for a week with zero tmux spawns (`grep "app=tmux"` in the companion log). The commands below are the exact steps.
```sh
# 1. stop resurrecting and snapshotting
systemctl --user disable --now tmux-cc-save.timer
systemctl --user disable tmux-resurrect-boot.service      # disable only: stopping it kills the cc server (ExecStop kill-server)
cp ~/.local/state/cc-claude-resume.tsv ~/.local/state/cc-claude-resume.tsv.bak-$(date +%F)
# 2. look before killing: the shells and the one leftover claude
tmux -L cc list-panes -a -F '#{session_name} #{pane_current_command} #{pane_current_path}'
tmux -L cc kill-session -t =sh-work; tmux -L cc kill-session -t =sh-work-2; tmux -L cc kill-session -t =sh-work-3
#    cc-aubut- runs claude: /exit it from its pane, or note its session id first, then resume it in herdr (`claude --resume <sid>`)
# 3. when only _boot_holder is left
systemctl --user stop tmux-resurrect-boot.service           # its ExecStop saves + kill-server
mkdir -p ~/.config/systemd/user/retired && mv ~/.config/systemd/user/tmux-{resurrect-boot.service,cc-save.service,cc-save.timer} ~/.config/systemd/user/retired/
systemctl --user daemon-reload
# 4. leftover herdr clutter (empty `work` shells)
herdr workspace list   # close only workspaces with agent_status unknown and no foreground process
```
- Also delete or archive `~/.local/bin/cc-claude-resume`, `cc-claude-snapshot`, `tmux-load-agent-env` and `~/.tmux/cc.conf` in claude-config, in the same PR as the wrapper change.
- **Rollback:** move the units back, `daemon-reload`, `enable --now` both. The `.tsv` backup restores what `cc-claude-resume` resumes.

### Stage 5: delete the tmux code (one PR per module)
Only after Stage 4, plus two weeks of no tmux session on either host.
- **Delete:** the tmux spawn paths in `spawn-session.ts` (detached tmux, Mac Terminal/iTerm, `tmux-spawn-confirm`), the tmux `MirrorSource` from #234, the tmux branch of `keyboard-inject.ts`, `tmux-pane.ts` (key gate tmux side, socket flags), `tmuxPane` / `tmuxSocket` resolution, the `X-Companion-Tmux*` headers in `hooks/_lib.sh`, and the tmux half of `command-offpane-launch.ts`.
- **Rewrite:** `shell-sessions.ts` (Stage 2), `terminal-bridge.ts` (Stage 2), `herdrPaneOf`. The "tmux inside herdr defers to tmux" rule goes once no wrapper puts tmux in a herdr pane.
- **Keep as contract (iOS):** session JSON `tmuxPane` stays as `""` for one iOS release, because shipped builds decode it, then it is removed. `canMirror` stays (server-computed).
- **Rollback:** revert per module. Stage 4 is reversible separately.

## 4. Deleted vs rewritten (summary)

| module | fate |
|---|---|
| tmux spawn (detached / Terminal / iTerm), `tmux-spawn-confirm.ts` | delete (Stage 5) |
| `tmux-pane.ts`, tmux branch of `keyboard-inject.ts` | delete (Stage 5); the key gate stays, herdr side only |
| tmux `MirrorSource` (#234) | delete (Stage 5) |
| `shell-sessions.ts` | rewrite on herdr (Stage 2) |
| `terminal-bridge.ts` | rewrite (raw herdr attach if the spike finds one, else replaced by pane-mirror) |
| `command-offpane*.ts` | port to herdr or drop (Stage 3) |
| `tmux-resurrect-boot.service`, `tmux-cc-save.{timer,service}`, `cc-claude-*`, `~/.tmux/cc.conf` | remove (Stage 4) |
| `claude()` wrappers (bashrc/zshrc, claude-config) | rewrite to herdr (Stage 1) |
| `hooks/_lib.sh` tmux headers | delete (Stage 5) |
| orchestrator live-row `tmux_session`/`tmux_socket` + DTO `tmuxSession`/`tmuxSocket` | `herdrPane` added (Stage 3b); tmux fields null, then removed after one iOS release |
| session JSON `tmuxPane` | empty for one iOS release, then remove |

## 5. Open questions for Jeremie
1. Mac `terminal` / `iterm` spawn apps: drop them (herdr only), or keep them for desk sessions you watch in Ghostty?
2. If herdr has no raw attach for shells (Gap C), is a polled pane-mirror good enough for the phone Terminal view and the Canvas terminal node?
3. `cc-aubut-` (claude in `~`, idle since 2026-10-27): end it, or resume it in herdr?
