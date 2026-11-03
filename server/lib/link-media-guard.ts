import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

// SSRF guard for bin/media (lib/link-media.ts): only http(s) URLs whose host
// resolves to public addresses. Loopback, private, link-local, CGNAT (the
// tailnet) and multicast are refused.
// ponytail: checks DNS once; yt-dlp resolves again itself (rebinding window).
// Pin the resolved IP per request if that ever matters.

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

const V4_BLOCKED: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
  [0xac100000, 12], [0xc0000000, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xe0000000, 3],
]

function v4Private(ip: string): boolean {
  const n = ip.split(".").reduce((a, o) => (a << 8 >>> 0) + Number(o), 0) >>> 0
  return V4_BLOCKED.some(([net, bits]) => (n >>> (32 - bits)) === (net >>> (32 - bits)))
}

/** True for any address the server must never fetch from. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return v4Private(ip)
  if (kind !== 6) return true
  const low = ip.toLowerCase()
  const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return v4Private(mapped[1]!)
  if (low === "::" || low === "::1" || low.startsWith("::ffff:")) return true
  return /^(f[cd]|fe[89ab]|ff)/.test(low)
}

/** Parse and vet a URL: http(s), public host. DNS failure is a refusal. */
export async function checkUrl(raw: string): Promise<UrlCheck> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: "not a valid URL" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "only http(s) URLs" }
  if (url.username || url.password) return { ok: false, reason: "credentials in URL refused" }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  let addrs: string[]
  if (isIP(host)) addrs = [host]
  else {
    try {
      addrs = (await lookup(host, { all: true })).map((a) => a.address)
    } catch {
      return { ok: false, reason: `cannot resolve ${host}` }
    }
  }
  if (!addrs.length || addrs.some(isPrivateIp)) return { ok: false, reason: "private or loopback host refused" }
  return { ok: true, url }
}

/** fetch() that re-vets every redirect hop (max 5). */
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  let target = raw
  for (let hop = 0; hop < 6; hop++) {
    const c = await checkUrl(target)
    if (!c.ok) throw new Error(c.reason)
    const res = await fetch(c.url, { ...init, redirect: "manual" })
    const loc = res.headers.get("location")
    if (res.status < 300 || res.status >= 400 || !loc) return res
    target = new URL(loc, c.url).toString()
  }
  throw new Error("too many redirects")
}
