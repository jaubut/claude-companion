// Request-level network gates, enforced first thing in companion-server.ts —
// before any route, identity or auth decision.

import { hostname, networkInterfaces } from "node:os"
import { checkBearer } from "./auth"
import { clientOrigin, isLoopback, isTailnet, isWireGuard, peerOf } from "./vault-guard"

const FULL = hostname().toLowerCase()
const SHORT = FULL.split(".")[0] ?? ""
const WG_HOSTS = ["zettlab-wg.cherrypik.app", "wg.cherrypik.app"]
const NAMES = new Set(["localhost", FULL, SHORT, SHORT && `${SHORT}.local`, ...WG_HOSTS].filter(Boolean))
// This machine's name on the tailnet, from tailscaled: os.hostname() need not
// match it (the Mac is "Mac" and "m2-max-ji-dog" on the tailnet).
let tailscaleName = ""
// `name`, `[v6]`, optional `:port` — nothing else (no userinfo, no path).
const HOST_RE = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/

function extraAllowedHosts(): Set<string> {
  const raw = process.env.COMPANION_ALLOWED_HOSTS
  if (!raw) return new Set()
  const out = new Set<string>()
  for (const part of raw.split(",")) {
    const clean = part.trim().toLowerCase()
    const m = HOST_RE.exec(clean)
    if (m?.[1]) out.add(m[1])
  }
  return out
}

/**
 * DNS rebinding guard: a page on evil.example whose name is re-resolved to
 * 127.0.0.1 / a tailnet IP still sends `Host: evil.example`. Accept only names
 * that are this machine: localhost, os.hostname() (full and short), its
 * Tailscale name (what `tailscale serve` and the iOS/Mac app use), either as
 * tailscaled reports it or `<short>.<tailnet>.ts.net`, `<short>.local`, built-in
 * private WireGuard hostnames + COMPANION_ALLOWED_HOSTS, and loopback /
 * Tailscale / WireGuard / this machine's own interface IP literals
 * (scripts/pair.ts puts a LAN IP in the pairing QR).
 */
export function hostAllowed(host: string | null): boolean {
  const m = HOST_RE.exec((host ?? "").trim().toLowerCase())
  if (!m) return false
  const name = m[1]!
  if (NAMES.has(name) || name === tailscaleName || extraAllowedHosts().has(name)) return true
  const labels = name.split(".")
  if (SHORT && labels.length === 4 && labels[0] === SHORT && name.endsWith(".ts.net")) return true
  // On wake-from-sleep or cold boot, tailscaled may not have answered yet
  // while os.hostname() differs from the tailnet DNS name. Trigger an
  // immediate background refresh so subsequent retries succeed quickly.
  if (!tailscaleName && name.endsWith(".ts.net")) triggerTailscaleRefresh()
  const ip = name.replace(/^\[|\]$/g, "")
  return isLoopback(ip) || isTailnet(ip) || isWireGuard(ip) || localAddresses().has(ip)
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

const TAILSCALE_BINS = [
  "tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
]

async function readTailscaleStatus(): Promise<string> {
  for (const bin of TAILSCALE_BINS) {
    try {
      const p = Bun.spawn([bin, "status", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 3_000 })
      const out = await new Response(p.stdout).text()
      if ((await p.exited) === 0 && out.trim()) return out
    } catch {
      continue
    }
  }
  return ""
}

let refreshInFlight: Promise<void> | null = null
let lastRefreshAt = 0
let activeReader: (() => Promise<string>) | null = null

// One read; a failed one keeps the last good name.
export async function refreshTailscaleName(read: () => Promise<string> = readTailscaleStatus): Promise<void> {
  const name = tailscaleNameOf(await read().catch(() => ""))
  if (name) tailscaleName = name
}

/** Test-only reset to simulate cold boot before tailscaled answers. */
export function _resetTailscaleNameForTest(): void {
  tailscaleName = ""
  activeReader = null
  lastRefreshAt = 0
}

function triggerTailscaleRefresh(): void {
  const reader = activeReader
  if (!reader) return
  const now = Date.now()
  if (refreshInFlight || now - lastRefreshAt < 1_000) return
  lastRefreshAt = now
  refreshInFlight = refreshTailscaleName(reader).finally(() => { refreshInFlight = null })
}

// tailscaled may start after this server (or reconnect after Mac sleep), and a
// machine can be renamed, so the name is read now and refreshed periodically.
// While tailscaleName is still empty, retry quickly (fastRetryMs) so boot/wake
// 421s recover in seconds instead of waiting a full minute.
export function watchTailscaleName(
  everyMs = 60_000,
  read: () => Promise<string> = readTailscaleStatus,
  fastRetryMs = 2_000,
): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  activeReader = read
  const schedule = () => {
    if (stopped) return
    const delay = tailscaleName ? everyMs : Math.min(everyMs, fastRetryMs)
    timer = setTimeout(async () => {
      if (stopped) return
      await refreshTailscaleName(read)
      schedule()
    }, delay)
    timer.unref?.()
  }
  void refreshTailscaleName(read).finally(schedule)
  return () => {
    stopped = true
    if (activeReader === read) activeReader = null
    if (timer) clearTimeout(timer)
  }
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

/**
 * Public Tailscale Funnel (`Tailscale-Funnel-Request`) or Cloudflare Tunnel
 * (`CF-Connecting-IP`) traffic is admitted ONLY on `/webhooks/github`, never on
 * `/api/*`, `/hooks/*`, `/ws`, `/health`, or `/`.
 */
export function funnelRequestAllowed(req: Request, pathname: string): boolean {
  if (!req.headers.has("tailscale-funnel-request") && !req.headers.has("cf-connecting-ip")) return true
  return pathname === "/webhooks/github"
}
