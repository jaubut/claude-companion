import { describe, expect, test } from "bun:test"
import { BASE_DISALLOWED, readonlyArgs, readonlyEnv } from "./readonly-claude"
import { QUICK_LOOK_ALLOWED, QUICK_LOOK_DISALLOWED, answerTurnText, buildQuickLookPrompt, parseQuickLook, quickLookArgs, quickLookModel } from "./quick-look"

const REPO = "/Users/j/chantalmasse-website"

describe("argv", () => {
  test("hardened read-only flags; no settings file loads (the repo is the cwd)", () => {
    const a = quickLookArgs("/bin/claude", "sonnet")
    const flag = (f: string) => a[a.indexOf(f) + 1]
    expect(a.slice(0, 2)).toEqual(["/bin/claude", "-p"])
    expect(flag("--setting-sources")).toBe("") // the repo's .claude/settings*.json allows never apply
    expect(JSON.parse(flag("--settings")!)).toEqual({ disableAllHooks: true })
    expect(flag("--permission-mode")).toBe("dontAsk")
    expect(flag("--tools")).toBe("Read,Grep,Glob,Bash")
    expect(a).not.toContain("--add-dir") // the cwd only, never the whole disk
    expect(a).toContain("--strict-mcp-config")
    expect(a).toContain("--no-session-persistence")
    const allowAt = a.indexOf("--allowedTools"), denyAt = a.indexOf("--disallowedTools")
    expect(a.slice(allowAt + 1, denyAt)).toEqual([...QUICK_LOOK_ALLOWED])
    expect(a.slice(denyAt + 1)).toEqual([...QUICK_LOOK_DISALLOWED])
    expect(quickLookModel({})).toBe("sonnet")
    expect(quickLookModel({ COMPANION_QUICKLOOK_MODEL: "haiku" })).toBe("haiku")
  })

  test("allowlist: reads + read-only network GETs only", () => {
    expect(QUICK_LOOK_ALLOWED.filter((t) => !t.startsWith("Bash("))).toEqual(["Read", "Grep", "Glob"])
    const READ_ONLY = /^Bash\((git (log|status|diff|show|describe|rev-parse|ls-files)( \*)?|git remote -v|git branch (--show-current|-a)|git tag (--list|-l)\*|ls|cat|head|tail|stat|wc|which|jq|grep|sort|npm (view|ls|outdated)|curl -s https:\/\/(registry\.npmjs\.org|api\.github\.com)\/)/
    for (const t of QUICK_LOOK_ALLOWED.filter((x) => x.startsWith("Bash("))) expect(t).toMatch(READ_ONLY)
    // network checks needed for "is it on the latest version?"
    for (const t of ["Bash(npm view *)", "Bash(curl -s https://registry.npmjs.org/*)", "Bash(curl -s https://api.github.com/*)"]) expect(QUICK_LOOK_ALLOWED).toContain(t)
    // nothing that writes: no bare git branch/tag (they create refs), no npm install, no plain curl
    for (const t of ["Bash(git branch *)", "Bash(git tag *)", "Bash(npm install *)", "Bash(curl *)", "Bash(curl -s *)", "Edit", "Write", "Bash(git commit *)"]) {
      expect(QUICK_LOOK_ALLOWED).not.toContain(t)
    }
  })

  test("deny list: writes, secrets, mutating curl / npm flags", () => {
    for (const t of BASE_DISALLOWED) expect(QUICK_LOOK_DISALLOWED).toContain(t)
    for (const t of ["Edit", "Write", "NotebookEdit", "Read(**/.env)", "Read(~/.config/tls-agent/**)", "Bash(*tls-agent*)", "Bash(curl * -X*)",
      "Bash(curl * -d*)", "Bash(curl * -o*)", "Bash(curl * --upload*)", "Bash(npm * install*)", "Bash(npm * publish*)"]) {
      expect(QUICK_LOOK_DISALLOWED).toContain(t)
    }
  })

  test("shared runner env stays allowlisted", () => {
    const env = readonlyEnv({ HOME: "/Users/j", TURSO_AUTH_TOKEN: "t", TYPESAFE_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "o" }, "/Users/j")
    expect([env.TURSO_AUTH_TOKEN, env.TYPESAFE_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN]).toEqual([undefined, undefined, "o"])
    expect(readonlyArgs("/c", { model: "m", system: "s", tools: "Read", addDirs: ["/a", "/b"], allowed: ["Read"], disallowed: ["Edit"] }).join(" "))
      .toContain("--setting-sources project,local --settings")
    expect(readonlyArgs("/c", { model: "m", system: "s", tools: "Read", addDirs: ["/a", "/b"], allowed: ["Read"], disallowed: ["Edit"] }).join(" "))
      .toContain("--add-dir /a /b --allowedTools Read --disallowedTools Edit")
  })
})

describe("prompt + output", () => {
  test("prompt names the repo, the read-only rules and the JSON shape", () => {
    const p = buildQuickLookPrompt({ question: "is it on the latest nuxt?", repo: REPO, projectTitle: "Chantal Massé — Website", noteId: "projects/x", recent: [{ role: "user", text: "hey" }] })
    expect(p).toContain(`repository at ${REPO}`)
    expect(p).toContain("npm view <pkg> version")
    expect(p).toContain("Everything else is denied")
    expect(p).toContain('"needsChange"')
    expect(p).toContain("user: hey")
  })

  test("parse: JSON, fenced, prose; proposal only with needsChange", () => {
    expect(parseQuickLook('{"answer":"Nuxt 3.12; latest 4.1","facts":["package.json"],"needsChange":true,"proposal":{"title":"Upgrade","prompt":"Do it"}}'))
      .toEqual({ answer: "Nuxt 3.12; latest 4.1", facts: ["package.json"], needsChange: true, proposal: { title: "Upgrade", prompt: "Do it" } })
    expect(parseQuickLook('Here:\n```json\n{"answer":"yes","facts":[],"needsChange":false,"proposal":{"title":"x","prompt":"y"}}\n```')!.proposal).toBeNull()
    expect(parseQuickLook("It pins bun 1.3.")).toEqual({ answer: "It pins bun 1.3.", facts: [], needsChange: false, proposal: null })
    expect(parseQuickLook('{"answer":"x","needsChange":true,"proposal":null}')!.needsChange).toBe(false)
    expect(parseQuickLook("   ")).toBeNull()
  })

  test("turn text", () => {
    expect(answerTurnText(REPO, { answer: "Yes", facts: ["a", "b"], needsChange: false, proposal: null })).toBe("🔎 chantalmasse-website — Yes\n• a\n• b")
  })
})
