import { describe, expect, test } from "bun:test"
import { fixArgs } from "./resolver-fix"
import { conflictPolicyLines, deniedBy, fixDisallowed, ruleMatches } from "./resolver-fix-policy"

// The fix agent's git deny rules (Claude Code `Bash(<glob>)` syntax), checked
// against the commands that silently drop a PR's changes and the ones a careful
// hunk-by-hunk resolution needs.

const rules = fixDisallowed("main")

describe("fix agent git policy", () => {
  test.each([
    "git merge origin/main -X theirs", "git merge -X theirs origin/main", "git merge -Xtheirs origin/main", "git merge -X ours main",
    "git merge --strategy-option=theirs origin/main", "git merge --strategy-option theirs origin/main", "git merge -s ours origin/main",
    "git merge --strategy=ours origin/main", "git merge --strategy ours main", "git merge -sours main",
    "git rebase -X theirs origin/main", "git rebase --strategy-option=ours origin/main", "git rebase -s ours origin/main",
    "git pull -X theirs origin main", "git pull --strategy-option=theirs", "git pull -s ours origin main",
    "git -C /tmp/wt merge -X theirs origin/main", "git cherry-pick -X theirs abc123",
    "git checkout --theirs .", "git checkout --ours .", "git checkout --theirs -- .", "git checkout --ours -- src/", "git checkout --theirs server/lib/",
    "git checkout --theirs ./server", "git checkout --theirs '*.ts'", "git restore --theirs .", "git restore --ours -- :/",
    "git reset --hard", "git reset --hard HEAD~1", "git reset --hard origin/main", "git reset --hard main", "git reset --hard HEAD",
    "git reset --hard FETCH_HEAD", "git reset --hard @{u}", "git reset --hard abc123^", "git reset -q --hard origin/main",
    "git push", "git push origin HEAD:refs/heads/x", "git push --force origin x", "git push --force-with-lease", "git commit -am wip",
  ])("denied: %s", (cmd) => {
    expect(deniedBy(cmd, rules)).not.toBeNull()
  })

  test.each([
    "git merge origin/main", "git merge --no-edit origin/main", "git rebase origin/main", "git rebase --continue", "git rebase --abort",
    "git checkout --theirs server/lib/upload.ts", "git checkout --ours -- package.json", "git status", "git diff origin/main",
    "git log --oneline -5", "git reset --hard origin/dispatch/ab12cd34", "git add server/lib/x.ts", "git fetch origin main",
    "git merge feature/x-fix", "git show HEAD:server/lib/x.ts",
  ])("allowed: %s", (cmd) => {
    expect(deniedBy(cmd, rules)).toBeNull()
  })

  test("a non-main base is protected from reset --hard too", () => {
    const r = fixDisallowed("develop")
    expect(deniedBy("git reset --hard origin/develop", r)).not.toBeNull()
    expect(deniedBy("git reset --hard develop", r)).not.toBeNull()
  })

  test("the glob matcher: anchored, * = any run, \\* = a literal star", () => {
    expect(ruleMatches("Bash(git merge *-X*)", "git merge -X theirs")).toBe(true)
    expect(ruleMatches("Bash(git merge *-X*)", "echo git merge -X theirs")).toBe(false)
    expect(ruleMatches("Bash(git checkout *--theirs *\\**)", "git checkout --theirs src/*.ts")).toBe(true)
    expect(ruleMatches("Bash(git checkout *--theirs *\\**)", "git checkout --theirs src/a.ts")).toBe(false)
    expect(ruleMatches("Read(*)", "anything")).toBe(false)
  })

  test("the fix run's argv carries the deny rules; the prompt says the same", () => {
    const f = {
      prUrl: "https://github.com/jaubut/x/pull/1", number: 1, title: "t", repo: "/r", head: "dispatch/ab", base: "main",
      instructions: "do it", taskText: "", model: "claude-opus-5-5", timeoutMs: 1000,
    }
    const args = fixArgs(f, "/tmp/wt")
    const i = args.indexOf("--disallowedTools")
    expect(i).toBeGreaterThan(0)
    expect(args.slice(i + 1)).toEqual(rules)
    expect(args[1]).toContain("HUNK BY HUNK")
    expect(args[1]).toContain("RESOLVER_STATUS: blocked: conflicts in <files>")
    expect(conflictPolicyLines("dispatch/ab").join("\n")).toContain("origin/dispatch/ab")
  })
})
