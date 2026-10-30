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
| Live terminal bridge for those shells (terminal-bridge.ts, `/api/terminal`) | `tmux attach-session` under a PTY, raw byte stream | `herdr agent attach <agent>` attaches ONE agent terminal, but shells aren't agents. `herdr --session` attaches the whole multi-workspace UI, not one pane | **Gap C:** no raw single-pane attach for a plain shell. Use the pane-mirror WS instead (read + send-keys), which is screen polling, not a PTY stream |
| Mac Canvas terminal node | `TerminalAttach.swift`: SwiftTerm running `tmux attach` / `ssh -t zettlab tmux attach` (PRJ-FL49 core call) | same gap as C | **Gap C** (consumer outside this repo; the Mac repo checkout here is stale, so not verified) |
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

None of the three blocks retiring tmux for agents. B and C decide whether the phone and Canvas terminal views survive.

## 2. Biggest risks

1. **Brain safety lives in `herdr.service`, not tmux.**
   - The brain and every worker already run in herdr. A `systemctl --user restart herdr.service` (or a reboot without handoff) SIGKILLs them all. They come back only through herdr's own agent resume.
   - Cutting tmux makes herdr the single point of failure for every session. Stage 0 found that no unit setting keeps pane processes alive across a server stop. What it can do is refuse the routine restart and make every unavoidable stop resume cleanly (see Stage 0 results).
   - A resumed agent loses its pane env and launch args (Stage 0, finding 2). For the brain and the workers that is their identity.
2. **Gap C (terminal stream).** If the phone Terminal view and the Mac Canvas terminal must stay real PTYs (vim, Ctrl-C, scrollback), herdr has no equivalent for plain shells. The fallback, pane-mirror polling, is good for agents and weak for a shell running vim.
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
- Gap C is settled by decision: a polled terminal is acceptable (Jeremie, 2026-10-30), so no raw attach is needed.
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
  - This is a gate item for Stage 0b. Either the companion closes and respawns its own agents after a herdr restore (it already knows their session ids and has `spawn(resume)`), or identity moves off env (session record by session id). Not built here.
- **Untested:** `herdr update --handoff` (it downloads and replaces the live binary) and a real reboot.

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

### Stage 3b: dispatch runner + legacy task rows
- claude-config `dispatch-run` / `herdr-client.ts`: remove the tmux fallback (a gate failure becomes a loud requeue, not tmux). Same PR as the version-pin change in Stage 1 if possible.
- companion: delete the dead legacy-tmux task paths (`createTask(…tmuxSession)` with no callers, the `cancelLocal` kill-session). The DTO `tmuxSession`/`tmuxSocket` become null, then are removed after one iOS release.
- **Rollback:** revert.

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
