import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkRepoMap, locateRepoMap, parseRepoMap, repoForNote, repoMapCandidates, repoMapCheckLine, resolveLiveCwd } from "./live-repo"
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

// Copied from claude-config tools/repo-map.ts (#21) — the format the live host reads today.
const REPO_MAP_TS = `
import { homedir } from "node:os";

export interface RepoEntry { name: string; match: RegExp; path: string; project: string }

export function buildRepoMap(home: string = homedir()): RepoEntry[] {
  return [
    { name: "tls-dashboard-v2", match: /dashboard|PRJ-WCLS|tls-dashboard/i, path: \`\${home}/tls-dashboard-v2\`, project: "PRJ-WCLS" },
    { name: "tls-review", match: /tls-review|PRJ-B9IU|review\\.cherrypik/i, path: \`\${home}/lanes/tls-review\`, project: "PRJ-B9IU" },
    // The agent config repo itself (claude-config). Same path on both hosts.
    { name: "claude-config", match: /architect-change-workflow|agent-eval-harness|claude-config/i, path: \`\${home}/.claude\`, project: "PRJ-LGDV" },
    { name: "companion-ios", match: /companion-ios|companion-rich-feed|muse-from-meta-ux-teardown/i, path: \`\${home}/apps/claude companion\`, project: "projects/2026-09-30-companion-ios-vault" },
    { name: "tls-video-assist", match: /tls-video-assist/i, path: \`\${home}/apps/TLS VIDEO ASSIST\`, project: "PRJ-VA1D" },
    { name: "tls-video-assist", match: /tls-video-assist/i, path: \`\${home}/lanes/tls-video-assist\`, project: "PRJ-VA1D" },
  ];
}

export const REPO_MAP = buildRepoMap();
`

describe("repo-map.ts (claude-config #21 format)", () => {
  test("parses name / match / \${home} path / project, in order", () => {
    const map = parseRepoMap(REPO_MAP_TS, "/home/aubut")
    expect(map.map((e) => e.path)).toEqual([
      "/home/aubut/tls-dashboard-v2", "/home/aubut/lanes/tls-review", "/home/aubut/.claude", "/home/aubut/apps/claude companion",
      "/home/aubut/apps/TLS VIDEO ASSIST", "/home/aubut/lanes/tls-video-assist",
    ])
    expect(map[0]).toMatchObject({ name: "tls-dashboard-v2", project: "PRJ-WCLS" })
    expect(map[0]!.match.test("projects/x TLS Dashboard")).toBe(true)
    expect(map[1]!.match.test("review.cherrypik")).toBe(true)
    expect(map[1]!.match.test("reviewXcherrypik")).toBe(false)
  })

  test("the old dispatch-run.ts format still parses (no name / project)", () => {
    const map = parseRepoMap(SOURCE, "/h")
    expect(map).toHaveLength(3)
    expect(map[0]!.name).toBeUndefined()
  })

  test("repo-map.ts is read first; dispatch-run.ts only when repo-map.ts is missing or empty; COMPANION_REPO_MAP pins one", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-repo-map-"))
    mkdirSync(join(home, "tls-dashboard-v2"), { recursive: true })
    const rm = join(home, "repo-map.ts"), dr = join(home, "dispatch-run.ts")
    writeFileSync(dr, SOURCE)
    // Old checkout: no repo-map.ts → dispatch-run.ts.
    expect(locateRepoMap([rm, dr])?.file).toBe(dr)
    // Moved (#21): dispatch-run.ts no longer holds entries → repo-map.ts.
    writeFileSync(rm, REPO_MAP_TS)
    writeFileSync(dr, "import { REPO_MAP } from './repo-map'\n")
    expect(locateRepoMap([rm, dr])?.file).toBe(rm)
    expect(repoMapCandidates({ COMPANION_REPO_MAP: rm })).toEqual([rm])
    expect(repoMapCandidates({ HOME: "/x" }).map((f) => f.split("/").pop())).toEqual(["repo-map.ts", "dispatch-run.ts"])
    const saved = process.env.HOME
    process.env.HOME = home
    try {
      expect(repoForNote("projects/2026-01-01-tls-dashboard", "TLS Dashboard", rm)).toBe(join(home, "tls-dashboard-v2"))
      const ok = checkRepoMap([rm, dr])
      expect(ok).toEqual({ file: rm, entries: 6, local: 1 })
      expect(repoMapCheckLine(ok, [rm, dr]).warn).toBe(false)
    } finally {
      process.env.HOME = saved
    }
  })

  test("self-check warns loudly when 0 entries parse or nothing is readable", () => {
    const home = mkdtempSync(join(tmpdir(), "cc-repo-map-0-"))
    const dr = join(home, "dispatch-run.ts")
    writeFileSync(dr, "import { REPO_MAP } from './repo-map'\n")
    const zero = checkRepoMap([join(home, "repo-map.ts"), dr])
    expect(zero).toEqual({ file: dr, entries: 0, local: 0 })
    expect(repoMapCheckLine(zero).warn).toBe(true)
    expect(repoMapCheckLine(zero).text).toContain("0 REPO_MAP entries")
    const none = checkRepoMap([join(home, "missing.ts")])
    expect(none.file).toBeNull()
    expect(repoMapCheckLine(none, [join(home, "missing.ts")]).warn).toBe(true)
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
