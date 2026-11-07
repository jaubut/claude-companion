// Test-only: the one definition of what a test may connect to. The tls-test host is public by design,
// like production's URL in turso.ts; the allowlist means a wrong URL refuses whatever it is. Refusals
// never repeat their input, because a libsql URL can carry `?authToken=`.

export const TEST_HOST = "tls-test-jaubut.aws-us-east-1.turso.io"
const REFUSED = `refused: the only Turso database tests may use is ${TEST_HOST}`

/** The tls-test URL in the form turso.ts wants, or a throw. Scripts writing to tls-test go through this too. */
export function testDbUrl(raw: string | undefined): string {
  let u: URL
  try { u = new URL(raw ?? "") } catch { throw new Error(REFUSED) }
  const ok = (u.protocol === "libsql:" || u.protocol === "https:") && u.hostname === TEST_HOST
    && !u.username && !u.password && !u.port && (u.pathname === "" || u.pathname === "/") && !u.search && !u.hash
  if (!ok) throw new Error(REFUSED)
  return `https://${TEST_HOST}`
}

/** fetch, minus every Turso host but tls-test. A stub replacing it reaches no network, so nothing goes around it. */
export function guardFetch(inner: typeof fetch): typeof fetch {
  return (async (input: Request | string | URL, init?: RequestInit) => {
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname.replace(/\.$/, "")
    if (host.endsWith(".turso.io") && host !== TEST_HOST) throw new Error(REFUSED)
    return inner(input, init)
  }) as typeof fetch
}
