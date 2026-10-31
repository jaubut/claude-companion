// Request-level network gates, enforced first thing in companion-server.ts —
// before any route, identity or auth decision.

import { hostname } from "node:os"
import { checkBearer } from "./auth"
import { clientOrigin, isLoopback, isTailnet, peerOf } from "./vault-guard"

const FULL = hostname().toLowerCase()
const SHORT = FULL.split(".")[0] ?? ""
const NAMES = new Set(["localhost", FULL, SHORT].filter(Boolean))
// `name`, `[v6]`, optional `:port` — nothing else (no userinfo, no path).
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/

/**
 * DNS rebinding guard: a page on evil.example whose name is re-resolved to
 * 127.0.0.1 / a tailnet IP still sends `Host: evil.example`. Accept only names
 * that are this machine: localhost, os.hostname() (full and short), its
 * Tailscale name `<short>.<tailnet>.ts.net` (what `tailscale serve` and the
 * iOS/Mac app use), and loopback / Tailscale IP literals.
 */
export function hostAllowed(host: string | null): boolean {
  const m = HOST_RE.exec((host ?? "").trim().toLowerCase())
  if (!m) return false
  const name = m[1]!
  if (NAMES.has(name)) return true
  const labels = name.split(".")
  if (SHORT && labels.length === 4 && labels[0] === SHORT && name.endsWith(".ts.net")) return true
  const ip = name.replace(/^\[|\]$/g, "")
  return isLoopback(ip) || isTailnet(ip)
}

/**
 * /hooks/* is for processes on this host: a loopback peer with no proxy in
 * between, or the bearer. Loopback + X-Forwarded-For is `tailscale serve`
 * relaying a tailnet device — remote, so it needs the bearer like anyone else.
 */
export function hookCallerAllowed(req: Request): boolean {
  return clientOrigin(req, peerOf(req)).transport === "loopback" || checkBearer(req)
}
