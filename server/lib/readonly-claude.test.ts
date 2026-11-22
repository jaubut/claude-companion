import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type ReadonlySpec,
  isReadonlyGeminiModel,
  readonlyAgyArgs,
  readonlyCwd,
  readonlyEnv,
  runReadonlyClaude,
} from "./readonly-claude"

const BASE_SPEC: ReadonlySpec = {
  model: "gemini-4-hydrogen-high",
  system: "You are a read-only resolver.",
  settingSources: "",
  tools: "Read,Grep,Glob,Bash",
  addDirs: ["/memory/dir"],
  allowed: ["Read"],
  disallowed: ["Edit"],
}

describe("isReadonlyGeminiModel", () => {
  test("matches gemini and orchestrator models, leaves Claude models false", () => {
    for (const m of ["gemini-4-hydrogen-high", "Gemini 4 Argon (High)", "orchestrator", "Orchestrator (Carbon)"]) {
      expect(isReadonlyGeminiModel(m)).toBe(true)
    }
    for (const m of ["sonnet", "opus", "haiku", "claude-opus-5-5", "claude-sonnet-5-5"]) {
      expect(isReadonlyGeminiModel(m)).toBe(false)
    }
  })
})

describe("readonlyAgyArgs & readonlyEnv", () => {
  test("builds strict plan-mode agy flags with prepended system prompt and repeatable --add-dir", () => {
    const args = readonlyAgyArgs("-check PR #1", BASE_SPEC, { timeoutMs: 60_000, addDirs: ["/repo", "/memory/dir"] })
    expect(args[0]).toBe("--print=You are a read-only resolver.\n\n-check PR #1")
    expect(args).toContain("--mode")
    expect(args[args.indexOf("--mode") + 1]).toBe("plan")
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-4-hydrogen-high")
    expect(args[args.indexOf("--output-format") + 1]).toBe("text")
    expect(args).toContain("--disable-slash-commands")
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("60s")
    expect(args.slice(args.indexOf("--add-dir"))).toEqual(["--add-dir", "/repo", "--add-dir", "/memory/dir"])
  })

  test("includeClaudeAuth: false scrubs CLAUDE_CODE_OAUTH_TOKEN and notes/companion/broker tokens", () => {
    const env = readonlyEnv(
      {
        HOME: "/Users/j",
        USER: "j",
        TURSO_AUTH_TOKEN: "t",
        COMPANION_AUTH_TOKEN: "c",
        BROKER_TOKEN: "b",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth",
        ANTHROPIC_BASE_URL: "https://x",
        CLAUDE_CONFIG_DIR: "/cfg",
      },
      "/Users/j",
      { includeClaudeAuth: false },
    )
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(env.TURSO_AUTH_TOKEN).toBeUndefined()
    expect(env.COMPANION_AUTH_TOKEN).toBeUndefined()
    expect(env.BROKER_TOKEN).toBeUndefined()
    expect(env.HOME).toBe("/Users/j")
  })
})

describe("runReadonlyClaude", () => {
  function fakeSpawn(result: { stdout?: string; stderr?: string; exitCode?: number }) {
    const calls: Array<{ argv: string[]; cwd?: string; env?: Record<string, string | undefined>; stdin?: unknown }> = []
    const spawn = ((argv: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; stdin?: unknown }) => {
      calls.push({ argv, cwd: opts.cwd, env: opts.env, stdin: opts.stdin })
      return {
        stdout: new Blob([result.stdout ?? ""]).stream(),
        stderr: new Blob([result.stderr ?? ""]).stream(),
        exited: Promise.resolve(result.exitCode ?? 0),
        kill: () => {},
      }
    }) as unknown as typeof Bun.spawn
    return { calls, spawn }
  }

  test("dispatches Gemini models through agy in empty readonlyCwd with scrubbed env and repo --add-dir", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-ro-gemini-"))
    const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const prevTurso = process.env.TURSO_AUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "secret-oauth"
    process.env.TURSO_AUTH_TOKEN = "secret-turso"
    try {
      const fake = fakeSpawn({ stdout: '{"action":{"kind":"none"}}\n' })
      const res = await runReadonlyClaude("Analyze PR", { ...BASE_SPEC, model: "Gemini 4 Hydrogen (High)" }, {
        timeoutMs: 30_000,
        cwd: "/repos/my-app",
        home,
        agy: "/usr/local/bin/agy",
        spawn: fake.spawn,
      })
      expect(res).toEqual({ ok: true, text: '{"action":{"kind":"none"}}' })
      expect(fake.calls).toHaveLength(1)
      const call = fake.calls[0]!
      expect(call.argv[0]).toBe("/usr/local/bin/agy")
      expect(call.argv).toContain("--mode")
      expect(call.argv[call.argv.indexOf("--mode") + 1]).toBe("plan")
      expect(call.argv[call.argv.indexOf("--model") + 1]).toBe("gemini-4-hydrogen-high")
      expect(call.argv).toContain("/repos/my-app")
      expect(call.argv).toContain("/memory/dir")
      expect(call.cwd).toBe(readonlyCwd(home))
      expect(call.stdin).toBe("ignore")
      expect(call.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      expect(call.env?.TURSO_AUTH_TOKEN).toBeUndefined()
      expect(call.env?.DISPATCH_HEADLESS).toBe("1")
      expect(call.env?.CLAUDE_NO_AGENT_ENV).toBe("1")

      const badExit = fakeSpawn({ exitCode: 2 })
      expect(await runReadonlyClaude("x", BASE_SPEC, { timeoutMs: 1000, home, agy: "/bin/agy", spawn: badExit.spawn }))
        .toEqual({ ok: false, error: "agy exited 2" })

      const emptyOut = fakeSpawn({ stdout: "   \n" })
      expect(await runReadonlyClaude("x", BASE_SPEC, { timeoutMs: 1000, home, agy: "/bin/agy", spawn: emptyOut.spawn }))
        .toEqual({ ok: false, error: "no result in agy output" })
    } finally {
      if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth
      if (prevTurso === undefined) delete process.env.TURSO_AUTH_TOKEN
      else process.env.TURSO_AUTH_TOKEN = prevTurso
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("keeps claude -p path intact for Claude models", async () => {
    const home = mkdtempSync(join(tmpdir(), "cc-ro-claude-"))
    const prevOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "keep-oauth"
    try {
      const fake = fakeSpawn({ stdout: JSON.stringify({ type: "result", result: "claude answer" }) })
      const res = await runReadonlyClaude("Analyze PR", { ...BASE_SPEC, model: "sonnet" }, {
        timeoutMs: 30_000,
        cwd: join(home, "repo"),
        home,
        claude: "/usr/local/bin/claude",
        spawn: fake.spawn,
      })
      expect(res).toEqual({ ok: true, text: "claude answer" })
      const call = fake.calls[0]!
      expect(call.argv.slice(0, 2)).toEqual(["/usr/local/bin/claude", "-p"])
      expect(call.cwd).toBe(join(home, "repo"))
      expect(call.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("keep-oauth")
    } finally {
      if (prevOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOauth
      rmSync(home, { recursive: true, force: true })
    }
  })
})
