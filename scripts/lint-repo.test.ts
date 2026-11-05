import { describe, expect, test } from "bun:test"
import { repoIssues } from "./lint-repo"

const entry = (path: string, sha = "a".repeat(40)) => `100644 ${sha} 0\t${path}\0`
const EMPTY = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
const allowed = JSON.stringify({ permissions: { allow: ["Bash(bin/todo:*)", "Bash(./bin/todo:*)"] } })

describe("repoIssues", () => {
  test("passes a non-empty tree with an allowed tool", () => {
    expect(repoIssues(entry("server/a.ts") + entry("brain/bin/todo"), allowed)).toEqual([])
  })

  test("flags a zero-byte file, not a .gitkeep", () => {
    expect(repoIssues(entry("server/a.ts", EMPTY) + entry("logs/.gitkeep", EMPTY), allowed))
      .toEqual(["server/a.ts: zero-byte file"])
  })

  test("needs both allow forms for a brain tool", () => {
    const halfAllowed = JSON.stringify({ permissions: { allow: ["Bash(bin/media:*)"] } })
    expect(repoIssues(entry("brain/bin/media"), halfAllowed))
      .toEqual(["brain/bin/media: Bash(./bin/media:*) missing from brain/.claude/settings.json"])
  })

  test("ignores files nested under brain/bin", () => {
    expect(repoIssues(entry("brain/bin/lib/helper.sh"), allowed)).toEqual([])
  })

  test("reports unreadable settings instead of throwing", () => {
    expect(repoIssues("", "{")).toEqual(["brain/.claude/settings.json: not valid JSON"])
  })
})
