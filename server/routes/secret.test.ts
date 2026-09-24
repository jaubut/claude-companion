import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.COMPANION_AUTH_TOKEN ??= "test-token-0123456789abcdef"
const { getAuthToken } = await import("../lib/auth")
const { getFeed } = await import("../lib/feed")
const { createRateLimiter, isTrustedSecretTransport, listSecrets } = await import("../lib/secrets")
const { createSecretHandler } = await import("./secret")

const TOKEN = getAuthToken()
let dir: string
let paths: { envPath: string; metaPath: string }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "secret-test-"))
  paths = { envPath: join(dir, "tls-agent", "env"), metaPath: join(dir, "secret-meta.json") }
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function call(handler: ReturnType<typeof createSecretHandler>, method: string, path = "/api/secret", body?: unknown, auth = true) {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return handler(req, new URL(req.url))
}

describe("POST /api/secret", () => {
  test("rejects unauthenticated without touching the file", async () => {
    const h = createSecretHandler({ paths, log: () => {} })
    const res = await call(h, "POST", "/api/secret", { name: "FOO_KEY", value: "x" }, false)
    expect(res?.status).toBe(401)
    expect(listSecrets(paths)).toEqual([])
    expect((await call(h, "GET", "/api/secret", undefined, false))?.status).toBe(401)
  })

  test("rejects bad names and unsafe values", async () => {
    const h = createSecretHandler({ paths, log: () => {}, allow: () => true })
    for (const name of ["", "a", "lower_case", "1ABC", "A", "FOO-BAR", "FOO BAR", "X".repeat(65), 42, null]) {
      const res = await call(h, "POST", "/api/secret", { name, value: "v" })
      expect(res?.status).toBe(400)
      expect(await res!.json()).toEqual({ ok: false, error: "invalid-name" })
    }
    for (const value of ["", "a'b", "a\nb", "a\\b", "a\rb", 5]) {
      const res = await call(h, "POST", "/api/secret", { name: "GOOD_NAME", value })
      expect(await res!.json()).toEqual({ ok: false, error: "invalid-value" })
    }
    expect(listSecrets(paths)).toEqual([])
  })

  test("upsert round-trips without clobbering other lines", async () => {
    const h = createSecretHandler({ paths, log: () => {} })
    await call(h, "POST", "/api/secret", { name: "FIRST", value: "x" }) // creates dir + file
    writeFileSync(paths.envPath, "# agent env\nexport OTHER='keep me'\nTURSO_AUTH_TOKEN=old\nexport FIRST='x'\nTURSO_AUTH_TOKEN=dupe\n")

    const upd = await call(h, "POST", "/api/secret", { name: "TURSO_AUTH_TOKEN", value: "a=b c==d" })
    expect(await upd!.json()).toEqual({ ok: true, name: "TURSO_AUTH_TOKEN", action: "updated" })
    const add = await call(h, "POST", "/api/secret", { name: "NEW_KEY", value: "s p a c e" })
    expect(await add!.json()).toEqual({ ok: true, name: "NEW_KEY", action: "added" })

    expect(readFileSync(paths.envPath, "utf8")).toBe(
      "# agent env\nexport OTHER='keep me'\nTURSO_AUTH_TOKEN='a=b c==d'\nexport FIRST='x'\nexport NEW_KEY='s p a c e'\n",
    )
    expect(statSync(paths.envPath).mode & 0o777).toBe(0o600)

    // The written file is valid shell and yields the exact values back.
    const out = Bun.spawnSync(["sh", "-c", `. "$1"; printf '%s|%s|%s' "$TURSO_AUTH_TOKEN" "$NEW_KEY" "$OTHER"`, "sh", paths.envPath])
    expect(out.stdout.toString()).toBe("a=b c==d|s p a c e|keep me")

    const list = await (await call(h, "GET"))!.json() as { secrets: { name: string; updatedAt: string | null }[] }
    expect(list.secrets.map((s) => s.name)).toEqual(["FIRST", "NEW_KEY", "OTHER", "TURSO_AUTH_TOKEN"])
    expect(list.secrets.find((s) => s.name === "OTHER")!.updatedAt).toBeNull()
    expect(list.secrets.find((s) => s.name === "NEW_KEY")!.updatedAt).toMatch(/^\d{4}-/)

    const del = await call(h, "DELETE", "/api/secret/NEW_KEY")
    expect(await del!.json()).toEqual({ ok: true, name: "NEW_KEY", action: "deleted" })
    expect((await call(h, "DELETE", "/api/secret/NEW_KEY"))?.status).toBe(404)
    expect(readFileSync(paths.envPath, "utf8")).not.toContain("NEW_KEY")
  })

  test("the value never reaches the log, the feed, or a response", async () => {
    const SECRET = "sk-live-SUPER-secret-value-9f8e7d6c"
    const h = createSecretHandler({ paths }) // real companionLog
    const captured: string[] = []
    const origErr = process.stderr.write.bind(process.stderr)
    const origOut = process.stdout.write.bind(process.stdout)
    const origLog = console.log, origError = console.error, origWarn = console.warn
    const grab = ((chunk: string | Uint8Array) => { captured.push(String(chunk)); return true }) as typeof process.stderr.write
    process.stderr.write = grab
    process.stdout.write = grab
    console.log = console.error = console.warn = (...a: unknown[]) => { captured.push(a.map(String).join(" ")) }
    const bodies: string[] = []
    try {
      for (const r of [
        await call(h, "POST", "/api/secret", { name: "LEAK_CHECK", value: SECRET }),
        await call(h, "POST", "/api/secret", { name: "LEAK_CHECK", value: SECRET }),
        await call(h, "POST", "/api/secret", { name: "bad", value: SECRET }),
        await call(h, "GET"),
        await call(h, "DELETE", "/api/secret/LEAK_CHECK"),
      ]) bodies.push(await r!.text())
    } finally {
      process.stderr.write = origErr
      process.stdout.write = origOut
      console.log = origLog; console.error = origError; console.warn = origWarn
    }
    expect(captured.join("\n")).toContain("secret added: LEAK_CHECK") // the log did run
    expect(captured.join("\n")).not.toContain(SECRET)
    expect(bodies.join("\n")).not.toContain(SECRET)
    expect(JSON.stringify(getFeed())).not.toContain(SECRET)
    expect(readFileSync(paths.metaPath, "utf8")).not.toContain(SECRET)
  })

  test("rate-limits writes", async () => {
    const h = createSecretHandler({ paths, log: () => {}, allow: createRateLimiter(2, 60_000) })
    expect((await call(h, "POST", "/api/secret", { name: "A_KEY", value: "1" }))?.status).toBe(200)
    expect((await call(h, "POST", "/api/secret", { name: "A_KEY", value: "2" }))?.status).toBe(200)
    expect((await call(h, "POST", "/api/secret", { name: "A_KEY", value: "3" }))?.status).toBe(429)
  })

  test("ignores other paths", async () => {
    const h = createSecretHandler({ paths, log: () => {} })
    expect(await call(h, "GET", "/api/secrets")).toBeNull()
  })
})

describe("isTrustedSecretTransport", () => {
  const req = (headers: Record<string, string> = {}) => new Request("http://x/api/secret", { headers })
  test("loopback and tailnet peers pass", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.1", "100.101.102.103", "fd7a:115c:a1e0::1"]) {
      expect(isTrustedSecretTransport(ip, req())).toBe(true)
    }
  })
  test("LAN / public peers, http forwarded proto and plain-http origins are refused", () => {
    for (const ip of ["192.168.1.20", "10.0.0.5", "100.128.0.1", "8.8.8.8", "", null, undefined]) {
      expect(isTrustedSecretTransport(ip, req())).toBe(false)
    }
    expect(isTrustedSecretTransport("127.0.0.1", req({ "X-Forwarded-Proto": "http" }))).toBe(false)
    expect(isTrustedSecretTransport("127.0.0.1", req({ Origin: "http://192.168.1.20:4000" }))).toBe(false)
    expect(isTrustedSecretTransport("127.0.0.1", req({ Origin: "https://mac.tailnet.ts.net" }))).toBe(true)
    expect(isTrustedSecretTransport("100.64.0.1", req({ Origin: "http://100.64.0.1:4000" }))).toBe(true)
  })
})
