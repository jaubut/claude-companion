import { describe, expect, test } from "bun:test"
import type { BodyComponentDetail } from "./body"
import {
  ALLOWED_TOOLS, DISALLOWED_TOOLS, OUTPUT_SCHEMA, type FsSeams, buildInvestigationPrompt, failureTurnText, investigateModel, investigatorArgs,
  investigatorEnv, knownPaths, parseInvestigateBody, parseInvestigationResult, proposalPrompt, reportTurnText, safeName,
} from "./body-investigator"

const HOME = "/Users/j"

function fakeFs(files: Record<string, string>, dirs: string[] = []): FsSeams {
  return { home: HOME, uid: 501, exists: (p) => p in files || dirs.includes(p), read: (p) => files[p] ?? null }
}

const PLIST = `<?xml version="1.0"?><plist><dict>
<key>Label</key><string>com.tls.sync</string>
<key>ProgramArguments</key><array><string>/Users/j/.bun/bin/bun</string><string>/Users/j/tools/sync/run.ts</string></array>
<key>StandardOutPath</key><string>/Users/j/Library/Logs/sync.out.log</string>
<key>StandardErrorPath</key><string>/Users/j/Library/Logs/sync.err.log</string>
</dict></plist>`

describe("known paths from the id", () => {
  test("launchd: plist, its logs, launchctl commands, repo from the script dir", () => {
    const fs = fakeFs({ "/Users/j/Library/LaunchAgents/com.tls.sync.plist": PLIST }, ["/Users/j/tools/.git"])
    const p = knownPaths({ id: "mac:launchd:com.tls.sync", kind: "launchd", name: "com.tls.sync" }, fs)
    expect(p.files).toEqual(["/Users/j/Library/LaunchAgents/com.tls.sync.plist", "/Users/j/Library/Logs/sync.out.log", "/Users/j/Library/Logs/sync.err.log"])
    expect(p.commands).toEqual(["launchctl print gui/501/com.tls.sync", "launchctl list com.tls.sync"])
    expect(p.cwd).toBe("/Users/j/tools/sync")
    expect(p.repo).toBe("/Users/j/tools")
  })

  test("launchd with no plist found: the expected path is still listed", () => {
    const p = knownPaths({ id: "mac:launchd:gone", kind: "launchd", name: "gone" }, fakeFs({}))
    expect(p.files).toEqual(["/Users/j/Library/LaunchAgents/gone.plist"])
    expect(p.cwd).toBeNull()
    expect(p.repo).toBeNull()
  })

  test("systemd timer: unit files, status/cat/journal, WorkingDirectory", () => {
    const fs = fakeFs({ "/Users/j/.config/systemd/user/tg-paper.service": "[Service]\nWorkingDirectory=%h/tg-paper\nExecStart=/usr/bin/bun run.ts\n" }, ["/Users/j/tg-paper/.git"])
    const p = knownPaths({ id: "zettlab:systemd-timer:tg-paper", kind: "systemd-timer", name: "tg-paper" }, fs)
    expect(p.files).toEqual(["/Users/j/.config/systemd/user/tg-paper.timer", "/Users/j/.config/systemd/user/tg-paper.service"])
    expect(p.commands).toContain("journalctl --user -u tg-paper.service -n 100 --no-pager")
    expect(p.commands).toContain("systemctl --user status tg-paper.timer tg-paper.service --no-pager")
    expect(p.cwd).toBe("/Users/j/tg-paper")
    expect(p.repo).toBe("/Users/j/tg-paper")
  })

  test("docker / cron / unknown kinds; names are sanitised", () => {
    expect(knownPaths({ id: "zettlab:docker:kb-api", kind: "docker", name: "kb-api" }, fakeFs({})).commands).toEqual([
      "docker ps -a --filter name=kb-api", "docker logs --tail 100 kb-api", "docker inspect kb-api",
    ])
    expect(knownPaths({ id: "zettlab:cron:x", kind: "cron", name: "x" }, fakeFs({})).commands).toEqual(["crontab -l"])
    expect(knownPaths({ id: "cloud:turso-table:t", kind: "turso-table", name: "t" }, fakeFs({}))).toEqual({ files: [], commands: [], cwd: null, repo: null })
    expect(safeName("a; rm x`$(y)`")).toBe("armxy")
  })
})

const DETAIL: BodyComponentDetail = {
  ok: true, generated_at: "g",
  component: {
    id: "mac:launchd:com.tls.sync", host: "mac", kind: "launchd", name: "com.tls.sync", schedule_s: 3600, criticality: "med",
    depends_on: [], notes: "", first_seen: "f", last_seen: "l", retired: false, dependents: [], dependents_count: 0,
  },
  vitals: {
    component_id: "mac:launchd:com.tls.sync", observed_at: "o", state: "dead", last_exit: 1, last_run_at: null, last_ok_at: null,
    runs_total: 3, runs_delta: 0, consecutive_failures: 3, detail: "no run in 40h",
  },
  events: Array.from({ length: 30 }, (_, i) => ({ id: i, component_id: "mac:launchd:com.tls.sync", at: `t${i}`, kind: "transition", from_state: "ok", to_state: "dead", detail: null })),
}

describe("prompt", () => {
  test("carries the record, the last 20 events, paths, rules and the schema", () => {
    const paths = { files: ["/a.plist"], commands: ["launchctl list x"], cwd: "/Users/j/tools/sync", repo: "/Users/j/tools" }
    const p = buildInvestigationPrompt({ detail: DETAIL, paths })
    expect(p).toContain("component mac:launchd:com.tls.sync as dead")
    expect(p).toContain(JSON.stringify(DETAIL.component))
    expect(p).toContain(JSON.stringify(DETAIL.events.slice(0, 20)))
    expect(p).not.toContain('"t20"')
    expect(p).toContain("- /a.plist")
    expect(p).toContain("- launchctl list x")
    expect(p).toContain("Working directory of the unit: /Users/j/tools/sync (git repo /Users/j/tools)")
    expect(p).toContain("retire=true")
    expect(p.endsWith(OUTPUT_SCHEMA)).toBe(true)
  })
})

describe("argv + env", () => {
  test("read-only allowlist shape", () => {
    const a = investigatorArgs("/bin/claude", "sonnet")
    const flag = (f: string) => a[a.indexOf(f) + 1]
    expect(a.slice(0, 2)).toEqual(["/bin/claude", "-p"])
    expect(flag("--model")).toBe("sonnet")
    expect(flag("--output-format")).toBe("json")
    expect(flag("--setting-sources")).toBe("project,local")
    expect(JSON.parse(flag("--settings")!)).toEqual({ disableAllHooks: true })
    expect(flag("--permission-mode")).toBe("dontAsk")
    expect(flag("--tools")).toBe("Read,Grep,Glob,Bash")
    expect(flag("--add-dir")).toBe("/")
    expect(a).toContain("--strict-mcp-config")
    expect(a).toContain("--no-session-persistence")
    // the prompt goes on stdin: no positional prompt anywhere
    const allowAt = a.indexOf("--allowedTools"), denyAt = a.indexOf("--disallowedTools")
    expect(a.slice(allowAt + 1, denyAt)).toEqual([...ALLOWED_TOOLS])
    expect(a.slice(denyAt + 1)).toEqual([...DISALLOWED_TOOLS])
    expect(denyAt).toBe(a.length - DISALLOWED_TOOLS.length - 1)
  })

  test("allowlist = Read/Grep/Glob + diagnostic Bash prefixes only; edits and secrets denied", () => {
    expect(ALLOWED_TOOLS.filter((t) => !t.startsWith("Bash("))).toEqual(["Read", "Grep", "Glob"])
    for (const t of ALLOWED_TOOLS.filter((x) => x.startsWith("Bash("))) {
      expect(t).toMatch(/^Bash\((journalctl|systemctl --user (status|cat|list-timers|show)|launchctl (print|list)|ls|cat|head|tail|stat|docker (ps|logs|inspect)|git (log|status|diff)|which|crontab -l|ps|df|du|curl -s http:\/\/(localhost|127\.0\.0\.1))\b/)
    }
    for (const t of ["Edit", "Write", "NotebookEdit", "Read(~/.config/tls-agent/**)", "Bash(*tls-agent*)", "Bash(curl * -X*)", "Bash(git *--output*)", "Bash(journalctl *--vacuum*)"]) {
      expect(DISALLOWED_TOOLS).toContain(t)
    }
  })

  test("env is allowlisted: no tokens leak to the investigator", () => {
    const env = investigatorEnv({ HOME: "/Users/j", USER: "j", TURSO_AUTH_TOKEN: "t", COMPANION_AUTH_TOKEN: "c", BROKER_TOKEN: "b", CLAUDE_CODE_OAUTH_TOKEN: "o", PATH: "/x" }, "/Users/j")
    expect(env.TURSO_AUTH_TOKEN).toBeUndefined()
    expect(env.COMPANION_AUTH_TOKEN).toBeUndefined()
    expect(env.BROKER_TOKEN).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("o")
    expect(env.PATH!.split(":")[0]).toBe("/Users/j/.local/bin")
    expect(investigateModel({})).toBe("sonnet")
    expect(investigateModel({ COMPANION_INVESTIGATE_MODEL: "opus" })).toBe("opus")
  })
})

const GOOD = {
  rootCause: "The plist runs a script that was deleted", evidence: ["ls: no such file /Users/j/tools/sync/run.ts"], confidence: 0.85, severity: "high",
  recommendedFix: { summary: "Restore the script", steps: ["git checkout run.ts", "launchctl kickstart"], risk: "low", reversible: true }, retire: false, notes: "",
}

describe("JSON parsing", () => {
  test("plain, fenced and prose-wrapped", () => {
    const plain = parseInvestigationResult(JSON.stringify(GOOD))
    expect(plain).toEqual({ ...GOOD, severity: "high", recommendedFix: { ...GOOD.recommendedFix, risk: "low" } } as never)
    expect(parseInvestigationResult("```json\n" + JSON.stringify(GOOD) + "\n```")).toEqual(plain)
    expect(parseInvestigationResult(`I looked around.\n\n${JSON.stringify(GOOD)}\n\nHope that helps.`)).toEqual(plain)
    expect(parseInvestigationResult(`Here:\n\`\`\`\n${JSON.stringify(GOOD)}\n\`\`\`\nDone {not json}`)).toEqual(plain)
  })

  test("normalises confidence / severity / risk; null fix accepted", () => {
    const r = parseInvestigationResult(JSON.stringify({ ...GOOD, confidence: 70, severity: "Medium", recommendedFix: null, retire: true }))!
    expect(r.confidence).toBe(0.7)
    expect(r.severity).toBe("med")
    expect(r.recommendedFix).toBeNull()
    expect(r.retire).toBe(true)
    expect(parseInvestigationResult(JSON.stringify({ ...GOOD, confidence: -3 }))!.confidence).toBe(0)
  })

  test("malformed → null (the engine records `failed`)", () => {
    for (const bad of ["", "no json here", "{\"rootCause\":", JSON.stringify({ evidence: [] }), "[1, 2]",
      JSON.stringify({ ...GOOD, recommendedFix: "do it" }), JSON.stringify({ ...GOOD, recommendedFix: { steps: [] } })]) {
      expect(parseInvestigationResult(bad)).toBeNull()
    }
  })

  test("secrets in the model output are redacted", () => {
    const r = parseInvestigationResult(JSON.stringify({ ...GOOD, evidence: ["header was Bearer abcdefghijklmnop123"] }))!
    expect(r.evidence[0]).toBe("header was Bearer •••")
  })
})

describe("POST /api/body/investigate body", () => {
  test("request + report shapes", () => {
    expect(parseInvestigateBody({ component_id: "mac:launchd:x", state: "dead", trigger: "manual" })).toEqual({
      kind: "request", request: { componentId: "mac:launchd:x", state: "dead", fromState: null, trigger: "manual" },
    })
    const ok = parseInvestigateBody({ report: { id: "ab12cd34", componentId: "mac:launchd:x", state: "dead", status: "done", finishedAt: 5, result: GOOD, cwd: "relative", repo: true } })
    expect(ok).toMatchObject({ kind: "report", report: { id: "ab12cd34", status: "done", attempt: 1, cwd: null, repo: true, error: null } })
    expect(parseInvestigateBody({ report: { id: "../x", componentId: "a", state: "dead", status: "done", finishedAt: 1, result: GOOD } })).toEqual({ error: "report.id invalid" })
  })
})

describe("report text", () => {
  const r = parseInvestigationResult(JSON.stringify(GOOD))!
  test("turn format", () => {
    expect(reportTurnText("mac:launchd:x", r)).toBe(
      "🔍 mac:launchd:x — The plist runs a script that was deleted (confidence 85%)\n• ls: no such file /Users/j/tools/sync/run.ts\nFix: Restore the script (low risk, reversible)",
    )
    expect(reportTurnText("a", { ...r, recommendedFix: null })).toEndWith("No fix proposed.")
    expect(failureTurnText("a", "timed out after 10 min", 2)).toBe("🔍 a — investigation failed: timed out after 10 min (second failure; no retry for 12 h)")
  })

  test("proposal prompt is self-contained", () => {
    const p = proposalPrompt({ componentId: "mac:launchd:x", host: "mac", state: "dead", investigationId: "inv1", cwd: "/Users/j/tools" }, r)
    expect(p).toContain("Run on host: mac")
    expect(p).toContain("Working directory: /Users/j/tools")
    expect(p).toContain("1. git checkout run.ts\n2. launchctl kickstart")
    expect(p).toContain("Investigation: inv1")
  })
})
