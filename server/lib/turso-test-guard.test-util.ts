// Test-only: the one definition of what a test may connect to. The tls-test host is public by design,
// like production's URL in turso.ts; the allowlist means a wrong URL refuses whatever it is. Refusals
// never repeat their input, because a libsql URL can carry `?authToken=`.

export const TEST_HOST = "tls-sqld-test-1016439101738.northamerica-northeast1.run.app"
const REFUSED = `refused: the only Turso database tests may use is ${TEST_HOST}`

/** The tls-test URL in the form turso.ts wants, or a throw. Scripts writing to tls-test go through this too. */
export function testDbUrl(raw: string | undefined): string {
  let u: URL
  try { u = new URL(raw ?? "") } catch { throw new Error(REFUSED) }
  const cleanOriginOnly = !u.username && !u.password && (u.pathname === "" || u.pathname === "/") && !u.search && !u.hash
  if (cleanOriginOnly && (u.protocol === "libsql:" || u.protocol === "https:") && u.hostname === TEST_HOST && !u.port) {
    return `https://${TEST_HOST}`
  }
  if (cleanOriginOnly && u.protocol === "http:" && u.hostname === "127.0.0.1" && /^[1-9][0-9]{0,4}$/.test(u.port) && Number(u.port) <= 65535) {
    return `http://127.0.0.1:${u.port}`
  }
  throw new Error(REFUSED)
}

/** fetch, minus every Turso / tls-sqld production host but tls-test. A stub replacing it reaches no network, so nothing goes around it. */
export function guardFetch(inner: typeof fetch): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname.replace(/\.$/, "")
    if ((host.endsWith(".turso.io") || host.endsWith(".run.app") || host.startsWith("tls-sqld-")) && host !== TEST_HOST) throw new Error(REFUSED)
    return inner(input, init)
  }) as typeof fetch
}
