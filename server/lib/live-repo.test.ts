import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type HostProbe, XCODE_LIVE_REASON, checkRepoMap, fixRepoHere, hostCan, localRepoFor, locateRepoMap, parseRepoMap, parseRequires, repoForNote,
  repoMapCandidates, repoMapCheckLine, resolveLiveCwd, resolveLiveCwdWhy,
} from "./live-repo"
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

// claude-config `requires: ["xcode"]` (2026-10-05): the iOS apps run code only on a host with Xcode.
const XCODE_MAP_TS = `
export interface RepoEntry { name: string; match: RegExp; path: string; project: string; requires?: Capability[] }

export function buildRepoMap(home: string = homedir()): RepoEntry[] {
  return [
    { name: "tls-dashboard-v2", match: /dashboard|PRJ-WCLS|tls-dashboard/i, path: \`\${home}/tls-dashboard-v2\`, project: "PRJ-WCLS" },
    { name: "companion-ios", match: /companion-ios|companion-rich-feed/i, path: \`\${home}/apps/claude companion\`, project: "projects/2026-09-30-companion-ios-vault", requires: ["xcode"] },
    { name: "claude-companion", match: /companion-orchestrator|claude-companion/i, path: \`\${home}/claude-companion\`, project: "PRJ-OR1T" },
    { name: "tls-viewer-ios", match: /tls-viewer-ios|ndi-wireless/i, path: \`\${home}/apps/NDI WIRELESS\`, project: "PRJ-94TA", requires: ["xcode"] },
    { name: "tls-viewer-ios", match: /tls-viewer-ios|ndi-wireless/i, path: \`\${home}/lanes/ndi-wireless\`, project: "PRJ-94TA", requires: ["xcode"], },
  ];
}
`

const LINUX: HostProbe = { platform: "linux", hasBin: () => true }
const MAC: HostProbe = { platform: "darwin", hasBin: (b) => b === "xcodebuild" }
const MAC_NO_XCODE: HostProbe = { platform: "darwin", hasBin: () => false }

describe("repo-map requires (xcode)", () => {
  test("parser reads requires; entries without it parse as before; old formats still parse", () => {
    const map = parseRepoMap(XCODE_MAP_TS, "/h")
    expect(map.map((e) => [e.name, e.requires ?? null])).toEqual([
      ["tls-dashboard-v2", null], ["companion-ios", ["xcode"]], ["claude-companion", null], ["tls-viewer-ios", ["xcode"]], ["tls-viewer-ios", ["xcode"]],
    ])
    expect(map[3]).toMatchObject({ path: "/h/apps/NDI WIRELESS", project: "PRJ-94TA" })
    expect(parseRepoMap(REPO_MAP_TS, "/h")).toHaveLength(6)
    expect(parseRepoMap(REPO_MAP_TS, "/h").every((e) => e.requires === undefined)).toBe(true)
    expect(parseRepoMap(SOURCE, "/h")).toHaveLength(3)
  })

  test("tolerant: platform darwin, unknown fields, requires without project / before project, single quotes", () => {
    const src = [
      '{ name: "a", match: /a/i, path: `${home}/a`, project: "P", platform: "darwin" }',
      '{ name: "b", match: /b/i, path: `${home}/b`, project: "P", future: true, requires: ["XCODE"] }',
      '{ match: /c/i, path: `${HOME}/c`, requires: [\'xcode\'] }',
      '{ name: "d", match: /d/i, path: `${home}/d`, requires: ["xcode"], project: "PD" }',
      '{ name: "e", match: /e/i, path: `${home}/e`, project: "P", requires: [] }',
    ].join("\n")
    const map = parseRepoMap(src, "/h")
    expect(map.map((e) => [e.name ?? "-", e.requires ?? null, e.project ?? null])).toEqual([
      ["a", ["xcode"], "P"], ["b", ["xcode"], "P"], ["-", ["xcode"], null], ["d", ["xcode"], "PD"], ["e", null, "P"],
    ])
    expect(parseRequires("")).toEqual([])
  })

  test("hostCan: darwin + xcodebuild only; no requires → any host", () => {
    expect(hostCan({ requires: ["xcode"] }, MAC)).toBe(true)
    expect(hostCan({ requires: ["xcode"] }, MAC_NO_XCODE)).toBe(false)
    expect(hostCan({ requires: ["xcode"] }, LINUX)).toBe(false)
    expect(hostCan({ requires: ["gpu"] }, MAC)).toBe(false) // unknown capability is never assumed
    expect(hostCan({}, LINUX)).toBe(true)
    expect(hostCan(null, LINUX)).toBe(true)
  })
})

describe("Xcode repo on a host without Xcode", () => {
  function fixture() {
    const home = mkdtempSync(join(tmpdir(), "cc-xcode-"))
    for (const d of ["lanes/ndi-wireless", "tls-dashboard-v2", "claude-companion"]) mkdirSync(join(home, d), { recursive: true })
    const file = join(home, "repo-map.ts")
    writeFileSync(file, XCODE_MAP_TS)
    const saved = { home: process.env.HOME, map: process.env.COMPANION_REPO_MAP }
    process.env.HOME = home
    process.env.COMPANION_REPO_MAP = file
    const restore = () => {
      process.env.HOME = saved.home
      if (saved.map === undefined) delete process.env.COMPANION_REPO_MAP
      else process.env.COMPANION_REPO_MAP = saved.map
    }
    return { home, file, restore }
  }
  const origins = (home: string) => async (_cmd: string, args: string[]) => {
    const dir = args[1] ?? ""
    const url = dir.endsWith("ndi-wireless") ? "https://github.com/jaubut/NDI-WIRELESS.git" : `https://github.com/jaubut/${dir.slice(home.length + 1)}.git`
    return { ok: true, out: `${url}\n`, err: "", code: 0 }
  }

  test("localRepoFor: linux skips the clone (→ the caller forwards to the Mac); darwin with Xcode finds it", async () => {
    const f = fixture()
    try {
      const sh = origins(f.home) as never
      expect(await localRepoFor("jaubut/NDI-WIRELESS", "projects/ndi-wireless x", sh, LINUX)).toBeNull()
      expect(await localRepoFor("jaubut/NDI-WIRELESS", "projects/ndi-wireless x", sh, MAC_NO_XCODE)).toBeNull()
      expect(await localRepoFor("jaubut/NDI-WIRELESS", "projects/ndi-wireless x", sh, MAC)).toBe(join(f.home, "lanes", "ndi-wireless"))
      expect(await localRepoFor("jaubut/tls-dashboard-v2", "", sh, LINUX)).toBe(join(f.home, "tls-dashboard-v2"))
    } finally {
      f.restore()
    }
  })

  test("fixRepoHere: the seam's local checkout only where the repo can be built", () => {
    const f = fixture()
    try {
      const clone = join(f.home, "lanes", "ndi-wireless")
      expect(fixRepoHere(clone, LINUX)).toBeNull()
      expect(fixRepoHere(`${clone}/`, LINUX)).toBeNull()
      expect(fixRepoHere(clone, MAC)).toBe(clone)
      expect(fixRepoHere(join(f.home, "tls-dashboard-v2"), LINUX)).toBe(join(f.home, "tls-dashboard-v2"))
      expect(fixRepoHere(null, MAC)).toBeNull()
    } finally {
      f.restore()
    }
  })

  test("live cwd: Xcode note / explicit path / fallback cwd on linux → no_cwd with the reason; darwin → the clone", () => {
    const f = fixture()
    try {
      const clone = join(f.home, "lanes", "ndi-wireless")
      const other = join(f.home, "claude-companion")
      expect(resolveLiveCwdWhy({ noteId: "projects/ndi-wireless", noteTitle: "NDI", channelCwd: other }, LINUX)).toEqual({ cwd: null, reason: XCODE_LIVE_REASON })
      expect(resolveLiveCwdWhy({ explicit: clone }, LINUX)).toEqual({ cwd: null, reason: XCODE_LIVE_REASON })
      expect(resolveLiveCwdWhy({ noteId: "projects/misc", noteTitle: "Misc", taskCwd: clone }, LINUX)).toEqual({ cwd: null, reason: XCODE_LIVE_REASON })
      expect(resolveLiveCwdWhy({ noteId: "projects/misc", noteTitle: "Misc", taskCwd: clone, channelCwd: other }, LINUX)).toEqual({ cwd: other, reason: null })
      expect(resolveLiveCwd({ noteId: "projects/ndi-wireless", noteTitle: "NDI" }, MAC)).toBe(clone)
      expect(resolveLiveCwdWhy({ noteId: "projects/d", noteTitle: "TLS Dashboard" }, LINUX)).toEqual({ cwd: join(f.home, "tls-dashboard-v2"), reason: null })
      expect(resolveLiveCwdWhy({ noteId: "projects/misc", noteTitle: "Misc" }, LINUX)).toEqual({ cwd: null, reason: null })
    } finally {
      f.restore()
    }
  })
})
