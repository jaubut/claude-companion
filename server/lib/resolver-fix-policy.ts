// What the Opus fix agent may NOT do with git (lib/resolver-fix.ts passes these
// as `--disallowedTools` to the fix `claude -p` run; the prompt says the same).
// Blanket conflict strategies silently drop a PR's side of every conflict
// (claude-companion PR #76, fix commit 095d894b: `git merge origin/main -X theirs`),
// so they are denied outright; conflicts are resolved hunk by hunk or the agent
// stops with `blocked`. The server pushes, never the agent; never forced.
//
// Rules use Claude Code's permission syntax: `Bash(<glob>)`, `*` = any run of
// characters. A glob cannot say "a directory" or "any sha", so the post-run
// guards in lib/resolver-fix.ts (the PR head must stay an ancestor; no PR file
// reverted to main's version) catch whatever slips through the patterns.

/** Subcommands that take a merge strategy / strategy option. */
const STRATEGY_CMDS = ["merge", "rebase", "pull", "cherry-pick", "revert"] as const

/** `git <sub>` and `git <global opts> <sub>` (e.g. `git -C dir merge …`). */
const gitForms = (sub: string): string[] => [`git ${sub}`, `git * ${sub}`]

/** The deny rules for one fix run on a PR whose base branch is `base`. */
export function fixDisallowed(base: string): string[] {
  const rules: string[] = []
  for (const sub of STRATEGY_CMDS) {
    for (const g of gitForms(sub)) {
      rules.push(
        `Bash(${g} *-X*)`, `Bash(${g} *--strategy-option*)`,
        `Bash(${g} *-s ours*)`, `Bash(${g} *-sours*)`, `Bash(${g} *--strategy=ours*)`, `Bash(${g} *--strategy ours*)`,
      )
    }
  }
  // Whole-directory --theirs / --ours (a single named file stays possible; the post-run guard watches it).
  for (const sub of ["checkout", "restore"]) {
    for (const g of gitForms(sub)) {
      for (const side of ["--theirs", "--ours"]) {
        rules.push(`Bash(${g} *${side} .)`, `Bash(${g} *${side} -- .)`, `Bash(${g} *${side} ./*)`, `Bash(${g} *${side} -- ./*)`,
          `Bash(${g} *${side} :/*)`, `Bash(${g} *${side} -- :/*)`, `Bash(${g} *${side} */)`, `Bash(${g} *${side} *\\**)`)
      }
    }
  }
  // reset --hard: only to the PR's own remote branch (origin/<head>) — everything a glob can name is denied.
  const targets = ["HEAD*", "@*", "FETCH_HEAD*", "ORIG_HEAD*", "MERGE_HEAD*", "*~*", "*^*", "main*", "master*", "origin/main*", "origin/master*", "upstream/*"]
  if (base && !["main", "master"].includes(base)) targets.push(`${base}*`, `origin/${base}*`)
  for (const g of gitForms("reset")) {
    rules.push(`Bash(${g} --hard)`, `Bash(${g} * --hard)`, `Bash(${g} * --hard *)`, `Bash(${g} --hard * *)`)
    for (const t of targets) rules.push(`Bash(${g} --hard ${t})`)
  }
  // The server commits and pushes; the agent never does, let alone forced.
  for (const g of [...gitForms("push"), ...gitForms("commit")]) rules.push(`Bash(${g}*)`)
  return [...new Set(rules)]
}

/** Claude Code's `Bash(<glob>)` rule against one shell command (`*` = any characters, anchored). */
export function ruleMatches(rule: string, command: string): boolean {
  const m = /^Bash\((.*)\)$/s.exec(rule)
  if (!m) return false
  // `\*` in a rule is a literal star (the pattern for an argument containing a glob).
  const parts = m[1]!.split(/(\\\*|\*)/)
  const re = parts.map((p) => (p === "*" ? ".*" : p === "\\*" ? "\\*" : p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))).join("")
  return new RegExp(`^${re}$`, "s").test(command.trim())
}

/** The first rule that denies this command, or null. */
export function deniedBy(command: string, rules: readonly string[]): string | null {
  return rules.find((r) => ruleMatches(r, command)) ?? null
}

/** The prompt lines that say the same as the rules. */
export function conflictPolicyLines(head: string): string[] {
  return [
    "Merge conflicts: resolve them HUNK BY HUNK, keeping both the PR's change and the other side's where they are compatible.",
    "Never use a blanket strategy: no `-X theirs` / `-X ours` / `--strategy-option`, no `-s ours` / `--strategy=ours`, no `git checkout --theirs/--ours` (or `git restore`) on a directory or `.`.",
    `Never \`git reset --hard\` to anything but origin/${head}. Never drop or revert the PR's own changes to a file.`,
    'If a conflict is non-trivial (both sides changed the same logic, or you are unsure), make NO further changes and reply "RESOLVER_STATUS: blocked: conflicts in <files>" listing the files.',
  ]
}
