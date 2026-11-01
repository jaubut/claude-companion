import { test, expect } from "bun:test"
import { hostname, networkInterfaces } from "node:os"
import { getAuthToken } from "./auth"
import { recordPeer } from "./vault-guard"
import { hookCallerAllowed, hostAllowed } from "./request-gate"

// Every /hooks/* route the server answers (routes/hooks.ts, brain.ts, gauge.ts, copy-jobs.ts).
const HOOK_PATHS = [
  "pre-tool-use", "post-tool-use", "user-prompt-submit", "permission-request", "stop", "session-start", "session-end",
  "dispatch-event", "gauge", "copy-progress",
  "brain/propose", "brain/thread", "brain/todo", "brain/sessions", "brain/pr-close", "brain/pr-merge", "brain/deploy",
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
