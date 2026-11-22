# FIELD_GUIDE

Operational traps for workers. Injected at the start of every worker's first turn: keep it at 100 lines
or fewer (`bun run tools/archmap/cli.ts . --lint` blocks past that), sharp traps only. History goes in STATE.md.

## brain/bin/* run standalone

- Each `brain/bin/*` script finds the calling agent's pid by walking up the parent chain for a
  `claude` / `codex` / `gemini` process, and sends it as `X-Companion-Pid`.
- Run from a plain shell (no agent ancestor), it falls back to `$PPID`, the server's PID check fails
  and you get 403 `forbidden`. That is not a server bug: test the route with a unit test, not the CLI.
- Loopback only, and `X-Companion-Task-Id` must be `brain` or a live `lead-<repo>` session.

## worker-supervisor.ts stays under 600 lines

- `server/lib/worker-supervisor.ts` is at the archmap 600-line cap. Adding a feature means moving code out
  first (`worker-task.ts`, `field-guide.ts`, `worker-worktree.ts` are the existing homes), not growing it.
- Cap findings only warn, but the lint reports growth against main's map, so reviewers see every line added.

## architecture.json / architecture.md are generated

- Any change under `server/` (a new file, an export, a route, a line count) changes the map.
- Regenerate with `bun run tools/archmap/cli.ts . --quiet`, commit `architecture.json`, `architecture.md`
  (and `architecture.refs.json`), then confirm `bun run tools/archmap/cli.ts . --check --lint` passes.
- CI runs exactly that with `--baseline`. A stale map is a red build; never hand-edit the files.

## Paths that block bin/pr-merge (human merge)

- A PR touching `CLAUDE.md` (any depth), `.claude/*`, `settings*.json`, `hooks/`, `skills/`, `rules/`,
  `agents/`, `commands/`, `workflows/`, `mods/`, `output-styles/` or `memory/` is a human merge path:
  `bin/pr-merge` refuses it and only Jeremie merges.
- If the brief does not name those paths, do not touch them, even for a typo.

## Ship rule (WORKER_SHIP_RULE)

- Commit on your own `dispatch/<task id>` branch, push it, open ONE PR with `gh pr create`, put the link in
  your final report. Never merge it, never push to main, never end with staged or uncommitted changes.
- A skill or rule saying "the runner commits and opens the PR" does not apply to you.
- Never `--no-verify`: the local hooks are the CI.
