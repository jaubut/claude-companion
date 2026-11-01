// Request-level network gates, enforced first thing in companion-server.ts —
// before any route, identity or auth decision.

import { hostname, networkInterfaces } from "node:os"
import { checkBearer } from "./auth"
import { clientOrigin, isLoopback, isTailnet, peerOf } from "./vault-guard"

const FULL = hostname().toLowerCase()
const SHORT = FULL.split(".")[0] ?? ""
const NAMES = new Set(["localhost", FULL, SHORT, SHORT && `${SHORT}.local`].filter(Boolean))
// `name`, `[v6]`, optional `:port` — nothing else (no userinfo, no path).
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/

/**
 * DNS rebinding guard: a page on evil.example whose name is re-resolved to
 * 127.0.0.1 / a tailnet IP still sends `Host: evil.example`. Accept only names
 * that are this machine: localhost, os.hostname() (full and short), its
 * Tailscale name `<short>.<tailnet>.ts.net` (what `tailscale serve` and the
 * iOS/Mac app use), `<short>.local`, and loopback / Tailscale / this machine's
 * own interface IP literals (scripts/pair.ts puts a LAN IP in the pairing QR).
 */
export function hostAllowed(host: string | null): boolean {
  const m = HOST_RE.exec((host ?? "").trim().toLowerCase())
  if (!m) return false
  const name = m[1]!
  if (NAMES.has(name)) return true
  const labels = name.split(".")
  if (SHORT && labels.length === 4 && labels[0] === SHORT && name.endsWith(".ts.net")) return true
  const ip = name.replace(/^\[|\]$/g, "")
  return isLoopback(ip) || isTailnet(ip) || localAddresses().has(ip)
}

// Read per call: DHCP / Wi-Fi changes move the LAN address while the server runs.
function localAddresses(): Set<string> {
  return new Set(Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address.toLowerCase())))
}

/**
 * /hooks/* is for processes on this host: a loopback peer with no proxy in
 * between, or the bearer. Loopback + X-Forwarded-For is `tailscale serve`
 * relaying a tailnet device — remote, so it needs the bearer like anyone else.
 * Browsers are refused outright: a cross-site text/plain POST is "simple" (no
 * preflight) but carries Origin / Sec-Fetch-Site; hook scripts send neither.
 */
export function hookCallerAllowed(req: Request): boolean {
  if (req.headers.has("origin")) return false
  const site = req.headers.get("sec-fetch-site")
  if (site !== null && site !== "none" && site !== "same-origin") return false
  return clientOrigin(req, peerOf(req)).transport === "loopback" || checkBearer(req)
}
