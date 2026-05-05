import { listTokens, removeToken } from "./push-tokens"
import { apnsConfigured, sendApns, type ApnsPayload } from "./apns"

export interface PushDispatchResult { sent: number; pruned: number; total: number }

// Fan out one payload to every registered device. Tokens that Apple rejects
// as BadDeviceToken / Unregistered / status 410 are removed so the DB stays
// self-cleaning (app uninstall, revoked token, etc).
export async function pushToAll(payload: ApnsPayload): Promise<PushDispatchResult> {
  if (!apnsConfigured()) return { sent: 0, pruned: 0, total: 0 }
  const tokens = listTokens()
  if (tokens.length === 0) return { sent: 0, pruned: 0, total: 0 }
  let sent = 0
  let pruned = 0
  await Promise.all(tokens.map(async t => {
    const r = await sendApns(t.token, t.environment, payload)
    if (r.ok) {
      sent++
      return
    }
    if (r.status === 410 || r.reason === "BadDeviceToken" || r.reason === "Unregistered") {
      removeToken(t.token)
      pruned++
    }
  }))
  return { sent, pruned, total: tokens.length }
}
