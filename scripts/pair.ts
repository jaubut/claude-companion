import { networkInterfaces } from "node:os"
import qrcode from "qrcode"
import { getAuthToken } from "../server/lib/auth"

// Pairing UX: print a scannable QR + plaintext fallback so the iOS app's
// "Scan QR" button can fill URL + token in one tap. JSON-encoded payload
// keeps the format client-agnostic — any future PWA / Android / Mac client
// can decode it the same way.

interface PairPayload {
  v: 1
  url: string
  token: string
}

const dim = "\x1b[2m"
const reset = "\x1b[0m"
const cyan = "\x1b[36m"
const bold = "\x1b[1m"

export async function printPair(opts: { url?: string; port?: number } = {}): Promise<void> {
  const port = opts.port ?? (Number(process.env.COMPANION_PORT) || 4245)
  const url = opts.url?.trim() || autoDetectURL(port)
  const token = getAuthToken()

  const payload: PairPayload = { v: 1, url, token }
  const json = JSON.stringify(payload)

  console.log(`${bold}Pair Claude Companion${reset}\n`)

  // Prefer terminal-rendered QR — small enough to scan from across a room.
  // Width is auto-sized by the qrcode lib's terminal renderer.
  const qr = await qrcode.toString(json, {
    type: "terminal",
    errorCorrectionLevel: "M",
    small: true,
  })
  console.log(qr)

  console.log(`${dim}or paste manually:${reset}`)
  console.log(`  ${dim}URL  ${reset} ${cyan}${url}${reset}`)
  console.log(`  ${dim}Token${reset} ${cyan}${token}${reset}`)
  console.log()
  console.log(`${dim}If your phone can't reach this URL, pass --url <override>${reset}`)
  console.log(`${dim}(e.g. your Tailscale Serve URL: https://mac-name.tailnet.ts.net)${reset}`)
}

// Pick a LAN-routable IPv4 the iPhone can reach. Skips loopback, point-to-
// point tunnels (Tailscale's `utun*`), and Apple Wireless Direct Link
// (`awdl*`). The first remaining external interface wins — typically en0.
function autoDetectURL(port: number): string {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    if (name.startsWith("lo") || name.startsWith("utun") || name.startsWith("awdl") || name.startsWith("llw")) {
      continue
    }
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return `http://${iface.address}:${port}`
      }
    }
  }
  return `http://127.0.0.1:${port}`
}
