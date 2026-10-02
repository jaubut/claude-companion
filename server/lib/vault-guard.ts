// Network gate + rate limits for the Companion Vault (/api/vault*, /api/secret,
// the `/key` chat command). Pure helpers — the route wires them.
//
// Client address. The server listens on 0.0.0.0 in plain http; the iOS app
// reaches it through `tailscale serve` (HTTPS terminated by tailscaled on the
// same host, reverse-proxied to 127.0.0.1). So the TCP peer Bun reports
// (server.requestIP) is:
//   - loopback + X-Forwarded-For  → proxied by tailscale serve. tailscaled
//     *overwrites* X-Forwarded-For with the real source (ipn/ipnlocal/serve.go
//     addProxyForwardedHeaders: Header.Set, not append), and stamps
//     `Tailscale-Funnel-Request: ?1` on public Funnel traffic after deleting
//     any client-supplied copy. The forwarded address is trusted ONLY here.
//   - loopback, no XFF            → a process on this host.
//   - 100.64.0.0/10, fd7a:115c:a1e0::/48 → direct tailnet peer (WireGuard).
//   - anything else (LAN, public) → refused. X-Forwarded-For from a non-
//     loopback peer is ignored: anyone can send that header.

import { checkBearerHeaderOnly } from "./auth"

export type Transport = "tailscale-serve" | "loopback" | "tailnet" | "untrusted"

export interface ClientOrigin { transport: Transport; peer: string }

const peers = new WeakMap<Request, string>()

/** companion-server.ts records the TCP peer (server.requestIP) per request. */
export function recordPeer(req: Request, address: string | null | undefined): void {
  if (address) peers.set(req, address)
}

export function peerOf(req: Request): string | null {
  return peers.get(req) ?? null
}

function normalize(ip: string): string {
  return ip.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/^::ffff:/, "")
}

export function isLoopback(ip: string): boolean {
  const a = normalize(ip)
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a)
}

export function isTailnet(ip: string): boolean {
  const a = normalize(ip)
  const m = /^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (m) return Number(m[1]) >= 64 && Number(m[1]) <= 127 && Number(m[2]) <= 255 && Number(m[3]) <= 255
  // fd7a:115c:a1e0::/48 — first three hextets fixed.
  return /^fd7a:115c:a1e0(:|$)/.test(a)
}

/** Where the request really comes from. `untrusted` = refuse (403). */
export function clientOrigin(req: Request, tcpPeer: string | null): ClientOrigin {
  if (!tcpPeer) return { transport: "untrusted", peer: "unknown" }
  const peer = normalize(tcpPeer)
  if (isTailnet(peer)) return { transport: "tailnet", peer }
  if (!isLoopback(peer)) return { transport: "untrusted", peer }

  const xff = req.headers.get("x-forwarded-for")
  if (!xff) return { transport: "loopback", peer }
  // Funnel = public internet through tailscaled: never.
  if (req.headers.get("tailscale-funnel-request")) return { transport: "untrusted", peer: "funnel" }
  const fwd = normalize(xff.split(",").pop() ?? "")
  if (fwd && (isTailnet(fwd) || isLoopback(fwd))) return { transport: "tailscale-serve", peer: fwd }
  return { transport: "untrusted", peer: fwd || "unknown" }
}

// ── Rate limits ──
// ponytail: one global sliding window per class — single-user server.

export interface Limiter {
  /** null = allowed (and counted); number = seconds until a slot frees. */
  take(): number | null
  reset(): void
}

export const clock = { now: (): number => Date.now() }

export function createLimiter(max: number, windowMs: number): Limiter {
  let hits: number[] = []
  return {
    take() {
      const t = clock.now()
      hits = hits.filter((h) => t - h < windowMs)
      if (hits.length >= max) return Math.max(1, Math.ceil((hits[0]! + windowMs - t) / 1000))
      hits.push(t)
      return null
    },
    reset() { hits = [] },
  }
}

/** Shared by POST/PATCH/DELETE /api/vault*, POST /api/secret and `/key`. */
export const writeLimiter = createLimiter(10, 60_000)
export const readLimiter = createLimiter(60, 60_000)

export function resetVaultLimits(): void {
  writeLimiter.reset()
  readLimiter.reset()
}

// ── `/key` typed in the chat (POST /api/inject, WS `input`) ──
// Same bar as the vault routes: a trusted network origin AND the bearer in a
// header (a `?token=` query — the WS fallback — is refused for secrets). The
// WS path evaluates this once at upgrade and keeps it on the socket.

export interface KeyGate {
  allowed: boolean
  origin: { transport: string; peer: string; device_claimed: string }
  refusal?: { status: number; error: string; message: string }
}

export function keyCommandGate(req: Request): KeyGate {
  const from = clientOrigin(req, peerOf(req))
  const device = (req.headers.get("x-companion-device") ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 64) || "chat"
  const origin = { transport: from.transport, peer: from.peer, device_claimed: device }
  if (from.transport === "untrusted") {
    return { allowed: false, origin, refusal: { status: 403, error: "forbidden_network", message: "/key refusé: réseau non fiable (tailnet ou loopback seulement). Rien enregistré." } }
  }
  if (!checkBearerHeaderOnly(req)) {
    return { allowed: false, origin, refusal: { status: 401, error: "header_auth_required", message: "/key refusé: jeton dans l'URL — le coffre exige l'en-tête Authorization. Rien enregistré." } }
  }
  return { allowed: true, origin }
}

/** "100.64.0.9/tailnet" — for audit log lines. */
export function originLabel(req: Request): string {
  const o = clientOrigin(req, peerOf(req))
  return `${o.peer}/${o.transport}`
}
