// Repo-level lint rules ast-grep can't see. Reads the git index, so the
// pre-commit hook judges what is being committed, not the working tree.

const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"

// lsFiles: `git ls-files -s -z`. settingsJson: the indexed brain/.claude/settings.json.
export function repoIssues(lsFiles: string, settingsJson: string): string[] {
  const issues: string[] = []
  let allow: string[] = []
  try {
    allow = (JSON.parse(settingsJson) as { permissions?: { allow?: string[] } } | null)?.permissions?.allow ?? []
  } catch {
    issues.push("brain/.claude/settings.json: not valid JSON")
  }
  for (const entry of lsFiles.split("\0")) {
    const [meta, path] = entry.split("\t")
    if (!meta || !path) continue
    // From claude-companion#48, #194, #195, #196: stray zero-byte files reached review.
    if (meta.split(" ")[1] === EMPTY_BLOB && !path.endsWith(".gitkeep")) issues.push(`${path}: zero-byte file`)
    // From claude-companion#248, #260, #262, #263: the headless brain can't run a tool it isn't allowed.
    const tool = path.match(/^brain\/bin\/([^/]+)$/)?.[1]
    if (!tool) continue
    for (const rule of [`Bash(bin/${tool}:*)`, `Bash(./bin/${tool}:*)`]) {
      if (!allow.includes(rule)) issues.push(`${path}: ${rule} missing from brain/.claude/settings.json`)
    }
  }
  return issues
}

if (import.meta.main) {
  const issues = repoIssues(
    await Bun.$`git ls-files -s -z`.text(),
    await Bun.$`git show :brain/.claude/settings.json`.text(),
  )
  for (const issue of issues) console.error(issue)
  if (issues.length) process.exit(1)
}
