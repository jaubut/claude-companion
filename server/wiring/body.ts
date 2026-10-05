import type { ApnsPayload } from "../lib/apns"
import { apnsConfigured } from "../lib/apns"
import { type BodyAlert, bodyPushEnabled, createPushGate } from "../lib/body-alert"
import { BODY_CHANNEL, BODY_CHANNEL_NAME, type BodySnapshot, buildBodyDigest, createBodySnapshot, isHealthIntent } from "../lib/body"
import { type TokensSnapshot, createTokensSnapshot } from "../lib/body-tokens"
import { companionLog } from "../lib/log"
import { type Turn, appendTurn } from "../lib/orchestrator-chat"
import { type Channel, ensureChannel } from "../lib/orchestrator-channels"
import { pushToAll } from "../lib/push"
import { tursoQuery } from "../lib/turso"
import { broadcast } from "../state"

// Body monitor wiring: the live 30 s snapshot (route + brain share it) and the
// alert sink — Body-channel turn, `body_alert` WS frame, gated APNs push.

export const bodySnapshot: BodySnapshot = createBodySnapshot(tursoQuery)
export const tokensSnapshot: TokensSnapshot = createTokensSnapshot(tursoQuery)

export interface BodyAlertSinkDeps {
  appendTurn: (text: string) => Turn
  ensureChannel: () => { channel: Channel; created: boolean }
  broadcast: (frame: Record<string, unknown>) => void
  push: (payload: ApnsPayload) => void
  /** Sender configured AND COMPANION_BODY_PUSH !== "0" (lib/body-alert.ts). */
  pushEnabled: () => boolean
  now?: () => number
  schedule?: (fn: () => void, ms: number) => void
}

export type BodyAlertSink = (alert: BodyAlert) => { pushed: boolean; turn: Turn }

export function createBodyAlertSink(deps: BodyAlertSinkDeps): BodyAlertSink {
  const now = deps.now ?? Date.now
  const gate = createPushGate({ push: deps.push, now, schedule: deps.schedule })
  return (alert) => {
    const { channel, created } = deps.ensureChannel()
    if (created) deps.broadcast({ type: "orchestrator_channel", channel })
    // Same frame orchEmit sends — the thread stays live on every device.
    const turn = deps.appendTurn(`${alert.title}\n${alert.message}`)
    deps.broadcast({ type: "orchestrator", turn })
    deps.broadcast({ type: "body_alert", alert: { ...alert, at: new Date(now()).toISOString() } })
    const pushed = deps.pushEnabled() && gate.offer(alert)
    return { pushed, turn }
  }
}

export const bodyAlertSink: BodyAlertSink = createBodyAlertSink({
  appendTurn: (text) => appendTurn("orchestrator", text, null, BODY_CHANNEL),
  ensureChannel: () => ensureChannel(BODY_CHANNEL, BODY_CHANNEL_NAME),
  broadcast,
  push: (payload) => void pushToAll(payload).catch(() => { /* never break the collector's POST */ }),
  pushEnabled: () => bodyPushEnabled(apnsConfigured()),
})

// Brain context: the digest rides along for every message in #Body and for a
// health question anywhere else. Never throws — an unreachable Turso becomes a
// one-line note so the brain can say so instead of guessing.
export function wantsBodyDigest(channelId: string, text: string): boolean {
  return channelId === BODY_CHANNEL || isHealthIntent(text)
}

export async function bodyDigestFor(channelId: string, text: string, snapshot: BodySnapshot = bodySnapshot, force = false): Promise<string | null> {
  if (!force && !wantsBodyDigest(channelId, text)) return null
  try {
    return buildBodyDigest(await snapshot.get())
  } catch (err) {
    companionLog(`[body] digest unavailable (${(err as Error)?.message ?? "error"})`)
    return "Body monitor: unreachable right now (Turso read failed) — no live health data."
  }
}
