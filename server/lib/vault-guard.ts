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
//   - 10.8.0.0/24, fdcc:ad94:bacf:61a4::/64 (+ COMPANION_WG_SUBNETS) → direct
//     WireGuard peer (or via local reverse proxy on loopback → wireguard-proxy).
//   - anything else (LAN, public) → refused. X-Forwarded-For from a non-
//     loopback peer is ignored: anyone can send that header.

import { checkBearerHeaderOnly } from "./auth"

export type Transport = "tailscale-serve" | "wireguard" | "wireguard-proxy" | "loopback" | "tailnet" | "untrusted"

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

function parseIpv4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4])
  if (a > 255 || b > 255 || c > 255 || d > 255) return null
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
}

function parseIpv6(ip: string): bigint | null {
  if (!ip.includes(":")) return null
  let groups: string[]
  if (ip.includes("::")) {
    const parts = ip.split("::")
    if (parts.length !== 2) return null
    const left = parts[0] ? parts[0].split(":") : []
    const right = parts[1] ? parts[1].split(":") : []
    if (left.length + right.length > 7) return null
    const fill = Array<string>(8 - left.length - right.length).fill("0")
    groups = [...left, ...fill, ...right]
  } else {
    groups = ip.split(":")
    if (groups.length !== 8) return null
  }
  let val = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    val = (val << 16n) | BigInt(Number.parseInt(g, 16))
  }
  return val
}

// Refuse Docker (172.16.0.0/12), LAN (192.168.0.0/16), loopback (127.0.0.0/8),
// link-local (169.254.0.0/16), 0.0.0.0/8, and multicast/reserved (224.0.0.0/3).
function isForbiddenWgIpv4(v4: number): boolean {
  return (
    ((v4 & 0xfff00000) >>> 0) === 0xac100000 ||
    ((v4 & 0xffff0000) >>> 0) === 0xc0a80000 ||
    ((v4 & 0xff000000) >>> 0) === 0x7f000000 ||
    ((v4 & 0xff000000) >>> 0) === 0 ||
    ((v4 & 0xffff0000) >>> 0) === 0xa9fe0000 ||
    ((v4 & 0xe0000000) >>> 0) === 0xe0000000
  )
}

function isForbiddenWgIpv6(v6: bigint): boolean {
  return v6 <= 1n || (v6 >> 118n) === 0x3fan || (v6 >> 120n) === 0xffn
}

type ExtraWgSubnet =
  | { kind: "v4"; net: number; mask: number }
  | { kind: "v6"; net: bigint; shift: bigint }

function extraWgSubnets(): ExtraWgSubnet[] {
  const raw = process.env.COMPANION_WG_SUBNETS
  if (!raw) return []
  const out: ExtraWgSubnet[] = []
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const slash = trimmed.indexOf("/")
    if (slash <= 0 || trimmed.indexOf("/", slash + 1) !== -1) continue
    const addr = normalize(trimmed.slice(0, slash))
    const prefixStr = trimmed.slice(slash + 1).trim()
    if (!/^\d{1,3}$/.test(prefixStr)) continue
    const prefix = Number(prefixStr)
    const v4 = parseIpv4(addr)
    if (v4 !== null) {
      if (prefix < 16 || prefix > 32) continue
      const mask = (0xffffffff << (32 - prefix)) >>> 0
      const net = (v4 & mask) >>> 0
      if (isForbiddenWgIpv4(v4) || isForbiddenWgIpv4(net)) continue
      out.push({ kind: "v4", net, mask })
      continue
    }
    const v6 = parseIpv6(addr)
    if (v6 !== null) {
      if (prefix < 48 || prefix > 128) continue
      if (isForbiddenWgIpv6(v6)) continue
      const shift = BigInt(128 - prefix)
      out.push({ kind: "v6", net: v6 >> shift, shift })
    }
  }
  return out
}

/**
 * Matches Zettlab wg-easy WireGuard peers: 10.8.0.0/24 and
 * fdcc:ad94:bacf:61a4::/64 by default, plus optional comma-separated CIDRs in
 * COMPANION_WG_SUBNETS (IPv4 >= /16, IPv6 >= /48; never Docker 172.16.0.0/12
 * or LAN 192.168.0.0/16).
 */
export function isWireGuard(ip: string): boolean {
  const a = normalize(ip)
  const v4 = parseIpv4(a)
  if (v4 !== null) {
    if (isForbiddenWgIpv4(v4)) return false
    if (((v4 & 0xffffff00) >>> 0) === 0x0a080000) return true
    for (const s of extraWgSubnets()) {
      if (s.kind === "v4" && ((v4 & s.mask) >>> 0) === s.net) return true
    }
    return false
  }
  const v6 = parseIpv6(a)
  if (v6 !== null) {
    if (isForbiddenWgIpv6(v6)) return false
    if ((v6 >> 64n) === 0xfdccad94bacf61a4n) return true
    for (const s of extraWgSubnets()) {
      if (s.kind === "v6" && (v6 >> s.shift) === s.net) return true
    }
    return false
  }
  return false
}

/** Where the request really comes from. `untrusted` = refuse (403). */
export function clientOrigin(req: Request, tcpPeer: string | null): ClientOrigin {
  if (!tcpPeer) return { transport: "untrusted", peer: "unknown" }
  const peer = normalize(tcpPeer)
  if (isTailnet(peer)) return { transport: "tailnet", peer }
  if (isWireGuard(peer)) return { transport: "wireguard", peer }
  if (!isLoopback(peer)) return { transport: "untrusted", peer }

  const xff = req.headers.get("x-forwarded-for")
  if (!xff) return { transport: "loopback", peer }
  // Funnel / Cloudflare Tunnel = public internet through a local daemon: never.
  if (req.headers.get("tailscale-funnel-request")) return { transport: "untrusted", peer: "funnel" }
  if (req.headers.has("cf-connecting-ip")) return { transport: "untrusted", peer: "cloudflare" }
  const fwd = normalize(xff.split(",").pop() ?? "")
  if (fwd && (isTailnet(fwd) || isLoopback(fwd))) return { transport: "tailscale-serve", peer: fwd }
  if (fwd && isWireGuard(fwd)) return { transport: "wireguard-proxy", peer: fwd }
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
/** POST /api/vault/:name/reveal only — its own budget, not the write one. */
export const revealLimiter = createLimiter(5, 60_000)
/** POST /api/vault/requests only — agents can't drain the phone's write budget. */
export const requestLimiter = createLimiter(3, 60_000)

export function resetVaultLimits(): void {
  writeLimiter.reset()
  readLimiter.reset()
  revealLimiter.reset()
  requestLimiter.reset()
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
