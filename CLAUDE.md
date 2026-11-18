## Architecture map

- `architecture.json`, `architecture.md` and `architecture.refs.json` are regenerated on main by `.github/workflows/archmap.yml` after every push (`chore(archmap): regenerate [skip ci]`). Do not regenerate or commit them in a PR: that only makes PRs conflict.
- PR CI runs `bun run tools/archmap/cli.ts . --lint` against main's map: an import-boundary violation still fails the PR; a stale map does not.
- To read a fresh map locally (e.g. for `/change`), run `bun run tools/archmap/cli.ts .` and `git checkout -- architecture.*` before committing.
