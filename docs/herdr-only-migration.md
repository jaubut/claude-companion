# Herdr-only migration plan: retire the `tmux -L cc` path

Status: PLAN for review (2026-10-30). No code changes in this PR.
Decision (Jeremie): Companion goes herdr-only, and the `tmux -L cc` path is retired.
Scope: the Companion server (Mac and Zettlab), the Zettlab systemd units, the `claude()` shell wrappers, and the Mac Canvas terminal node.

## 0. Where things stand (Zettlab, observed 2026-10-30)

- **Agents already run in herdr.**
  - herdr 0.9.5 runs as `herdr.service` (linger).
  - It hosts the brain (workspace `brain`, pane `w3T:p1`, `claude --remote-control brain`, `COMPANION_TASK_ID=brain`), every `builder-zettlab-*` worker, and the phone-spawned `cc-*` sessions.
  - This plan was written from a herdr pane (`w3V:p1`).
- **Which tmux the server uses:** Companion itself never targets `-L cc`. `COMPANION_TMUX_SOCKET` / `COMPANION_TMUX_CONF` are unset in the units, so a spawn fallback, a phone shell or the off-pane scrape all land on the **default** tmux server (`tmux-pane.ts:61-93`). `-L cc` is owned by the `claude()` wrapper and the two units. Retiring tmux therefore means both servers.
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
| Phone pane mirror (#234 / pane-mirror.ts) | tmux MirrorSource (wiring/pane-mirror.ts:37): `capture-pane -e -p` + `send-keys -H` through the key gate; no resize | herdr MirrorSource (:14, the original): socket `pane.read` visible/ansi every 50 ms (`events.subscribe` has no `pane_output_changed`, so it polls), `pane.send_text`, and `HerdrPaneSizer` sizes the pane to the smallest viewer | ✅ herdr is *ahead* (resize). **Gap A:** herdr mirror keystrokes skip the key gate (STATE.md, pane-mirror plan, deviation c). Route them through `herdrGateKey` before tmux goes |
| Plain shell from the phone (`sh-*`, shell-sessions.ts) | `tmux new-session` tagged `@companion_shell`; tmux *is* the record | none: a shell is not an agent, so nothing registers it | **Gap B:** needs a herdr record (see Stage 2) |
| Live terminal bridge for those shells (terminal-bridge.ts, `/api/terminal`) | `tmux attach-session` under a PTY, raw byte stream | `herdr terminal attach <terminal_id>` attaches ONE terminal, shells included | **Gap C: closed (Stage 2).** The 2026-10-30 read was wrong: the raw attach exists in 0.9.5. The PTY bridge stays and points at it |
| Mac Canvas terminal node | `TerminalAttach.swift`: SwiftTerm running `tmux attach` / `ssh -t zettlab tmux attach` (PRJ-FL49 core call) | `herdr terminal attach <terminal_id>` works there too, but the wire row doesn't carry the terminal id yet | **Follow-up in the iOS repo** (Stage 2 results) |
| Off-pane slash-command list (command-offpane*.ts) | a throwaway detached tmux session `cc-scrape-*` (220x60) runs a hidden `claude` with a temp HOME, hooks off and no MCP, scrapes `/help` by capture-pane, then is killed and confirmed dead | not ported | **Gap D:** a hidden herdr workspace would be visible in herdr's UI and detected as an agent by herdr's Claude integration, and its env must carry the temp HOME (`--env`). Port with those two checks, or drop it if #157's `/` suggestions already cover the list |
| Orchestrator "Run live" + legacy local tasks (orchestrator-db `tmux_session`/`tmux_socket`, DTO `tmuxSession`/`tmuxSocket` → iOS side chat, `cancelLocal` kill-session at routes/orchestrator.ts:182) | "Run live" now only logs `dispatch-runner: herdr`; the external `dispatch-run` (claude-config tools) spawns and has its own tmux fallback. `createTask(…tmuxSession)` has no callers | brain workers run in herdr (wiring/brain.ts:567, herdr only, no fallback) | **partial:** the DTO tmux fields are legacy. The real remaining tmux fallback is in `dispatch-run`/`herdr-client.ts`, outside this repo |
| Durability across reboot | resurrect + `cc-claude-resume` (`claude --resume <sid>`) | herdr keeps each pane's Claude session id (`~/.config/herdr/session.json`) and resumed all 7 Mac panes after the 0.9.5 server restart | ✅ for agents; shells are not resumed, which is the point |
| Server restart without killing agents | tmux server outlives Companion | `herdr update --handoff` = live handoff (untested here). Any stop ends every pane process (SIGHUP; panes are the server's PTY children), and herdr resumes them from `session.json`. Stage 0 makes `herdr.service` refuse a manual stop/restart | ⚠ see Risk 1 and Stage 0 results |

**The seam.** `server/lib/session-pane.ts` `sessionPaneOf()` is the one place that picks the driver: "tmux when the session has a tmux pane, else herdr". dialog-watch, pickers, model control and inject read and type through it. `discover.ts` maps ttys to tmux panes for ps-discovered sessions. Retiring tmux on the driving side means removing one branch in `sessionPaneOf`, plus the tmux discovery in `discover.ts` (Stage 5), not touching every consumer.

**Smaller parity gaps** (from the code map; each is a Stage 1–2 item):
- herdr inject refuses text with a leading `-`, because 0.9.3 had no `--` (`herdr-inject.ts:44`). Re-check on 0.9.5.
- `localTerminalAttached` is tmux-only (`#{session_attached}`, `question-hook.ts:72`), so a herdr pane always reads "not attached". Decide whether herdr's `focused` / client count can stand in.
- The submit failure hint still says "relaunch it in tmux (cc-tmux)" (`submit-confirm.ts:318`), and `scripts/cc-tmux` is still shipped.
- tty→pane discovery is tmux-only (`tmux-pane.ts:166`, `discover.ts:255`). herdr sessions are found only through `$HERDR_PANE_ID` in the hook or process env, which covers every herdr-launched claude.
- "Resume ended session" falls back to a tmux shell when its pane is gone (`routes/api.ts:256`).

**Bottom line.** Agent inject and output mirroring work on herdr today and have been verified on both hosts. The gaps are:
- **B and C:** plain shells and the raw terminal stream that the phone Terminal view and the Mac Canvas node attach to.
- **D:** off-pane commands.

None of the three blocks retiring tmux for agents. B and C decide whether the phone and Canvas terminal views survive. (Update 2026-11-05: C does not exist, see Stage 2 results.)

## 2. Biggest risks

1. **Brain safety lives in `herdr.service`, not tmux.**
   - The brain and every worker already run in herdr. A `systemctl --user restart herdr.service` (or a reboot without handoff) SIGKILLs them all. They come back only through herdr's own agent resume.
   - Cutting tmux makes herdr the single point of failure for every session. Stage 0 found that no unit setting keeps pane processes alive across a server stop. What it can do is refuse the routine restart and make every unavoidable stop resume cleanly (see Stage 0 results).
   - A resumed agent loses its pane env and launch args (Stage 0, finding 2). For the brain and the workers that is their identity.
2. **Gap C (terminal stream).** Obsolete (2026-11-05): `herdr terminal attach` is a real PTY stream, vim and Ctrl-C included. The remaining difference is one attach per terminal (Stage 2 results).
3. **The version pin.** Spawn uses herdr only when its version is in `HERDR_PINNED_VERSIONS` / `DISPATCH_HERDR_VERSIONS`. Today an unpinned version silently falls back to tmux. Once tmux is gone there is no fallback, so an unpinned upgrade breaks every spawn. The gate must become a loud error plus an upgrade checklist.
4. **Mac differs from Zettlab.** The Mac `auto` fallback is Terminal/iTerm running tmux, and the Mac server can't hand off on a brew upgrade. Run every stage on Zettlab first, then on the Mac.

## 3. Staged cutover

Each stage is shippable alone. The brain, the companion server and the running workers are never restarted by a stage. Code changes go through `/change` with the plan in STATE.md.

### Stage 0: make herdr safe to depend on (ops + one small PR)
- `herdr.service` (written by `scripts/herdr-zettlab-setup.sh`, which now rewrites it whenever it differs):
  - `RefuseManualStop=yes`: `systemctl --user stop|restart herdr` is refused. Shutdown and logout still stop the unit.
  - `ExecStop=-herdr server stop`: kept, because it saves `session.json` before the panes go. The `-` stops a hand-run `herdr server stop` reading as a crash, which would restart the server.
  - `ExecReload=herdr server reload-config`: `systemctl --user reload herdr` is the config path.
  - A deliberate restart is `herdr server stop`, then `systemctl --user start herdr`. The script's `HERDR_RESTART=1` path does exactly that.
- Pin: `HERDR_PINNED_VERSIONS = ["0.9.5", "0.9.3"]` (claude-config `tools/herdr-client.ts`); the setup script pins 0.9.5 plus its sha256.
- Gap C was settled by decision: a polled terminal is acceptable (Jeremie, 2026-10-30). Stage 2 found the raw attach, so the poll was not needed.
- **Apply on Zettlab** (from a login shell): `bash scripts/herdr-zettlab-setup.sh`. It does a daemon-reload only; the running server and its panes are not touched.
- **Rollback:** `cp ~/.config/systemd/user/herdr.service.bak-<date> ~/.config/systemd/user/herdr.service && systemctl --user daemon-reload` (again no restart), plus a revert of the claude-config pin PR.

#### Stage 0 results (2026-10-30, Zettlab, herdr 0.9.5)

All of these ran on a throwaway herdr session (`herdr --session s0probe` under a transient `systemd-run --user` unit with the new settings). The live server (PID 2141060, up since 2026-10-15) was never touched.
- **Restart refused:** `systemctl --user restart` → `Operation refused … configured to refuse manual start/stop` (exit 4), and `stop` likewise; the unit stays active. `systemctl --user reload` → exit 0, no restart. A hand-run `herdr server stop` with the `-` prefix → unit `inactive`, result `success`, 0 restarts. Without the `-`, the ExecStop failure made systemd restart it.
- **Cold-reboot equivalent:** after `systemctl --user kill -s SIGKILL` on the whole cgroup (no shutdown hook, like power loss), `Restart=on-failure` had the server back within 12 s (the check interval):
  - both workspaces and the same pane ids (`w1:p1`, `w2:p1`) came back;
  - the claude pane was relaunched as `claude --resume 02353638-…` with the same session id, and asked for the codeword it was given before the kill, it answered `ZEBRA-731`;
  - the plain shell came back as a new shell with its screen history.
  A clean `herdr server stop`, then a start, gave the same result. A real reboot was not done: that is Jeremie's call. The boot side is `UnitFileState=enabled` (WantedBy=default.target) plus `Linger=yes`. Zettlab has been up since 2026-10-06, so no real reboot has happened under herdr yet; the 2026-10-15 upgrade restart logged `session restore … workspaces=9`.
- **Polled plain shell:** the companion's own `PaneMirror` + `herdrSocketSource` (wiring/pane-mirror.ts) on a plain-shell pane:
  - first frame in 112 ms;
  - a typed `echo POLLED-$((6*7))` showed `POLLED-42` in a frame 32 ms later;
  - a raw `\x03` interrupted a `sleep 30`, and the next command ran;
  - colour reached the frame (`\e[1m\e[38;5;1mRED`);
  - frames were sent only when the screen changed.
- **Finding 1, the save window:** herdr writes `session.json` about 5 s after a change. A SIGKILL 2 s after creating a workspace lost that workspace; after an 8 s wait it survived. Power loss can drop the last ~5 s of layout changes.
- **Finding 2, env and args are not restored:** a pane created with `--env S0VAR=keepme` had `S0VAR` empty after the restore, and `session.json` stores no env. A resumed agent runs as `claude --resume <id>` only.
  - **The brain** (`spawnInHerdr(…, { COMPANION_TASK_ID: "brain" }, …, ["--remote-control", "brain"])`, wiring/brain.ts:567) would come back with the same conversation and herdr name, but without `COMPANION_TASK_ID=brain` and without Remote Control. The brain supervisor sees the herdr agent `brain` as alive and does not respawn it.
  - **Dispatch workers** lose their `COMPANION_TASK_ID` the same way.
  - This is a gate item for Stage 0b. Either the companion closes and respawns its own agents after a herdr restore (it already knows their session ids and has `spawn(resume)`), or identity moves off env (session record by session id). Built in Stage 0b, below.
- **Untested:** `herdr update --handoff` (it downloads and replaces the live binary) and a real reboot.

### Stage 0b: the brain gets its identity back after a restore (`wiring/brain-restore.ts`)

- **Pick: option A (close and respawn).** Option B (a session-id → task-id record) cannot bring back `--remote-control brain`, which is a launch arg, so the brain would still need a respawn. A also needs no change to hooks, sessions or the routes.
- **Detection:** the supervisor tick (15 s) stats herdr's API socket (`$HERDR_SOCKET_PATH`, else `~/.config/herdr/herdr.sock`). Every server start re-creates it, so a new inode + mtime means a new server instance. A stat makes no herdr call.
  - On a new instance (and once at Companion boot, which covers a reboot of both), it reads the env of the `brain` pane's shell (`pane process-info` → `/proc/<shell_pid>/environ`).
  - `COMPANION_TASK_ID=brain` → settled, no respawn. This covers a live handoff.
  - Missing → `brainWorkers.stopBrain()`, and `alive()` returns false. The supervisor's normal spawn then runs `--resume <kv session_id>`, with `COMPANION_TASK_ID=brain` and `--remote-control brain`.
  - Agent absent, or herdr or `/proc` unreadable → not settled, read again next tick (claude may still be starting in the restored pane).
- **No duplicate brain:** the instance is marked settled before the stop, so a restore gets one respawn. Ticks are serialized (`ticking`), and `spawnInHerdr` refuses a taken `brain` name (`name_taken` → stop, then the next tick spawns). The respawn counts against the restart budget (3 in 5 min).
- **Dispatch workers: not respawned, on purpose.** A restore already fails the runner's attempt (`dispatch-runner.ts herdrAttempt`: `server_unreachable` → "herdr lost the worker mid-run"; see its `TODO(WP5)`). A respawned worker would have nothing driving it.
  - What is left is the restored `dispatch-*` workspace without `DISPATCH_TASK_ID`. The reaper counts it as foreign and keeps it, so it needs a manual close. Re-attaching workers belongs to claude-config WP5.
- **Assumption, from Stage 0:** herdr gives the restored pane back its agent name `brain`. If it didn't, the supervisor would see the brain absent and spawn while the restored `claude --resume` ran. Stage 0 saw the name come back.
- **Unit tests:** `server/wiring/brain-restore.test.ts`, with a fake herdr. They cover the epoch change, the env read (ok, lost, absent, unknown), a single stop per restore, live handoff, a reboot of both, and an unreadable socket.
- **Live check: pending, run by Jeremie.** The dispatch sandbox refused to start a probe herdr server. Steps:
  1. `systemd-run --user --unit=s0bprobe herdr --session s0bprobe server`.
  2. In that session, `workspace create --label brain --env COMPANION_TASK_ID=brain` and `agent start brain --kind claude -- --remote-control s0b`. Send it a codeword.
  3. Note `stat -c '%i:%Y' <probe socket>` and `/proc/<shell_pid>/environ`.
  4. `systemctl --user kill -s SIGKILL s0bprobe`, then let it restart.
  5. Check that the socket stat changed and `COMPANION_TASK_ID` is gone, then run `createBrainRestore` against the probe (`HERDR_SOCKET_PATH` set to the probe's socket, for both the stat and the herdr CLI). It should log `herdr restore` and stop the agent once. A spawn with resume should bring back the codeword, the env and Remote Control.
  6. Never touch the live server.

### Stage 1: stop creating new tmux sessions (code, Zettlab then Mac)
- `spawn-session.ts`: `app: "auto"` → herdr only. A gate failure becomes an error (`herdr_unavailable: <reason>`), never a tmux fallback, the same as takeover today. `app: "tmux"` returns 400 `tmux_retired`. Mac Terminal/iTerm: dropped for Ghostty (Jeremie, 2026-11-01).
- The version gate becomes a hard error, with the pinned list moved to one env var on both hosts.
- `claude()` wrappers in `~/.bashrc` and `~/.zshrc` (claude-config): launch into herdr instead of `tmux -L cc` (`herdr workspace create` + `agent start`, as spawn does), or simply run `command claude` when already inside herdr.
- Existing tmux sessions keep working. Inject, mirror and dialogs still resolve their tmux pane, and the read paths are untouched.
- **Rollback:** revert the PR. The fallback code is still there.

#### Stage 1 results (companion side, 2026-11-01)

Shipped in `server/lib/spawn-session.ts` + `server/lib/herdr.ts`:
- `app: "auto"` is herdr only, on the Mac and Linux. A gate failure returns `herdr_unavailable: <reason>` (400 from `/api/spawn-session`) and logs `spawn: herdr unavailable (…), no tmux fallback`. `app: "herdr"` and takeover return the same error string; the brain's `spawnInHerdr` does too.
- `app: "tmux"` returns 400 `tmux_retired`, checked before the cwd is resolved or trusted, so a refused request has no side effect.
- Version gate: pinned list from one env var, `DISPATCH_HERDR_VERSIONS` (the name `dispatch-run` already reads, so one var covers both), default `0.9.5` (`HERDR_DEFAULT_PIN`). Unset no longer means the client's `0.9.5,0.9.3`. Neither host's units set the var today.
- Mac `terminal` / `iterm`: **dropped for Ghostty (2026-11-01)**. Both return 400 `app_retired` with `hint` (use `ghostty` or `auto`), before the cwd is resolved. `app: "ghostty"` (Mac only; Linux → macOS-only error) is the `auto` herdr spawn, then `herdr workspace focus <id>` and `open -na Ghostty.app --args -e <herdr>`: plain `herdr` attaches to the persistent session (herdr has no per-workspace attach), `-e` sets Ghostty's initial-command. A failed open is logged and the spawn still succeeds as `herdr`. `spawnInTerminal`, `spawnInIterm`, `spawnMacTerminalAuto` and `buildTmuxLaunch` are deleted. Tests in `spawn-herdr.test.ts`.
- Kept unreachable, not deleted (Stage 5): `spawnInTmuxDetached`, `tmux-spawn-confirm.ts`.
- Untouched: inject, pane mirror, dialogs and every read path still resolve tmux panes, so existing tmux sessions keep working (their tests are unchanged and green).
- Tests: `server/lib/spawn-herdr.test.ts` (the spawn half of `herdr.test.ts`, split out because that file was over the 600-line cap; the fake moved to `herdr-fake.test-util.ts`): auto → herdr, gate failure → `herdr_unavailable` with nothing created and no tmux, app tmux → `tmux_retired`.
- Not in this PR: the `claude()` wrappers and the dispatch-run pin/fallback (claude-config).

### Stage 2: shells on herdr (Gaps B and C)
- `shell-sessions.ts`: a phone shell becomes a herdr workspace labelled `sh-<dir>` with a known metadata tag (`pane report-metadata` or workspace label). The record is read back from `herdr pane list` instead of tmux options. A restart still loses nothing.
- `terminal-bridge.ts`: if the Stage 0 spike finds a raw attach, keep the PTY bridge pointed at it. If not, the phone Terminal view switches to the pane-mirror WS (`/api/pane-mirror`, herdr MirrorSource), which also needs an iOS change.
- Mac Canvas terminal node: the same choice, in the Mac repo (follow-up task, agent:builder).
- **Rollback:** revert. Existing tmux shells were never touched.

#### Stage 2 results (2026-11-05, Zettlab, herdr 0.9.5)

**The plan was out of date on one point.** `herdr terminal attach <terminal_id>` is a raw single-terminal attach, so the plan's "if the spike finds a raw attach" branch applies: `/api/terminal` keeps its PTY bridge and its frames, and the phone needs **no iOS change**. The pane-mirror switch was not done.

Shipped in `server/lib/shell-sessions.ts` + `server/lib/terminal-bridge.ts`:
- A phone shell is a pane marked `phone-shell` (`pane rename`) in a herdr workspace labelled `sh-<dir>` (`--no-focus`), read back from `workspace list` + `pane list` every 3 s. The mark is what makes it a shell: it survives a restore, and a split never inherits it. The workspace label is only the row's name: a workspace with no marked pane is not a shell, whatever it is called, and a label with two marked panes gives no row until it is unique.
- A gate failure is `herdr_unavailable: <reason>`, never tmux. The spawn reply says `app: "herdr"`.
- `/api/terminal` runs `herdr terminal attach <terminal_id> --takeover`. Closing the socket detaches, and the shell keeps running.
- The `shell` wire row carries `herdrPane`, with `tmuxPane` and `tmuxSocket` empty. iOS `isLive` and `ShellSessions.pair` already handle that (read from `claude-companion-ios` main): pairing uses `panePid` + `claudeKey`, and the session row is mirrored through its `herdrPane`.
- A Claude started in a shell needs nothing: the pane has `HERDR_ENV=1` (the `claude()` wrapper stays out of tmux) and `$HERDR_PANE_ID`, so its hooks register an ordinary herdr session. `linkClaude` matches on the herdr pane.
- Close on a herdr shell is refused before anything else: 409, `code: close_unavailable`, `error: "Type exit in the shell to close it"`, nothing detached, the row stays. `shell-sessions.ts` issues no `pane close` and no `workspace close` on any path. `exit` ends a shell, and the row drops on the next poll. See Close follow-up below.
- A Claude that exits in a shell leaves no `ended` row, because the row's Delete would close the shell. `herdrSessionGone` counts listed shells as live, and `paneInfo` in `ended-sessions.ts` reads a pane carrying the mark as gone, which also covers a shell the list hasn't seen yet: nothing records it, the sweep drops it, and Delete's last read before `pane close` refuses it. `closableWorkspace` in `herdr.ts` refuses the mark too.
- A herdr blip keeps the rows (`readHerdrShells` → null, not an empty list). Spawns are serialized, because herdr allows two workspaces with one label.
- Spawn never reuses a shell name listed in the last 24 h, live or exited (in memory, last 2000 names; a restart forgets them), so a late Close finds no row.
- A tmux shell's Close is main's, unchanged: by name, deciding on what the store and the agent list hold when the request arrives. Every change tried in #294/#295 (kill by `$N`, re-reads in a turn, an arrival snapshot) drew a new race, so it stays as it was.
- tmux shells stay listed and attachable until Stage 5. A new name avoids theirs, since both share the `shell:` key space.

**Proof.** A second Companion server from this branch (port 47245, own HOME, DB and token) on a throwaway herdr session, with the live server and live herdr untouched. A script drove the phone's real endpoints (`/api/spawn-session`, `/api/terminal`, `/api/pane-mirror`, `/api/inject`, `/api/shell/close`). The probe Claude used copies of these hooks rewritten to port 47245, because the installed hook hardcodes 4245.
- Shell: spawn → row with `herdrPane w1:p1`, `tmuxPane ""`, `panePid` set; typed `echo`, Ctrl-C and `cd` all worked, and the row's cwd followed.
- **The trigger case:** `claude` typed through `/api/terminal` registered as `agent: claude`, `herdrPane w1:p1`, `tmuxPane ""`. The shell row linked it (`claudeKey`). Close → 409 `claude_running`. `/api/pane-mirror` showed its TUI, `/api/inject` → `confirmed:true`, and the reply `PINEAPPLE` appeared in the mirror. `/exit` from the mirror → the Claude row left, the shell row stayed unlinked, no `ended` row.
- Attach probes (PTY under `herdr terminal attach`): resize reaches `stty size`; ^A through ^Z (except ^S/^Q) reach the pane as bytes; SGR mouse and wheel bytes print nothing into the shell; vim opens and quits; a terminal's DA replies don't leak.
- Failure paths: Companion restart → row back (same pid); SIGKILL of the herdr unit → row back, same key, new shell; `exit` → socket 4000 `ended`, row gone; second socket → takes over, first gets 4000, row stays; a legacy tagged tmux shell on a private tmux server is listed, attaches, closes; a full `herdr` client stays attached through a takeover.
- Tests: `bun test --isolate` (as CI) 2596 pass, 6 fail, all 6 failing on main too in this sandbox; typecheck clean.

**Proof after Close was removed (2026-11-07, Zettlab, herdr 0.9.5).** Same setup as below, unsandboxed because herdr needs unix sockets: spawn, mark visible, attach, typed output, Close refused with the row intact and the shell still typing, `exit` removes the row with no error, Companion restart with a split lists the shell and never the split. Output is in #289. The Close results in the proofs below are history: they ran on code this PR removed.

**Proof against the mark (2026-11-07, Zettlab, herdr 0.9.5).** The proof above predates the mark. This one ran on the merged code, same setup: a Companion from the branch on port 47245 (own HOME, DB and token, brain off) on a throwaway herdr with its own HOME and socket, unsandboxed because herdr needs unix sockets. Not on the live server, live herdr or the Mac. Claude was the real CLI with a dummy key; "session hooks" are scratch copies of SessionStart and SessionEnd pointed at 47245. Full output is in #289.
```
spawn {"status":200,"ok":true,"app":"herdr","cwd":"/tmp/claude-1000/s2w","agent":"shell","key":"shell:sh-s2w","sessionName":"sh-s2w"}
mark visible in herdr: ["w1:p1:phone-shell"]
attach, typed output seen: true
split: ["w1:p1:phone-shell","w1:p2:(no mark)"]
Companion restarted
  rows [ "sh-s2w w1:p1" ] labels [ "sh-s2w" ] panes [ "w1:p1/1ec1", "w1:p2/7282" ]
attach after restart, typed output seen: true
close {"status":200,"ok":true,"gone":false}
socket closed: 4000 closed
  rows [] labels [ "sh-s2w" ] panes [ "w1:p2/7282" ]
close retry {"status":200,"ok":true,"gone":true}
split alive after retry: true
```
- herdr probes: the mark survives SIGKILL + restore and a clean restart, follows its pane through a swap, ignores a title escape and a running Claude, and disappears with the pane. Splits and new tabs don't inherit it. `pane list` is layout order, not id order. A closed pane's id isn't reused in its workspace, but a restore reissues ids it lost.
- Restore with a split: same marked pane, new terminal, attach works, Close takes only that pane. Companion restart with a split: the row stays. A shell exiting while Companion is down leaves no row, and the split is untouched. An `sh-*` workspace with no mark is not a shell.
- Two workspaces with one label: no row, Close 404, both alive; unique again, both back. Close, reopen, retry: reopened under a new name, the retry answers `gone:true` and the new shell lives.
- Close: 409 with Claude in front and while suspended (with hooks and without); after `/exit` 409 until the next poll clears the link, then 200.

**Behaviour change: one attach per terminal (accepted by Jeremie, 2026-11-05).** tmux let a phone and an iPad share a shell. herdr refuses a second attach, so ours takes over: the newest device wins and the other gets close 4000, which the app shows as "Session ended" although the shell lives; tapping the row takes it back. A shell being mirrored and attached at once is fine (the sizer's `control` exits, the mirror keeps the pane's width).

**Where it can fail in production:**
- The Mac side is unverified: same code, herdr pinned, but it was not run there, and the Mac server is 27 commits behind.
- A human relabelling a shell's pane takes it off the phone; giving another pane the `phone-shell` label puts that pane on it.
- Two workspaces with one label take both shells off the phone until one is renamed.
- **The phone's Close doesn't work on herdr shells** (kept off: herdr has no checked close; see Close follow-up, Outcome). `exit` in the shell ends one. tmux shells are unaffected. Accepted by Jeremie, relayed by the brain, 2026-11-07. The phone shows "Couldn't close the terminal (Type exit in the shell to close it)" and the row comes back.
- A failed spawn closes nothing, so it can leave a workspace behind, and its label stays taken: the next spawn there gets `sh-<dir>-2`. A marked one is a row that `exit` ends. An unmarked one needs `herdr workspace close`.
- A herdr workspace renamed onto a tmux shell's name gives no row until it moves: one name can't be two rows, and attach looks a key up. The tmux shell keeps the name.
- An attach ending refreshes the list outside the spawn turn (`wiring/shell-sessions.ts`), so a new row can vanish, or a closed one come back, for up to 3 s. The poll itself no longer can (`storeGen`).
- `shell-sessions.test.ts` "exit: the row drops on the next poll" uses a 5 ms interval and short sleeps, so it could flake on a loaded runner.
- A refused resume keeps the shell. The phone reads it as a failed launch whose text says the terminal is open, and the row appears; it doesn't open the terminal by itself.
- `herdr` not on the server's PATH (launchd): `spawnPty` throws at the WS open. `HERDR_BIN` covers it, same as spawn.
- A pane keeps the last attach's size after detach, with no client to restore it (`pane layout` still says 220x60, `stty size` says the phone's). Cosmetic until something else sizes it.

**iOS follow-ups (list for a Mac builder, none block the phone):**
1. Canvas `TerminalAttach.swift`: `command(for:)` requires `tmuxPane`, so a herdr shell node gets no attach. Needs `terminalId` on the wire (additive, not added here) and `herdr terminal attach <id> --takeover`, locally or through `ssh -t`.
2. `TerminalScreen`: a takeover closes with 4000, which reads "Session ended / The shell exited". It needs takeover wording, e.g. "Opened on another device. Tap to take it back." The server sends the same close for both today; a `taken_over` reason is a small server change once the app reads it.
3. Stale comments: "tmux session", "tmux's status line".

### Close follow-up

Every P1 from round 1 on was in a destructive path, so #289 ships spawn, attach and list, and Close gets its own task. Everything below restores on top of this.

**Outcome (2026-11-07, Jeremie through the brain):** herdr Close stays off. herdr has no checked close: nothing makes `pane close` conditional on the terminal and agent a read just saw, and #294's five review rounds kept finding the next window. #294 does not merge. Its safe parts landed separately (#295): the 24 h name reservation, the `storeGen` poll fix and the `spawn-session.ts:332` guard. tmux Close stays main's: each change to it drew a new race. Follow-ups: a Close that names its terminal (the phone sending the terminal id, iOS + server), and the queued tmux Close race (a tmux Close decides on the agent list and link it read when the request arrived, so a Claude started in that window can still be killed). The notes below stay as the record of what herdr Close would need.

- **What to restore:** commit `b7ceda1` holds the working Close: `closeTerminal`, `herdrPaneNow`, the `closedShells` tombstones keyed by name and terminal, the fresh read in `closeShellSession`, and their tests in `shell-sessions.test.ts`. It is in #289's commits; read it with `git show b7ceda1:server/lib/shell-sessions.ts`. Keep the `closedNames` tmux path until Stage 5.
- **The rule:** the final read before `pane close` checks terminal and agent, and refuses on an unreadable pane. At b7ceda1 that read checks only the terminal.
- **Tombstone before refresh:** record a successful close before awaiting the listing that follows it.
- **Open P1, final read ignores `agent` (b7ceda1 `:232`):** Close kills a running Claude if the first read failed or Claude started during validation. Claude's auto-review reproduced the failed read too.
- **Open P1, refresh failure loses the close (b7ceda1 `:202`):** a close followed by a listing failure returns `kill_failed` before recording the name. A new spawn reuses it and the retry destroys the new shell. Also tell cached fallback rows from verified survivors.
- **`abandon`:** restore cleanup only through that same verified close. Until then a failed spawn leaks, as above.
- **`spawn-session.ts:332`** (fixed, 2026-11-07: a failed `agent start` closes its workspace only through `closableWorkspace` with the owner recorded at create)**:** the same bare-workspace-id cleanup `abandon` had, on the agent spawn path. It reaches a marked pane only if herdr reissues that id between create and a failed start. No pane is read there, so a mark check isn't one line.
- **Other closes outside `shell-sessions.ts`, checked in #289:** `ended-sessions.ts` and `herdr.ts:245` now refuse the mark. `brain-lead.ts:109` needs its label, one pane and the lead's agent. `brain-workers.ts:187` needs a `brain` or `dispatch-*` label and one pane. `brain-workers.ts:247` closes the `brain` agent's own workspace. A human relabelling or marking could still put a marked pane under these three. Checking there isn't one line: `herdrWorkspacePanes` doesn't return the label.
- **Phone:** none needed for the server to work, but the notice can drop its wrapper. Swipe-to-close on a herdr row stays misleading while herdr Close is off (a Close naming its terminal is the iOS + server follow-up).

**Rollback:** revert the PR. Herdr shells created meanwhile keep running as plain workspaces and leave the phone's list (close them with `herdr workspace close`). tmux shells were never touched.

### Stage 3: off-pane commands (Gap D)
- `command-offpane*.ts`: run the hidden capture in a hidden herdr workspace (`workspace create` + `pane run` + `pane read`), or drop off-pane commands if the herdr `/` suggestions path from #157 already covers them. Decide after measuring how often off-pane runs today.
- **Rollback:** revert.

#### Stage 3 results (2026-11-05, Zettlab, herdr 0.9.5)

**Measured first.** In `companion.log` (2026-09-24 → today): 104 good off-pane lists, the last on **2026-10-10**, and 610 aborted runs, nearly all `boot: pane never came up` in 0.5 s. So the phone's full command list has been broken on Zettlab for about four weeks, unrelated to herdr.

**Root cause.** The server's PATH finds the `~/.bun/bin/claude` shim first. It runs `exec "$HOME/.local/bin/claude"`, and `$HOME` is the throwaway one, so the hidden claude died at once. A run that resolved the real binary listed 264 commands in 32 s.

**Decision: port, don't drop.** The `/` suggestions don't cover it: they type into the user's pane (what off-pane exists to avoid), return only the menu's rows, and a plain shell's palette has no pane to type in.

Shipped:
- `server/lib/command-offpane-launch.ts`: `~/.local/bin/claude` first, then PATH. The shim's secrets are not loaded for the hidden claude, which needs none.
- `server/lib/command-offpane-herdr.ts`: a `TmuxRunner` answering the verbs the enumeration and the reaper use, from herdr. The lifecycle code (reap, kill confirmation, throwaway HOME) and its tests are unchanged. `defaultTmux` is deleted, so off-pane can no longer start a tmux session. Stage 5 can flatten the verbs.
- Gap D's two checks: the workspace is `--no-focus` and visible in a herdr client for ~30 s, which is accepted. herdr detects the claude as an agent, and nothing reads that. The temp HOME travels in the typed command, not `--env`.

**Proof.** A test server from this branch with the live server's PATH shape, on a throwaway herdr session: `POST /api/command/list` → 200, 264 commands in 33.0 s; mid-run the workspace was unfocused and no session row appeared; after, the workspace was gone and no tmux server had started. An orphan `cc-scrape-999999-*` workspace (dead owner) was reaped. 6 new tests in `command-offpane-herdr.test.ts`.

**Side effect of that proof run.** The test server was given the real HOME for the throwaway-HOME copy, so it also loaded the real `.env` and ran the background jobs for about a minute: 8 duplicate `triage:expired` rows in Turso `agent_activity` (ids 23146–23153), and two resolver analyses started and cut off. No task, PR or proposal changed. A test server on a real HOME must not be repeated.

**Pane identity (amended 2026-11-07, #269 review: Codex P1 + P2 at b8af305).** herdr reuses pane and workspace ids, so an id never proves a pane is the scrape's. Right after `workspace create`, a `pane get` checks that the pane still holds the terminal and workspace create returned; only then is it labelled `companion-scrape:<session name>` (prefix `SCRAPE_PANE_MARK`, herdr.ts), so a reused id never loses its own label (a phone shell keeps `phone-shell`). The runner records the pane, terminal and workspace ids create returned. The name in the mark binds the pane to one scrape: the reaper adopts only a pane whose label names its workspace's `cc-scrape-*` label, so a reused workspace id can't pair a dead owner's label with a newer scrape's pane (round 3, Codex P2 at 6c6ca9b). One check, `ownedScrape` in `command-offpane-herdr.ts`, reads `pane get` before every `pane run`, read, `send-text`/`send-keys` and close: mark, terminal and workspace must all match. A pane that is gone or not ours marks its record gone for good (a later matching answer gets nothing); an unreadable answer is -1, so nothing is released. Each runner drives one enumeration and reads and types only through the record it created, never through whichever record holds a pane id now, so after a reuse an old scrape reaches neither pane. Kill closes our pane only, never the workspace (round 2, Codex P1 at d5b3332: a split can land after any read of the workspace); the workspace goes with its last pane. That herdr 0.9.5 removes a workspace with its last pane was observed in #289's live proof, not re-run on this head: #289's PR body, "Attach proof on fb57aba", step "exit removes the row" (the sole pane's shell exits, then `labels []`), with "exit beside a split" keeping the label. That run saw a pane exit, not `pane close`. As a fallback, kill re-reads the workspace after `pane close`: if it still exists, under this scrape's name and with zero panes on two reads in a row, it gets one `workspace close`. A workspace with any pane, under another name, or unreadable is never closed (round 4). A gone record is how has-session confirms the kill while a split keeps the label. A workspace wearing a `cc-scrape-*` label with no record is never closed and never reads as gone. After a restart the reaper adopts a listed workspace by its single marked pane. An unmarked one is listed with no pane, and the reaper treats a pane-less row as foreign: never killed, never pending, never retried (round 4). The HOME sweep skips any HOME a live process still runs in (its `HOME=` in `/proc/<pid>/environ`, or `ps eww` off Linux), so a tmux scrape that survives the deploy keeps its HOME until its claude exits; if that scan fails, nothing is swept (round 4, Codex P2 at 28a6e55). Composition with Stage 2: a pane has one label, `readHerdrShells` keeps only `phone-shell` exactly and `ownedScrape` only `companion-scrape:<its own name>` exactly, so a scrape is never a shell row and a shell never a scrape. `paneInfo` and `closableWorkspace` need nothing: the hidden claude has hooks off, so it never makes an ended row, and it is never a spawned agent. Ceiling: herdr 0.9.5 has no compare-and-send, so a reuse in the few ms between the check and the act is not covered. Whether pane verbs take a terminal id instead was not probed (no throwaway herdr in that session).

**Pids.** The claude's pid is `process-info`'s `shell_pid` (the typed line `exec`s claude). It is read before anything is typed: no pid, no claude, so a HOME is only deleted once a known pid has exited. A `pane run` whose reply is lost may still have launched claude, so its pane and pid go back with the failure and cleanup waits for that pid. A known pid is never replaced by a looked-up one, in the runner or in the reaper's pending kills. When adopting after a restart, a looked-up pid counts only if a `pane get` right after it still shows the listed terminal, workspace and mark; otherwise the listing is no inventory (round 4, Codex P2 at 4b1b516).

**Failed rename (round 4, Codex P2 at 4b1b516).** The record from create is kept as pre-launch ownership, marked unmarked. Cleanup closes that pane only after a fresh `pane get` shows the same terminal and workspace and no agent; nothing was launched, so there is no pid to wait for. If that can't be shown, the pane is left: a leak, never a close on a name. After a Companion restart such a pane has no record and is never closed (`herdr workspace list | grep cc-scrape-`, then close it by hand). A listing with an unreadable pid, or with two marked panes under one label, is no inventory: nothing is released or swept. A pending kill keeps its pid when herdr no longer lists the pane.

**Where it can fail in production:**
- A scrape running when this deploys was made by the old build and has no mark, so the new reaper keeps its HOME and never closes it. Check after deploy with `herdr workspace list | grep cc-scrape-` and close a leftover by hand with `herdr workspace close <workspace_id>`. Its HOME goes on the next sweep after that.
- It works again, so hidden claudes come back: one ~30 s run per new fingerprint, at most 2 at once.
- A login shell other than bash or zsh: the typed `export …` line assumes a POSIX shell.
- A Mac pane has its own size (no 220x60), and the Mac path was not run. The rows-per-page parsing is size-independent; a mid-run keychain prompt is unverified.
- A login shell that prints a dialog on start would read as a slow boot, then `timeout`.

**Rollback:** revert. Off-pane goes back to the tmux path, broken as before.

### Stage 3b: dispatch runner + legacy task rows
- claude-config `dispatch-run` / `herdr-client.ts`: remove the tmux fallback (a gate failure becomes a loud requeue, not tmux). Same PR as the version-pin change in Stage 1 if possible.
- companion: delete the dead legacy-tmux task paths (`createTask(…tmuxSession)` with no callers, the `cancelLocal` kill-session). The DTO `tmuxSession`/`tmuxSocket` become null, then are removed after one iOS release.
- **Rollback:** revert.

#### Stage 3b results (companion side, 2026-11-05)

Checked against today's code first:
- **The kill-session path is dead:** no local task with a `tmux_session` is active (only 4 old `error` rows have one), `createTask` has no production caller, and nothing starts a local worker since one-stream A2.
- **The DTO fields are unread:** iOS `OrchestratorModels` decodes `tmuxSession` into a private field and never reads it, and `tmuxSocket` not at all. Side chat comes from `mode` and `sessionKey`.
- **Obsolete: "`herdrPane` added" to the task DTO.** Nothing would read it, so it was not added.
- **claude-config: nothing left to do.** `ad4adebe` (Stage 1, claude-config) already removed it: `dispatch-run.ts` has no tmux fallback left (its one `tmux` is a comment), and `tools/claude-wrapper.sh` is the herdr `claude()` wrapper.

Shipped: `cancelLocal` no longer spawns tmux; `Task` no longer carries the fields; `createTask` lost the `tmuxSession` argument; `tmuxSession` and `tmuxSocket` are always null on the wire, removed after one iOS release. `orchestrator_tasks` keeps its columns, with no migration, and new rows leave them NULL.

**Still blocks Stage 4:** Zettlab's `~/.bashrc` still defines the old `claude()` and never sources `tools/claude-wrapper.sh`, so an interactive `claude` outside herdr (an SSH login) still starts `tmux -L cc`. Fix, by hand on each host, in a login shell: delete the old function and add `[ -r "$HOME/.claude/tools/claude-wrapper.sh" ] && . "$HOME/.claude/tools/claude-wrapper.sh"`. The Mac's `~/.zshrc` was not checked.

**Rollback:** revert. **Could fail:** an iOS build older than the checked `main` that reads `tmuxSession`; `try?` decoding tolerates null either way.

### Stage 4: retire the tmux ops (Zettlab, then Mac)
Only after Stages 1–3 have run for a week with zero tmux spawns. Note (2026-11-05): `grep "app=tmux"` matches nothing, at any date, because no log line has that text. Use the session creation times instead: no session newer than the last merge in `tmux list-sessions` and `tmux -L cc list-sessions`. The commands below are the exact steps.
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
- **Also:** `scripts/cc-tmux`, the `submit-confirm.ts` "relaunch in tmux" hint, the tmux branch of `sessionPaneOf` and of the dialog / model-control / command-menu / auto-compact twins, `removeSessionByTmuxPane` / `socketForPane` (`sessions.ts:554,571`), and `ensureUtf8Locale`, if only tmux needed it.
- **Rewrite:** `shell-sessions.ts` (Stage 2), `terminal-bridge.ts` (Stage 2), `herdrPaneOf`. The "tmux inside herdr defers to tmux" rule goes once no wrapper puts tmux in a herdr pane.
- **Keep as contract (iOS):** session JSON `tmuxPane`/`tmuxSocket` stay as `""` for one iOS release, because shipped builds decode them, then they are removed. iOS works out "can mirror" from "has a pane" (there is no server `canMirror` field), so `herdrPane` must be set on every mirrorable session before `tmuxPane` empties.
- **Rollback:** revert per module. Stage 4 is reversible separately.

## 4. Deleted vs rewritten (summary)

| module | fate |
|---|---|
| tmux spawn (detached / Terminal / iTerm), `tmux-spawn-confirm.ts` | delete (Stage 5) |
| `tmux-pane.ts`, tmux branch of `keyboard-inject.ts` | delete (Stage 5); the key gate stays, herdr side only |
| tmux `MirrorSource` (#234) | delete (Stage 5) |
| `shell-sessions.ts` | rewritten on herdr (Stage 2); tmux read and kill deleted in Stage 5 |
| `terminal-bridge.ts` | kept, on `herdr terminal attach` (Stage 2); tmux argv deleted in Stage 5 |
| `command-offpane*.ts` | ported to herdr (Stage 3); flatten the verbs in Stage 5 |
| `tmux-resurrect-boot.service`, `tmux-cc-save.{timer,service}`, `cc-claude-*`, `~/.tmux/cc.conf` | remove (Stage 4) |
| `claude()` wrappers (bashrc/zshrc, claude-config) | rewrite to herdr (Stage 1) |
| `hooks/_lib.sh` tmux headers | delete (Stage 5) |
| orchestrator live-row `tmux_session`/`tmux_socket` + DTO `tmuxSession`/`tmuxSocket` | tmux fields null (Stage 3b), then removed after one iOS release; no `herdrPane` needed |
| session JSON `tmuxPane` | empty for one iOS release, then remove |

## 5. Open questions for Jeremie
1. ~~Mac `terminal` / `iterm` spawn apps: drop them or keep them?~~ Dropped for `ghostty` (2026-11-01, Stage 1).
2. ~~If herdr has no raw attach for shells (Gap C), is a polled pane-mirror good enough?~~ It has one (Stage 2).
3. `cc-aubut-` (claude in `~`, idle since 2026-10-27): end it, or resume it in herdr?
