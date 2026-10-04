import { describe, expect, test } from "bun:test"
import { envLineValue, jevKey, jevKeySources, parseJevResponse, systemOne } from "./jev"

const Q = { intent: { type: "choice" as const, instructions: "Which?", criteria: { a: "A", b: "B" } } }
const OK_BODY = {
  model: "jev-1.13.0",
  answers: { intent: { type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.84 }, urgent: { type: "noul", noul: 0.2 } },
  usage: { input_tokens: 100, output_tokens: 5 },
}

const fakeFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch

describe("key lookup", () => {
  const files = (m: Record<string, string>) => (p: string) => m[p] ?? null
  test("source order: vault, its mirror, process env, tls-agent/env", () => {
    expect(jevKeySources({ HOME: "/h" })).toEqual([
      "/h/.config/tls-agent/secrets.env", "/h/.config/tls-agent/secrets.mirror", "$env", "/h/.config/tls-agent/env",
    ])
    expect(jevKeySources({ HOME: "/h", TLS_SECRETS_FILE: "/v/s.env", COMPANION_JEV_ENV_FILE: "/e" })).toEqual(["/v/s.env", "/v/secrets.mirror", "$env", "/e"])
    const all = { "/h/.config/tls-agent/secrets.env": "TYPESAFE_API_KEY=vault", "/h/.config/tls-agent/secrets.mirror": "export TYPESAFE_API_KEY=mirror",
      "/h/.config/tls-agent/env": "TYPESAFE_API_KEY=stale" }
    expect(jevKey({ HOME: "/h", TYPESAFE_API_KEY: "proc" }, files(all))).toBe("vault")
    // the Mac: no secrets.env, a working mirror, a stale env file
    const mac = { "/h/.config/tls-agent/secrets.mirror": "export TYPESAFE_API_KEY=\"mirror\"\r\n", "/h/.config/tls-agent/env": "TYPESAFE_API_KEY=stale" }
    expect(jevKey({ HOME: "/h" }, files(mac))).toBe("mirror")
    expect(jevKey({ HOME: "/h", TYPESAFE_API_KEY: '"proc"\r' }, files({ "/h/.config/tls-agent/env": "TYPESAFE_API_KEY=file" }))).toBe("proc")
    expect(jevKey({ HOME: "/h" }, files({ "/h/.config/tls-agent/env": "OTHER=1\r\nexport TYPESAFE_API_KEY='file'\r\n" }))).toBe("file")
  })

  test("missing everywhere → null", () => {
    expect(jevKey({ HOME: "/h" }, () => null)).toBeNull()
    expect(jevKey({ HOME: "/h", TYPESAFE_API_KEY: "  " }, () => "OTHER=1")).toBeNull()
    expect(envLineValue("TYPESAFE_API_KEY=\n", "TYPESAFE_API_KEY")).toBeNull()
  })
})

describe("parse", () => {
  test("choice + noul answers", () => {
    const p = parseJevResponse(OK_BODY)!
    expect(p.model).toBe("jev-1.13.0")
    expect(p.answers.intent).toEqual({ type: "choice", choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.84 })
    expect(p.answers.urgent).toEqual({ type: "noul", noul: 0.2 })
  })

  test("bad shapes", () => {
    expect(parseJevResponse(null)).toBeNull()
    expect(parseJevResponse({ nope: 1 })).toBeNull()
    expect(parseJevResponse({ answers: { x: { type: "score", score: 1 } } })!.answers).toEqual({})
    // missing confidence → the chosen option's probability, clamped
    expect(parseJevResponse({ answers: { x: { type: "choice", choice: "a", probabilities: { a: 0.6 } } } })!.answers.x).toMatchObject({ confidence: 0.6 })
  })
})

describe("systemOne", () => {
  test("request shape + parsed answers", async () => {
    let sent: { url: string; init: RequestInit } | null = null
    const out = await systemOne({ m: "hi" }, Q, {
      key: "k1", fetch: fakeFetch(async (url, init) => { sent = { url, init }; return Response.json(OK_BODY) }),
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.answers.intent).toMatchObject({ choice: "a", confidence: 0.84 })
    const body = JSON.parse(String(sent!.init.body))
    expect(body).toEqual({ state: { m: "hi" }, model: "jev-latest", questions: Q })
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe("Bearer k1")
    expect(sent!.url).toBe("https://api.typesafe.ai/v1/systemone")
  })

  test("missing key → no_key, no request", async () => {
    let called = false
    const out = await systemOne("x", Q, { key: null, fetch: fakeFetch(async () => { called = true; return Response.json(OK_BODY) }) })
    expect(out).toMatchObject({ ok: false, error: "no_key" })
    expect(called).toBe(false)
  })

  test("HTTP error and bad body → not ok", async () => {
    expect(await systemOne("x", Q, { key: "k", fetch: fakeFetch(async () => new Response("no", { status: 429 })) })).toMatchObject({ ok: false, error: "http_429" })
    expect(await systemOne("x", Q, { key: "k", fetch: fakeFetch(async () => Response.json({ hello: 1 })) })).toMatchObject({ ok: false, error: "bad_body" })
    expect(await systemOne("x", Q, { key: "k", fetch: fakeFetch(async () => { throw new TypeError("dns") }) })).toMatchObject({ ok: false, error: "network: TypeError" })
  })

  test("timeout holds even when fetch ignores the abort signal", async () => {
    const t0 = Date.now()
    const out = await systemOne("x", Q, { key: "k", timeoutMs: 50, fetch: fakeFetch(() => new Promise<Response>(() => { /* never */ })) })
    expect(out).toMatchObject({ ok: false, error: "timeout" })
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
