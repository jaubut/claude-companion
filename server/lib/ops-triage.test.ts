import { describe, expect, test } from "bun:test"
import { parseTriageVerdict, triageOpsEvents } from "./ops-triage"

describe("parseTriageVerdict", () => {
  test("parses strict JSON and strips markdown code fences", () => {
    expect(parseTriageVerdict('{"action":"ignore","reason":"PR waiting on CI"}')).toEqual({
      action: "ignore",
      reason: "PR waiting on CI",
    })
    expect(parseTriageVerdict('```json\n{"action":"escalate","reason":"lead asks to merge"}\n```')).toEqual({
      action: "escalate",
      reason: "lead asks to merge",
    })
  })

  test("rejects malformed or invalid actions", () => {
    expect(parseTriageVerdict("not json")).toBeNull()
    expect(parseTriageVerdict('{"action":"delete","reason":"bad"}')).toBeNull()
    expect(parseTriageVerdict("[]")).toBeNull()
  })
})

describe("triageOpsEvents", () => {
  test("uses Gemini direct API when GEMINI_API_KEY is available and ignores routine PR ready", async () => {
    let seenUrl = ""
    const mockFetch = (async (url: string | URL) => {
      seenUrl = String(url)
      return Response.json({
        candidates: [{ content: { parts: [{ text: '{"action":"ignore","reason":"clean PR waiting on CI/shepherd"}' }] } }],
      })
    }) as unknown as typeof fetch

    const res = await triageOpsEvents(
      [{ id: "e1", text: "PR ready [aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] tls-dashboard-v2 — https://github.com/jaubut/tls-dashboard-v2/pull/455" }],
      { mode: "live", geminiKey: "gem-test", openrouterKey: "or-test", fetch: mockFetch },
    )
    expect(seenUrl).toContain("generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent")
    expect(res).toMatchObject({
      action: "ignore",
      verdict: "ignore",
      provider: "gemini",
      model: "gemini-2.5-flash",
      reason: "clean PR waiting on CI/shepherd",
    })
  })

  test("falls back to OpenRouter google/gemini-2.5-flash when only OPENROUTER_API_KEY is set", async () => {
    let seenUrl = ""
    const mockFetch = (async (url: string | URL) => {
      seenUrl = String(url)
      return Response.json({
        choices: [{ message: { content: '{"action":"escalate","reason":"lead requests merge"}' } }],
      })
    }) as unknown as typeof fetch

    const res = await triageOpsEvents(
      [{ id: "e2", text: "[from lead-claude-companion] merge jaubut/claude-companion#353: green + 2 approvals" }],
      { mode: "live", geminiKey: null, openrouterKey: "or-test", fetch: mockFetch },
    )
    expect(seenUrl).toContain("openrouter.ai/api/v1/chat/completions")
    expect(res).toMatchObject({
      action: "escalate",
      verdict: "escalate",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    })
  })

  test("shadow mode records ignore verdict while still escalating to Brain", async () => {
    const mockFetch = (async () => Response.json({
      choices: [{ message: { content: '{"action":"ignore","reason":"routine completion"}' } }],
    })) as unknown as typeof fetch

    const res = await triageOpsEvents(
      [{ id: "e3", text: "completed [bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb] repo — all tests pass" }],
      { mode: "shadow", geminiKey: null, openrouterKey: "or-test", fetch: mockFetch },
    )
    expect(res.verdict).toBe("ignore")
    expect(res.action).toBe("escalate")
  })

  test("fails open to escalate on missing key, HTTP 500, or network throw", async () => {
    const noKey = await triageOpsEvents([{ id: "e1", text: "stuck r#1" }], { mode: "live", geminiKey: null, openrouterKey: null })
    expect(noKey).toMatchObject({ action: "escalate", provider: "none", error: "no_api_key" })

    const errRes = await triageOpsEvents([{ id: "e1", text: "stuck r#1" }], {
      mode: "live",
      geminiKey: "gem-test",
      fetch: (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
    })
    expect(errRes).toMatchObject({ action: "escalate", error: "gemini_http_500" })

    const netRes = await triageOpsEvents([{ id: "e1", text: "stuck r#1" }], {
      mode: "live",
      geminiKey: "gem-test",
      fetch: (async () => { throw new Error("timeout") }) as unknown as typeof fetch,
    })
    expect(netRes).toMatchObject({ action: "escalate", reason: "network_error" })
  })

  test("off mode skips HTTP completely", async () => {
    let called = 0
    const res = await triageOpsEvents([{ id: "e1", text: "completed [x]" }], {
      mode: "off",
      geminiKey: "gem-test",
      fetch: (async () => { called++; return new Response("{}") }) as unknown as typeof fetch,
    })
    expect(called).toBe(0)
    expect(res.action).toBe("escalate")
  })
})
