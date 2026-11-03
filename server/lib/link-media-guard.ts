import { lookup } from "node:dns/promises"
import { type Socket, connect, createServer, isIP } from "node:net"

// SSRF guard for bin/media (lib/link-media.ts): only http(s) URLs whose host
// resolves to public addresses. Loopback, private, link-local, CGNAT (the
// tailnet) and multicast are refused. Every byte the server fetches for it
// (safeFetch, yt-dlp and the ffmpeg it spawns) goes through guardProxy(),
// which vets each host after DNS and connects to the vetted address, so
// redirects, og:video, HLS segments and DNS rebinding can't reach a private
// host.

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

/** Resolve a host to one public address to connect to; throws the refusal reason. */
export async function vetHost(hostname: string): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, "")
  let addrs: string[]
  if (isIP(host)) addrs = [host]
  else {
    try {
      addrs = (await lookup(host, { all: true })).map((a) => a.address)
    } catch {
      throw new Error(`cannot resolve ${host}`)
    }
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error("private or loopback host refused")
  return addrs[0]!
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
  try {
    await vetHost(url.hostname)
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
  return { ok: true, url }
}

/** One proxied connection: CONNECT host:port (https) or an absolute-form http request. */
async function forward(client: Socket, buf: Buffer, end: number, vet: typeof vetHost): Promise<void> {
  const lines = buf.subarray(0, end).toString("latin1").split("\r\n")
  const [method, target] = lines[0]!.split(" ")
  const connectMode = method === "CONNECT"
  const u = new URL(connectMode ? `http://${target}` : target ?? "")
  if (!connectMode && u.protocol !== "http:") throw new Error("only http")
  let first = buf.subarray(end + 4)
  if (!connectMode) {
    // Origin-form, one request per connection: a reused proxy connection
    // must not carry a second request to another host.
    const head = [`${method} ${u.pathname}${u.search} HTTP/1.1`, ...lines.slice(1).filter((l) => !/^(proxy-)?connection:/i.test(l)), "Connection: close"]
    first = Buffer.concat([Buffer.from(`${head.join("\r\n")}\r\n\r\n`, "latin1"), first])
  }
  let ip: string
  try {
    ip = await vet(u.hostname)
  } catch {
    client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    return
  }
  const upstream = connect(Number(u.port || (connectMode ? 443 : 80)), ip)
  upstream.on("error", () => (upstream.readyState === "opening" ? client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n") : client.destroy()))
  client.on("close", () => upstream.destroy())
  upstream.on("connect", () => {
    if (connectMode) client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (first.length) upstream.write(first)
    client.pipe(upstream)
    upstream.pipe(client)
  })
}

/** Start a loopback HTTP proxy that only reaches hosts `vet` passes, pinned to the vetted IP. */
export function startGuardProxy(vet: typeof vetHost = vetHost): Promise<{ url: string; close(): void }> {
  const server = createServer((client) => {
    client.on("error", () => client.destroy())
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf("\r\n\r\n")
      if (end < 0) {
        if (buf.length > 16_384) client.destroy()
        return
      }
      client.off("data", onData)
      client.pause()
      forward(client, buf, end, vet).catch(() => client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
    }
    client.on("data", onData)
  })
  server.unref()
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      resolve({ url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, close: () => server.close() })
    })
  })
}

let shared: Promise<string> | null = null
/** The process-wide guard proxy URL (started on first use). */
export function guardProxy(): Promise<string> {
  shared ??= startGuardProxy().then((p) => p.url)
  return shared
}

/** fetch() that re-vets every redirect hop (max 5). */
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  let target = raw
  for (let hop = 0; hop < 6; hop++) {
    const c = await checkUrl(target)
    if (!c.ok) throw new Error(c.reason)
    const res = await fetch(c.url, { ...init, redirect: "manual", proxy: { url: await guardProxy(), respectNoProxy: false } })
    const loc = res.headers.get("location")
    if (res.status < 300 || res.status >= 400 || !loc) return res
    target = new URL(loc, c.url).toString()
  }
  throw new Error("too many redirects")
}
