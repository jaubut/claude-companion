import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { autoJudge, autoJudgeWithReason } from "./auto-judge"
import { judgeWithBranchContextAndReason } from "./branch-guard"

// Command/tool names chosen so no learned-allow row could ever match them.
const UNLISTED = "zz-companion-unlisted-cmd --flag"
const UNKNOWN_TOOL = "mcp__zz_companion_test__do_thing"

test("escalated Bash command carries a non-empty reason", () => {
  const j = autoJudgeWithReason("Bash", { command: UNLISTED })
  expect(j.verdict).toBe("ask")
  expect(j.reason).toBe("not on the Bash allowlist")
})

test("codex shell tools use the same allowlist reason", () => {
  expect(autoJudgeWithReason("exec_command", { cmd: UNLISTED })).toEqual({
    verdict: "ask", reason: "not on the Bash allowlist",
  })
})

test("secrets/env edits ask with a secrets reason", () => {
  for (const file_path of ["/repo/.env", "/repo/server.pem", "/repo/config/api-token.txt"]) {
    expect(autoJudgeWithReason("Write", { file_path })).toEqual({
      verdict: "ask", reason: "writes a secrets/env file",
    })
  }
})

test("Claude settings edits ask with a settings reason", () => {
  expect(autoJudgeWithReason("Edit", { file_path: "/repo/.claude/settings.local.json" })).toEqual({
    verdict: "ask", reason: "edits Claude settings",
  })
})

test("unknown tools ask with '<tool> not auto-approved'", () => {
  expect(autoJudgeWithReason(UNKNOWN_TOOL, {})).toEqual({
    verdict: "ask", reason: `${UNKNOWN_TOOL} not auto-approved`,
  })
})

test("auto-allow and auto-deny verdicts are unchanged", () => {
  expect(autoJudge("Read", { file_path: "/x" })).toBe("allow")
  expect(autoJudge("Bash", { command: "git status" })).toBe("allow")
  expect(autoJudge("Bash", { command: "ls -la | head" })).toBe("allow")
  expect(autoJudge("Edit", { file_path: "/repo/src/index.ts" })).toBe("allow")
  expect(autoJudge("Bash", { command: "rm -rf /" })).toBe("deny")
  expect(autoJudge("Bash", { command: "git push --force origin main" })).toBe("deny")
  expect(autoJudge("Bash", { command: "sudo ls" })).toBe("deny")
  expect(autoJudge("Bash", { command: UNLISTED })).toBe("ask")
  // Wrapper and reason variant always agree on the verdict.
  expect(autoJudgeWithReason("Bash", { command: "rm -rf /" }).verdict).toBe("deny")
  expect(autoJudgeWithReason("Bash", { command: "git status" }).verdict).toBe("allow")
})

test("setup prefixes (cd / VAR= / timeout) don't hide a safe verb", () => {
  for (const command of [
    "cd ~/claude-companion && git log --oneline -5",
    "S=/tmp/x; cd $S && cat out.txt",
    "cd /repo; timeout 30 grep -rn foo .",
    "cd ~/x && sed -n 1,40p a.ts",
  ]) expect(autoJudge("Bash", { command })).toBe("allow")
})

test("setup prefixes never strip command substitution or hide a denylisted verb", () => {
  expect(autoJudge("Bash", { command: `X=$(${UNLISTED}); cat y` })).toBe("ask")
  expect(autoJudge("Bash", { command: `cd $(${UNLISTED}) && ls` })).toBe("ask")
  expect(autoJudge("Bash", { command: "cd /repo && git push --force origin main" })).toBe("deny")
  expect(autoJudge("Bash", { command: `cd /repo && ${UNLISTED}` })).toBe("ask")
})

test("dangerous text inside data (heredoc / message flags) doesn't auto-deny", () => {
  const FORCE = "git push --force origin main"
  expect(autoJudge("Bash", { command: `cat >> notes.md <<'EOF'\n${FORCE}\nEOF` })).not.toBe("deny")
  expect(autoJudge("Bash", { command: `git commit -m "never ${FORCE}"` })).toBe("allow")
  expect(autoJudge("Bash", { command: `gh pr create --body "avoid ${FORCE}"` })).not.toBe("deny")
})

test("dangerous text that actually executes still denies", () => {
  expect(autoJudge("Bash", { command: "bash <<'EOF'\nrm -rf /\nEOF" })).toBe("deny")
  expect(autoJudge("Bash", { command: "cat <<'EOF' > x\nhi\nEOF\nsudo ls" })).toBe("deny")
  expect(autoJudge("Bash", { command: `bash -c "sudo ls"` })).toBe("deny")
})

function repoOn(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cc-branch-guard-"))
  const git = (...args: string[]) =>
    Bun.spawnSync({ cmd: ["git", "-C", dir, ...args], stdout: "ignore", stderr: "ignore" })
  git("init", "-q", "-b", branch)
  // An unborn branch has no name to rev-parse, so give it one commit.
  git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init")
  return dir
}

test("git push on a protected branch names the branch", async () => {
  const j = await judgeWithBranchContextAndReason("Bash", { command: "git push origin main" }, repoOn("main"))
  // A learned "git push" row on the host machine can legitimately auto-allow;
  // otherwise the escalation must name the protected branch.
  if (j.verdict === "ask") expect(j.reason).toBe("git push to protected branch main")
  else expect(j.verdict).toBe("allow")
})

test("git push on a feature branch still auto-allows", async () => {
  const j = await judgeWithBranchContextAndReason("Bash", { command: "git push -u origin feat/x" }, repoOn("feat/x"))
  expect(j.verdict).toBe("allow")
})
