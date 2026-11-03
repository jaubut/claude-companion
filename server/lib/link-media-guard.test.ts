import { describe, expect, test } from "bun:test"
import { checkUrl, isPrivateIp } from "./link-media-guard"

describe("bin/media URL guard", () => {
  test("private, loopback, link-local and tailnet IPs are private", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.169.254", "100.64.0.1", "100.127.1.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "nonsense"]) {
      expect(isPrivateIp(ip)).toBe(true)
    }
  })

  test("public IPs pass", () => {
    for (const ip of ["8.8.8.8", "157.240.1.174", "172.32.0.1", "100.128.0.1", "2a03:2880:f12f:83:face:b00c::25de"]) {
      expect(isPrivateIp(ip)).toBe(false)
    }
  })

  test("refuses non-http, private and loopback URLs", async () => {
    for (const u of ["http://127.0.0.1:4245/hooks/brain/propose", "http://10.0.0.5/x.jpg", "http://[::1]/", "http://2130706433/", "http://localhost/", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "ftp://example.com/a", "javascript:alert(1)", "not a url", "http://user:pw@8.8.8.8/"]) {
      expect((await checkUrl(u)).ok).toBe(false)
    }
  })

  test("accepts a public IP literal", async () => {
    const c = await checkUrl("https://8.8.8.8/image.png")
    expect(c.ok).toBe(true)
  })
})
