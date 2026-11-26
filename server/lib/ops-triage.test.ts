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
    expect(parseTriageVerdict(JSON.stringify({
      conversation_id: "c1",
      status: "SUCCESS",
      structured_output: { action: "ignore", reason: "PR waiting on CI" },
      response: "{\"action\":\"ignore\",\"reason\":\"PR waiting on CI\"}\n",
    }))).toEqual({ action: "ignore", reason: "PR waiting on CI" })
  })
})

describe("triageOpsEvents", () => {
  test("defaults to agy subscription CLI (gemini-3.8-flash-low) with zero API keys", async () => {
    let seenArgs: string[] = []
    const res = await triageOpsEvents(
      [{ id: "e1", text: "PR ready [aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] tls-dashboard-v2 — https://github.com/jaubut/tls-dashboard-v2/pull/455" }],
      {
        mode: "live",
        runAgy: async (_cmd, args) => {
          seenArgs = args
          return { ok: true, text: '{"action":"ignore","reason":"clean PR waiting on CI"}' }
        },
      },
    )
    expect(seenArgs).toContain("gemini-3.8-flash-low")
    expect(seenArgs).toContain("--disable-slash-commands")
    expect(res).toMatchObject({
      action: "ignore",
      verdict: "ignore",
      provider: "agy",
      model: "gemini-3.8-flash-low",
      reason: "clean PR waiting on CI",
    })
  })

  test("agy provider fails open to escalate on timeout or non-zero exit", async () => {
    const res = await triageOpsEvents(
      [{ id: "e1", text: "stuck r#1" }],
      { mode: "live", runAgy: async () => ({ ok: false, error: "agy_timeout" }) },
    )
    expect(res).toMatchObject({ action: "escalate", provider: "agy", error: "agy_timeout" })
  })

  test("shadow mode records ignore verdict while still escalating to Brain", async () => {
    const res = await triageOpsEvents(
      [{ id: "e3", text: "completed [bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb] repo — all tests pass" }],
      { mode: "shadow", runAgy: async () => ({ ok: true, text: '{"action":"ignore","reason":"routine completion"}' }) },
    )
    expect(res.verdict).toBe("ignore")
    expect(res.action).toBe("escalate")
  })

  test("optional http provider uses GEMINI_API_KEY or OPENROUTER_API_KEY and fails open on error", async () => {
    let seenUrl = ""
    const mockFetch = (async (url: string | URL) => {
      seenUrl = String(url)
      return Response.json({
        candidates: [{ content: { parts: [{ text: '{"action":"ignore","reason":"clean PR"}' }] } }],
      })
    }) as unknown as typeof fetch

    const res = await triageOpsEvents(
      [{ id: "e1", text: "PR ready [x]" }],
      { mode: "live", provider: "http", geminiKey: "gem-test", openrouterKey: null, fetch: mockFetch },
    )
    expect(seenUrl).toContain("generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent")
    expect(res).toMatchObject({ action: "ignore", provider: "gemini" })

    const noKey = await triageOpsEvents([{ id: "e1", text: "stuck r#1" }], {
      mode: "live", provider: "http", geminiKey: null, openrouterKey: null,
    })
    expect(noKey).toMatchObject({ action: "escalate", provider: "none", error: "no_api_key" })
  })

  test("off mode skips execution completely", async () => {
    let called = 0
    const res = await triageOpsEvents([{ id: "e1", text: "completed [x]" }], {
      mode: "off",
      runAgy: async () => { called++; return { ok: true, text: "{}" } },
    })
    expect(called).toBe(0)
    expect(res.action).toBe("escalate")
  })
})
