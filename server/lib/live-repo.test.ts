import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseRepoMap, repoForNote, resolveLiveCwd } from "./live-repo"
import { detectPrUrl, detectResultRef } from "./dispatch-tasks"

// Live-mode cwd resolution (P4): dispatch-run.ts's REPO_MAP read as text.

const SOURCE = `
const REPO_MAP: Array<{ match: RegExp; path: string }> = [
  { match: /dashboard|PRJ-WCLS|tls-dashboard/i, path: \`\${HOME}/tls-dashboard-v2\` },
  { match: /tls-review|PRJ-B9IU|review\\.cherrypik/i, path: \`\${HOME}/lanes/tls-review\` },
  // a comment line
  { match: /companion-ios/i, path: \`\${HOME}/apps/claude companion\` },
];
`

describe("parseRepoMap", () => {
  test("reads every entry, flags and escaped dots included", () => {
    const map = parseRepoMap(SOURCE, "/h")
    expect(map.map((e) => e.path)).toEqual(["/h/tls-dashboard-v2", "/h/lanes/tls-review", "/h/apps/claude companion"])
    expect(map[0]!.match.test("projects/x TLS Dashboard")).toBe(true)
    expect(map[1]!.match.test("review.cherrypik")).toBe(true)
    expect(map[1]!.match.test("reviewXcherrypik")).toBe(false)
  })

  test("repoForNote: first mapped entry whose directory exists here", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-live-repo-"))
    mkdirSync(join(home, "lanes", "tls-review"), { recursive: true })
    const file = join(home, "dispatch-run.ts")
    writeFileSync(file, SOURCE)
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      expect(repoForNote("projects/tls-review", "TLS Review", file)).toBe(join(home, "lanes", "tls-review"))
      expect(repoForNote("projects/d", "TLS Dashboard", file)).toBeNull() // mapped, not checked out here
      expect(repoForNote("projects/tls-review", "TLS Review", join(home, "missing.ts"))).toBeNull()
    } finally {
      process.env.HOME = saved
    }
  })

  test("resolveLiveCwd: explicit must exist; else task, then channel cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-live-cwd-"))
    expect(resolveLiveCwd({ explicit: dir })).toBe(dir)
    expect(resolveLiveCwd({ explicit: join(dir, "nope"), taskCwd: dir })).toBeNull()
    expect(resolveLiveCwd({ taskCwd: join(dir, "nope"), channelCwd: dir })).toBe(dir)
    expect(resolveLiveCwd({ taskCwd: "", channelCwd: null })).toBeNull()
  })
})

describe("worker output detection", () => {
  test("last PR URL and last RES ref", () => {
    const text = "see https://github.com/a/b/pull/1 then https://github.com/jaubut/claude-companion/pull/104. Note RES-AB12, RES-CD34"
    expect(detectPrUrl(text)).toBe("https://github.com/jaubut/claude-companion/pull/104")
    expect(detectResultRef(text)).toBe("RES-CD34")
    expect(detectPrUrl("no pr")).toBeNull()
    expect(detectResultRef("PRJ-WCLS only")).toBeNull()
  })
})
