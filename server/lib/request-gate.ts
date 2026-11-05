// Request-level network gates, enforced first thing in companion-server.ts —
// before any route, identity or auth decision.

import { hostname, networkInterfaces } from "node:os"
import { checkBearer } from "./auth"
import { clientOrigin, isLoopback, isTailnet, peerOf } from "./vault-guard"

const FULL = hostname().toLowerCase()
const SHORT = FULL.split(".")[0] ?? ""
const NAMES = new Set(["localhost", FULL, SHORT, SHORT && `${SHORT}.local`].filter(Boolean))
// This machine's name on the tailnet, from tailscaled: os.hostname() need not
// match it (the Mac is "Mac" and "m2-max-ji-dog" on the tailnet).
let tailscaleName = ""
// `name`, `[v6]`, optional `:port` — nothing else (no userinfo, no path).
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/

/**
 * DNS rebinding guard: a page on evil.example whose name is re-resolved to
 * 127.0.0.1 / a tailnet IP still sends `Host: evil.example`. Accept only names
 * that are this machine: localhost, os.hostname() (full and short), its
 * Tailscale name (what `tailscale serve` and the iOS/Mac app use), either as
 * tailscaled reports it or `<short>.<tailnet>.ts.net`, `<short>.local`, and
 * loopback / Tailscale / this machine's own interface IP literals
 * (scripts/pair.ts puts a LAN IP in the pairing QR).
 */
export function hostAllowed(host: string | null): boolean {
  const m = HOST_RE.exec((host ?? "").trim().toLowerCase())
  if (!m) return false
  const name = m[1]!
  if (NAMES.has(name) || name === tailscaleName) return true
  const labels = name.split(".")
  if (SHORT && labels.length === 4 && labels[0] === SHORT && name.endsWith(".ts.net")) return true
  const ip = name.replace(/^\[|\]$/g, "")
  return isLoopback(ip) || isTailnet(ip) || localAddresses().has(ip)
}

// Self.DNSName of `tailscale status --json`, trailing dot dropped; "" for
// anything else. A failed read never widens the allowlist.
export function tailscaleNameOf(status: string): string {
  try {
    const name = (JSON.parse(status) as { Self?: { DNSName?: unknown } }).Self?.DNSName
    if (typeof name !== "string") return ""
    const clean = name.trim().toLowerCase().replace(/\.$/, "")
    return HOST_RE.test(clean) && clean.endsWith(".ts.net") ? clean : ""
  } catch { return "" }
}

async function readTailscaleStatus(): Promise<string> {
  const p = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 3_000 })
  const out = await new Response(p.stdout).text()
  return (await p.exited) === 0 ? out : ""
}

// One read; a failed one keeps the last good name.
export async function refreshTailscaleName(read: () => Promise<string> = readTailscaleStatus): Promise<void> {
  const name = tailscaleNameOf(await read().catch(() => ""))
  if (name) tailscaleName = name
}

// tailscaled may start after this server, and a machine can be renamed, so the
// name is read now and every minute. Until the first read lands, `tailscale
// serve` requests get 421 unless the short-name rule above matches them.
export function watchTailscaleName(everyMs = 60_000): void {
  void refreshTailscaleName()
  setInterval(() => void refreshTailscaleName(), everyMs).unref()
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
