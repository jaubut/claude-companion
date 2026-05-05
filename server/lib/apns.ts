import { readFileSync } from "node:fs"
import http2 from "node:http2"
import type { ApnsEnv } from "./push-tokens"

// Read env lazily — cli.ts loads ~/.claude-companion/.env AFTER all ES module
// imports have resolved, so grabbing these at module-init time would see empty
// strings. Instead, every call site goes through these getters.
function teamId(): string { return process.env.APNS_TEAM_ID ?? "" }
function keyId(): string { return process.env.APNS_KEY_ID ?? "" }
function p8Path(): string { return process.env.APNS_KEY_P8_PATH ?? "" }
function bundleId(): string { return process.env.APNS_BUNDLE_ID ?? "" }

export function apnsConfigured(): boolean {
  return Boolean(teamId() && keyId() && p8Path() && bundleId())
}

// .p8 PEM → CryptoKey, cached once per process.
let keyPromise: Promise<CryptoKey> | null = null
function getSigningKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = (async () => {
      const pem = readFileSync(p8Path(), "utf8")
      const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s+/g, "")
      const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      return crypto.subtle.importKey(
        "pkcs8",
        der,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      )
    })()
  }
  return keyPromise
}

// JWT is valid up to 1h per Apple; refresh a bit early.
const JWT_TTL_MS = 50 * 60 * 1000
let cachedJwt: { token: string; issuedAt: number } | null = null

function b64url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function getJwt(): Promise<string> {
  if (cachedJwt && Date.now() - cachedJwt.issuedAt < JWT_TTL_MS) return cachedJwt.token
  const header = { alg: "ES256", kid: keyId(), typ: "JWT" }
  const payload = { iss: teamId(), iat: Math.floor(Date.now() / 1000) }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const key = await getSigningKey()
  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  )
  const jwt = `${signingInput}.${b64url(new Uint8Array(sigBuf))}`
  cachedJwt = { token: jwt, issuedAt: Date.now() }
  return jwt
}

export interface ApnsPayload {
  title: string
  /** One-line context shown between title and body on iOS banners. */
  subtitle?: string
  body: string
  category: "approval" | "waiting_input"
  threadId?: string
  /** Arbitrary key/value data the iOS app can read from userInfo. */
  userInfo?: Record<string, string>
}

export interface ApnsResult {
  token: string
  ok: boolean
  status: number
  reason?: string
}

// APNs requires HTTP/2. Bun's `fetch` as of 1.3.x negotiates HTTP/1.1 with
// Apple's APNs endpoint and returns Malformed_HTTP_Response, so we use
// node:http2 directly. One session per env (sandbox/production) is reused
// across sends; Apple keeps idle connections alive for a while.
const sessions = new Map<ApnsEnv, http2.ClientHttp2Session>()

function getSession(env: ApnsEnv): http2.ClientHttp2Session {
  const existing = sessions.get(env)
  if (existing && !existing.closed && !existing.destroyed) return existing
  const host = env === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com"
  const session = http2.connect(host)
  session.on("error", () => { sessions.delete(env) })
  session.on("close", () => { sessions.delete(env) })
  sessions.set(env, session)
  return session
}

export function closeApnsSessions(): void {
  for (const s of sessions.values()) { try { s.close() } catch { /* ignore */ } }
  sessions.clear()
}

export async function sendApns(deviceToken: string, env: ApnsEnv, payload: ApnsPayload): Promise<ApnsResult> {
  if (!apnsConfigured()) return { token: deviceToken, ok: false, status: 0, reason: "not-configured" }
  const interruptive = payload.category === "approval"
  const alert: Record<string, string> = { title: payload.title, body: payload.body }
  if (payload.subtitle) alert.subtitle = payload.subtitle
  const body: Record<string, unknown> = {
    aps: {
      alert,
      sound: interruptive ? "default" : "",
      "interruption-level": interruptive ? "time-sensitive" : "passive",
      "thread-id": payload.threadId ?? payload.category,
      category: payload.category,
    },
    ...(payload.userInfo ?? {}),
  }

  try {
    const jwt = await getJwt()
    const session = getSession(env)
    const bodyBytes = Buffer.from(JSON.stringify(body))

    return await new Promise<ApnsResult>((resolve) => {
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": bundleId(),
        "apns-push-type": "alert",
        "apns-priority": interruptive ? "10" : "5",
        "content-type": "application/json",
        "content-length": bodyBytes.length.toString(),
      })

      // Manual timer instead of req.setTimeout() — http2's setTimeout
      // delegates to the underlying TLS socket and registers a `once`
      // listener there each call. The session is shared across all sends,
      // so listeners stack up and Node fires MaxListenersExceededWarning
      // after ~11 pushes. A plain setTimeout has no socket affinity.
      let settled = false
      const settle = (result: ApnsResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        req.close()
        settle({ token: deviceToken, ok: false, status: 0, reason: "timeout" })
      }, 10_000)

      let status = 0
      const chunks: Buffer[] = []

      req.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0)
      })
      req.on("data", (chunk: Buffer) => { chunks.push(chunk) })
      req.on("end", () => {
        if (status === 200) return settle({ token: deviceToken, ok: true, status })
        let reason: string | undefined
        if (chunks.length > 0) {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: string }
            reason = parsed.reason
          } catch { /* non-JSON body */ }
        }
        settle({ token: deviceToken, ok: false, status, reason })
      })
      req.on("error", (err) => {
        settle({ token: deviceToken, ok: false, status: 0, reason: err.message })
      })

      req.end(bodyBytes)
    })
  } catch (err) {
    return { token: deviceToken, ok: false, status: 0, reason: err instanceof Error ? err.message : "send-failed" }
  }
}
