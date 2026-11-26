import { test, expect } from "bun:test"
import { hostname, networkInterfaces } from "node:os"
import { getAuthToken } from "./auth"
import { clientOrigin, isWireGuard, keyCommandGate, recordPeer } from "./vault-guard"
import { funnelRequestAllowed, hookCallerAllowed, hostAllowed, refreshTailscaleName, tailscaleNameOf } from "./request-gate"

// Every /hooks/* route the server answers (routes/hooks.ts, brain.ts, gauge.ts, copy-jobs.ts).
const HOOK_PATHS = [
  "pre-tool-use", "post-tool-use", "user-prompt-submit", "permission-request", "stop", "session-start", "session-end",
  "dispatch-event", "gauge", "copy-progress",
  "brain/propose", "brain/thread", "brain/todo", "brain/sessions", "brain/pr-close", "brain/pr-merge", "brain/pr-update-branch", "brain/pr-resolve-conflicts", "brain/task-cancel", "brain/deploy",
].map((p) => `/hooks/${p}`)

function hookReq(path: string, peer: string, headers: Record<string, string> = {}): Request {
  const req = new Request(`http://127.0.0.1:4245${path}`, { method: "POST", headers, body: "{}" })
  recordPeer(req, peer)
  return req
}

test("non-loopback peer without Bearer is refused on every /hooks/* route", () => {
  for (const path of HOOK_PATHS) {
    for (const peer of ["100.64.0.9", "192.168.1.20", "fd7a:115c:a1e0::5", "8.8.8.8"]) {
      expect(hookCallerAllowed(hookReq(path, peer))).toBe(false)
    }
    // tailscale serve relays tailnet devices from 127.0.0.1 with X-Forwarded-For: remote.
    expect(hookCallerAllowed(hookReq(path, "127.0.0.1", { "x-forwarded-for": "100.64.0.9" }))).toBe(false)
    expect(hookCallerAllowed(hookReq(path, "100.64.0.9", { authorization: "Bearer wrong-token-wrong-token-xx" }))).toBe(false)
  }
})

test("loopback peer, or a remote peer with the Bearer, is allowed", () => {
  for (const path of HOOK_PATHS) {
    expect(hookCallerAllowed(hookReq(path, "127.0.0.1"))).toBe(true)
    expect(hookCallerAllowed(hookReq(path, "::1"))).toBe(true)
    expect(hookCallerAllowed(hookReq(path, "::ffff:127.0.0.1"))).toBe(true)
    expect(hookCallerAllowed(hookReq(path, "100.64.0.9", { authorization: `Bearer ${getAuthToken()}` }))).toBe(true)
  }
})

test("no recorded peer is refused", () => {
  expect(hookCallerAllowed(new Request("http://127.0.0.1:4245/hooks/stop", { method: "POST" }))).toBe(false)
})

test("Host allowlist: this machine's names and IPs only", () => {
  const short = hostname().toLowerCase().split(".")[0]!
  for (const h of [
    "localhost", "localhost:4245", "127.0.0.1", "127.0.0.1:4245", "[::1]", "[::1]:4245", "LOCALHOST:4245",
    hostname(), `${hostname()}:4245`, `${short}.tailfc45f2.ts.net`, `${short}.tailfc45f2.ts.net:443`,
    "100.101.102.103:4245", "[fd7a:115c:a1e0::1]:4245",
  ]) expect([h, hostAllowed(h)]).toEqual([h, true])

  for (const h of [
    null, "", "evil.example", "evil.example:4245", "localhost.evil.example", `${short}.evil.example`,
    `evil.tailfc45f2.ts.net`, `${short}.tailfc45f2.ts.net.evil.example`, `x.${short}.tailfc45f2.ts.net`,
    "evil.example@localhost", "localhost/evil", "8.8.8.8", "[2001:db8::1]", "127.0.0.1:4245 evil",
  ]) expect([h, hostAllowed(h)]).toEqual([h, false])
})

test("Host allowlist: the Tailscale name tailscaled reports, even unlike os.hostname()", async () => {
  const name = "tailnet-name-unlike-host.tailfc45f2.ts.net"
  expect(hostAllowed(name)).toBe(false)

  await refreshTailscaleName(async () => JSON.stringify({ Self: { DNSName: `${name.toUpperCase()}.` } }))
  expect(hostAllowed(name)).toBe(true)
  expect(hostAllowed(`${name}:443`)).toBe(true)
  for (const h of [`x.${name}`, `${name}.evil.example`, "other.tailfc45f2.ts.net"]) expect([h, hostAllowed(h)]).toEqual([h, false])

  // A failed read keeps the last good name.
  await refreshTailscaleName(async () => { throw new Error("no tailscale") })
  await refreshTailscaleName(async () => "not json")
  expect(hostAllowed(name)).toBe(true)
})

test("only a *.ts.net DNSName counts as the Tailscale name", () => {
  expect(tailscaleNameOf(`{"Self":{"DNSName":"mac.tailfc45f2.ts.net."}}`)).toBe("mac.tailfc45f2.ts.net")
  for (const s of ["", "not json", "null", `{"Self":{}}`, `{"Self":{"DNSName":7}}`, `{"Self":{"DNSName":"evil.example."}}`, `{"Self":{"DNSName":"a/b.ts.net."}}`]) {
    expect([s, tailscaleNameOf(s)]).toEqual([s, ""])
  }
})

test("Host allowlist: this machine's LAN addresses and <short>.local (pairing QR), not a foreign LAN IP", () => {
  const short = hostname().toLowerCase().split(".")[0]!
  const v4 = Object.values(networkInterfaces()).flatMap((l) => l ?? []).find((a) => a.family === "IPv4" && !a.internal)
  if (v4) expect(hostAllowed(`${v4.address}:4245`)).toBe(true)
  expect(hostAllowed(`${short}.local:4245`)).toBe(true)
  const mine = new Set(Object.values(networkInterfaces()).flatMap((l) => (l ?? []).map((a) => a.address)))
  const foreign = ["192.168.1.20", "192.168.250.250", "10.250.250.250"].find((ip) => !mine.has(ip))!
  expect(hostAllowed(`${foreign}:4245`)).toBe(false)
  expect(hostAllowed(`evil.local:4245`)).toBe(false)
})

test("browser-originated hook calls are refused even from loopback or with the Bearer", () => {
  const bearer = { authorization: `Bearer ${getAuthToken()}` }
  for (const path of HOOK_PATHS) {
    expect(hookCallerAllowed(hookReq(path, "127.0.0.1", { origin: "https://evil.example" }))).toBe(false)
    expect(hookCallerAllowed(hookReq(path, "127.0.0.1", { origin: "null" }))).toBe(false)
    expect(hookCallerAllowed(hookReq(path, "127.0.0.1", { "sec-fetch-site": "cross-site" }))).toBe(false)
    expect(hookCallerAllowed(hookReq(path, "127.0.0.1", { "sec-fetch-site": "same-site" }))).toBe(false)
    expect(hookCallerAllowed(hookReq(path, "100.64.0.9", { ...bearer, origin: "https://evil.example" }))).toBe(false)
    expect(hookCallerAllowed(hookReq(path, "127.0.0.1", { "sec-fetch-site": "none" }))).toBe(true)
    expect(hookCallerAllowed(hookReq(path, "127.0.0.1", { "sec-fetch-site": "same-origin" }))).toBe(true)
  }
})

test("funnelRequestAllowed admits public Funnel and Cloudflare Tunnel traffic ONLY on /webhooks/github", () => {
  const funnel = { "tailscale-funnel-request": "?1" }
  const cf = { "cf-connecting-ip": "203.0.113.50" }
  expect(funnelRequestAllowed(new Request("http://127.0.0.1:4245/webhooks/github", { method: "POST", headers: funnel }), "/webhooks/github")).toBe(true)
  expect(funnelRequestAllowed(new Request("http://127.0.0.1:4245/webhooks/github", { method: "POST", headers: cf }), "/webhooks/github")).toBe(true)
  for (const path of ["/", "/health", "/ws", "/api/sessions", "/api/mcp/workers", "/hooks/stop", "/webhooks/other"]) {
    expect([path, funnelRequestAllowed(new Request(`http://127.0.0.1:4245${path}`, { headers: funnel }), path)]).toEqual([path, false])
    expect([path, funnelRequestAllowed(new Request(`http://127.0.0.1:4245${path}`, { headers: cf }), path)]).toEqual([path, false])
    expect([path, funnelRequestAllowed(new Request(`http://127.0.0.1:4245${path}`), path)]).toEqual([path, true])
  }
})

test("isWireGuard matches default wg-easy IPv4/IPv6 ranges and validated COMPANION_WG_SUBNETS while rejecting broad/Docker/LAN CIDRs", () => {
  const prev = process.env.COMPANION_WG_SUBNETS
  delete process.env.COMPANION_WG_SUBNETS
  try {
    for (const ip of [
      "10.8.0.0", "10.8.0.1", "10.8.0.2", "10.8.0.255", "::ffff:10.8.0.5",
      "fdcc:ad94:bacf:61a4::1", "[fdcc:ad94:bacf:61a4::1]", "FDCC:AD94:BACF:61A4:0000:0000:0000:0009",
    ]) {
      expect([ip, isWireGuard(ip)]).toEqual([ip, true])
    }
    for (const ip of [
      "", "10.8.1.1", "10.0.0.1", "172.17.0.2", "172.16.0.1", "172.31.255.254",
      "192.168.2.50", "192.168.1.1", "127.0.0.1", "::1", "100.64.0.1",
      "fdcc:ad94:bacf:61a5::1", "fd7a:115c:a1e0::1", "203.0.113.10",
    ]) {
      expect([ip, isWireGuard(ip)]).toEqual([ip, false])
    }

    // Valid custom subnets (>= /16 for IPv4, >= /48 for IPv6) are accepted;
    // overly broad (< /16 IPv4, < /48 IPv6), Docker (172.16.0.0/12), and LAN (192.168.0.0/16) are refused.
    process.env.COMPANION_WG_SUBNETS = "10.99.0.0/16, fd00:cafe:beef::/48, 10.0.0.0/8, fd00::/8, 172.17.0.0/16, 192.168.2.0/24, 127.0.0.0/16, invalid"
    expect(isWireGuard("10.99.4.12")).toBe(true)
    expect(isWireGuard("fd00:cafe:beef:1234::1")).toBe(true)
    expect(isWireGuard("10.1.2.3")).toBe(false)
    expect(isWireGuard("fd00:1111:2222::1")).toBe(false)
    expect(isWireGuard("172.17.0.2")).toBe(false)
    expect(isWireGuard("192.168.2.50")).toBe(false)
    expect(isWireGuard("127.0.0.1")).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.COMPANION_WG_SUBNETS
    else process.env.COMPANION_WG_SUBNETS = prev
  }
})

test("clientOrigin classifies wireguard and wireguard-proxy and blocks XFF spoofing via Funnel, Cloudflare, LAN, or Docker", () => {
  const token = getAuthToken()
  const mk = (peer: string | null, headers: Record<string, string> = {}) => {
    const req = new Request("http://127.0.0.1:4245/api/vault", { headers: { authorization: `Bearer ${token}`, ...headers } })
    recordPeer(req, peer)
    return req
  }

  // Direct WireGuard peers
  expect(clientOrigin(mk("10.8.0.2"), "10.8.0.2")).toEqual({ transport: "wireguard", peer: "10.8.0.2" })
  expect(clientOrigin(mk("fdcc:ad94:bacf:61a4::2"), "fdcc:ad94:bacf:61a4::2")).toEqual({ transport: "wireguard", peer: "fdcc:ad94:bacf:61a4::2" })
  expect(keyCommandGate(mk("10.8.0.2")).allowed).toBe(true)

  // Local reverse proxy (Caddy on loopback) forwarding a WireGuard peer
  expect(clientOrigin(mk("127.0.0.1", { "x-forwarded-for": "10.8.0.3" }), "127.0.0.1")).toEqual({ transport: "wireguard-proxy", peer: "10.8.0.3" })
  expect(clientOrigin(mk("::1", { "x-forwarded-for": "203.0.113.1, fdcc:ad94:bacf:61a4::3" }), "::1")).toEqual({ transport: "wireguard-proxy", peer: "fdcc:ad94:bacf:61a4::3" })
  expect(keyCommandGate(mk("127.0.0.1", { "x-forwarded-for": "10.8.0.3" })).allowed).toBe(true)

  // Spoofed XFF through Cloudflare Tunnel or Tailscale Funnel on loopback -> untrusted
  expect(clientOrigin(mk("127.0.0.1", { "x-forwarded-for": "10.8.0.3", "cf-connecting-ip": "203.0.113.9" }), "127.0.0.1")).toEqual({ transport: "untrusted", peer: "cloudflare" })
  expect(clientOrigin(mk("127.0.0.1", { "x-forwarded-for": "100.64.0.9", "cf-connecting-ip": "203.0.113.9" }), "127.0.0.1")).toEqual({ transport: "untrusted", peer: "cloudflare" })
  expect(clientOrigin(mk("127.0.0.1", { "x-forwarded-for": "127.0.0.1", "cf-connecting-ip": "203.0.113.9" }), "127.0.0.1")).toEqual({ transport: "untrusted", peer: "cloudflare" })
  expect(clientOrigin(mk("127.0.0.1", { "x-forwarded-for": "10.8.0.3", "tailscale-funnel-request": "?1" }), "127.0.0.1")).toEqual({ transport: "untrusted", peer: "funnel" })
  expect(keyCommandGate(mk("127.0.0.1", { "x-forwarded-for": "10.8.0.3", "cf-connecting-ip": "203.0.113.9" })).allowed).toBe(false)

  // Docker container and LAN peers (direct or via loopback XFF or forging XFF) -> untrusted
  for (const bad of ["172.17.0.2", "192.168.2.50"]) {
    expect(clientOrigin(mk(bad), bad)).toEqual({ transport: "untrusted", peer: bad })
    expect(clientOrigin(mk(bad, { "x-forwarded-for": "10.8.0.2" }), bad)).toEqual({ transport: "untrusted", peer: bad })
    expect(clientOrigin(mk("127.0.0.1", { "x-forwarded-for": bad }), "127.0.0.1")).toEqual({ transport: "untrusted", peer: bad })
  }

  // Hook calls without Bearer must remain strict direct loopback-only (never wireguard or wireguard-proxy)
  expect(hookCallerAllowed(hookReq("/hooks/brain/propose", "10.8.0.2"))).toBe(false)
  expect(hookCallerAllowed(hookReq("/hooks/brain/propose", "127.0.0.1", { "x-forwarded-for": "10.8.0.2" }))).toBe(false)
})

test("Host allowlist: WireGuard IPs, built-in WG hostnames, and COMPANION_ALLOWED_HOSTS", () => {
  const prev = process.env.COMPANION_ALLOWED_HOSTS
  delete process.env.COMPANION_ALLOWED_HOSTS
  try {
    for (const h of [
      "10.8.0.1", "10.8.0.1:4245", "[fdcc:ad94:bacf:61a4::1]", "[fdcc:ad94:bacf:61a4::1]:4245",
      "zettlab-wg.cherrypik.app", "zettlab-wg.cherrypik.app:443", "wg.cherrypik.app", "WG.CHERRYPIK.APP:8443",
    ]) {
      expect([h, hostAllowed(h)]).toEqual([h, true])
    }
    for (const h of [
      "evil.example", "evil.cherrypik.app", "zettlab-wg.cherrypik.app.evil.example",
      "172.17.0.2", "192.168.2.50", "10.8.1.1", "[fdcc:ad94:bacf:61a5::1]",
    ]) {
      expect([h, hostAllowed(h)]).toEqual([h, false])
    }

    process.env.COMPANION_ALLOWED_HOSTS = " Custom-WG.Example.com , another-box.internal:8443 , bad/host , evil@host "
    expect(hostAllowed("custom-wg.example.com")).toBe(true)
    expect(hostAllowed("custom-wg.example.com:443")).toBe(true)
    expect(hostAllowed("another-box.internal")).toBe(true)
    expect(hostAllowed("evil.example")).toBe(false)
    expect(hostAllowed("bad/host")).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.COMPANION_ALLOWED_HOSTS
    else process.env.COMPANION_ALLOWED_HOSTS = prev
  }
})
