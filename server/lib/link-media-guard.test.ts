import { describe, expect, test } from "bun:test"
import { checkUrl, isPrivateIp, startGuardProxy, vetHost } from "./link-media-guard"

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

  test("guard proxy refuses loopback and private hosts, by name and through CONNECT", async () => {
    const origin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("internal") })
    const proxy = await startGuardProxy()
    try {
      for (const u of [`http://127.0.0.1:${origin.port}/`, `http://localhost:${origin.port}/`, "http://169.254.169.254/latest/meta-data"]) {
        const res = await fetch(u, { proxy: { url: proxy.url, respectNoProxy: false } })
        expect(res.status).toBe(403)
        expect(await res.text()).toBe("")
      }
      await expect(fetch(`https://localhost:${origin.port}/`, { proxy: { url: proxy.url, respectNoProxy: false } })).rejects.toThrow()
    } finally {
      proxy.close()
      origin.stop(true)
    }
  })

  test("guard proxy connects to the vetted address, not a fresh lookup (rebinding)", async () => {
    const origin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(`${new URL(req.url).pathname}${new URL(req.url).search} ${req.headers.get("host")}`) })
    const asked: string[] = []
    // The vet pins "rebind.test" to loopback; nothing else resolves that name.
    const proxy = await startGuardProxy(async (host) => { asked.push(host); if (host !== "rebind.test") throw new Error("refused"); return "127.0.0.1" })
    try {
      const res = await fetch(`http://rebind.test:${origin.port}/a?b=1`, { proxy: { url: proxy.url, respectNoProxy: false } })
      expect(await res.text()).toBe(`/a?b=1 rebind.test:${origin.port}`)
      expect(asked).toEqual(["rebind.test"])
    } finally {
      proxy.close()
      origin.stop(true)
    }
  })

  test("vetHost returns a public address and refuses loopback names", async () => {
    expect(await vetHost("8.8.8.8")).toBe("8.8.8.8")
    expect(await vetHost("[2a03:2880:f12f:83:face:b00c::25de]")).toBe("2a03:2880:f12f:83:face:b00c::25de")
    await expect(vetHost("localhost")).rejects.toThrow("private or loopback host refused")
  })
})
