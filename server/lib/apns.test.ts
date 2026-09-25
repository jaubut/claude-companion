import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import net from "node:net"
import type http2 from "node:http2"
import { APNS_CONNECT_OPTIONS, closeApnsSessions, disableAutoSelectFamily, getSession } from "./apns"

test("happy-eyeballs is off process-wide after boot (Bun 1.3.11 node:net crash)", () => {
  const before = net.getDefaultAutoSelectFamily()
  try {
    expect(disableAutoSelectFamily()).toBe(true)
    expect(net.getDefaultAutoSelectFamily()).toBe(false)
  } finally {
    net.setDefaultAutoSelectFamily(before)
  }
})

// A dial that fails the way a dead network does: 'error' on the session.
class FakeSession extends EventEmitter {
  closed = false
  destroyed = false
  close() { this.closed = true; this.emit("close") }
}

test("APNs connect passes autoSelectFamily:false and survives a session 'error'", () => {
  closeApnsSessions()
  const seen: Array<{ authority: string; options: unknown }> = []
  const fake = new FakeSession()
  const connect = (authority: string, options: http2.SecureClientSessionOptions) => {
    seen.push({ authority, options })
    return fake as unknown as http2.ClientHttp2Session
  }
  const s = getSession("sandbox", connect)
  expect(s as unknown).toBe(fake)
  expect(seen[0]?.authority).toBe("https://api.sandbox.push.apple.com")
  expect(seen[0]?.options).toMatchObject({ autoSelectFamily: false })
  expect(APNS_CONNECT_OPTIONS.autoSelectFamily).toBe(false)

  // An unhandled http2 session 'error' would throw here; a listener must exist.
  expect(fake.listenerCount("error")).toBeGreaterThan(0)
  expect(() => fake.emit("error", new Error("connect ETIMEDOUT"))).not.toThrow()

  // The broken session is dropped: the next send dials fresh.
  const fake2 = new FakeSession()
  const s2 = getSession("sandbox", () => fake2 as unknown as http2.ClientHttp2Session)
  expect(s2 as unknown).toBe(fake2)
  closeApnsSessions()
})
