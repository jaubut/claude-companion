import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { randomBytes, timingSafeEqual } from "node:crypto"

// Shared-secret bearer auth for the local companion server.
//
// Threat model: the server has macOS Accessibility permission and can paste
// arbitrary keystrokes into the frontmost terminal. Without auth, anyone on
// the LAN (or behind Tailscale Serve) could hit /api/inject and execute
// commands. We require a Bearer token on every state-mutating endpoint and
// on the WebSocket upgrade, and exempt the local-only /hooks/* surface so
// the Claude Code hook scripts don't need credentials.
//
// Storage: ~/.claude-companion/auth.token (mode 0600). Generated on first
// boot if missing. Override with COMPANION_AUTH_TOKEN env var if you'd
// rather manage the secret yourself.

const TOKEN_PATH = join(homedir(), ".claude-companion", "auth.token")

let cached: string | null = null

export function getAuthToken(): string {
  if (cached) return cached
  const fromEnv = process.env.COMPANION_AUTH_TOKEN?.trim()
  if (fromEnv && fromEnv.length >= 16) {
    cached = fromEnv
    return cached
  }
  cached = loadOrCreate()
  return cached
}

function loadOrCreate(): string {
  if (existsSync(TOKEN_PATH)) {
    const raw = readFileSync(TOKEN_PATH, "utf8").trim()
    if (raw.length >= 16) return raw
  }
  // 24 random bytes → 32-char base64url. Plenty of entropy, copy-pastable.
  const t = randomBytes(24).toString("base64url")
  mkdirSync(dirname(TOKEN_PATH), { recursive: true })
  writeFileSync(TOKEN_PATH, t, { mode: 0o600 })
  // chmod again in case the file pre-existed with different perms.
  chmodSync(TOKEN_PATH, 0o600)
  return t
}

// Constant-time compare. Equal-length check is intentional: timingSafeEqual
// throws on length mismatch, so we short-circuit safely first.
export function checkBearer(req: Request): boolean {
  const expected = getAuthToken()
  // Allow either Authorization header OR ?token= query param. Browsers can't
  // set Authorization on `new WebSocket(...)`, so the query-param form lets
  // a future PWA still authenticate.
  const presented = readPresentedToken(req)
  if (!presented) return false
  if (presented.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
  } catch {
    return false
  }
}

function readPresentedToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? ""
  if (auth.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice(7).trim()
    if (t) return t
  }
  // Fallback for clients that can't set headers on the connecting request
  // (notably browser WebSocket).
  const url = new URL(req.url)
  const q = url.searchParams.get("token")?.trim()
  return q || null
}

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="claude-companion"' },
  })
}
