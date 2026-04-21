/**
 * Web Push — browser-native push notifications via VAPID.
 *
 * No extra apps on the phone. Once the user opens the companion in Safari/Chrome,
 * installs it as a PWA, and grants notification permission, the service worker
 * receives pushes even when the tab is closed.
 *
 * iOS 16.4+ requires the PWA to be served over HTTPS and added to the Home Screen.
 * Over Tailscale Serve or a self-signed cert trusted on device both work.
 *
 * Config lives in ~/.claude-companion/ :
 *   vapid.json          — keypair (generated on first run)
 *   subscriptions.json  — active push subscriptions (one per device)
 *
 * Both are created with 0600 perms.
 */

import webpush, { type PushSubscription } from "web-push"
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CONFIG_DIR = join(homedir(), ".claude-companion")
const VAPID_FILE = join(CONFIG_DIR, "vapid.json")
const SUBS_FILE = join(CONFIG_DIR, "subscriptions.json")

type VapidKeys = { publicKey: string; privateKey: string; subject: string }

function ensureDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
}

function loadOrCreateVapid(): VapidKeys {
  ensureDir()
  if (existsSync(VAPID_FILE)) {
    return JSON.parse(readFileSync(VAPID_FILE, "utf8")) as VapidKeys
  }
  const keys = webpush.generateVAPIDKeys()
  const subject =
    process.env.COMPANION_VAPID_SUBJECT?.trim() || "mailto:companion@localhost"
  const data: VapidKeys = { ...keys, subject }
  writeFileSync(VAPID_FILE, JSON.stringify(data, null, 2))
  chmodSync(VAPID_FILE, 0o600)
  return data
}

const vapid = loadOrCreateVapid()
webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)

export function getVapidPublicKey(): string {
  return vapid.publicKey
}

// ── Subscription store ────────────────────────────────────────────────────

type StoredSubscription = {
  id: string
  subscription: PushSubscription
  userAgent?: string
  createdAt: string
}

let subscriptions: StoredSubscription[] = []

function loadSubs(): void {
  if (!existsSync(SUBS_FILE)) {
    subscriptions = []
    return
  }
  try {
    subscriptions = JSON.parse(readFileSync(SUBS_FILE, "utf8")) as StoredSubscription[]
  } catch {
    subscriptions = []
  }
}

function saveSubs(): void {
  ensureDir()
  writeFileSync(SUBS_FILE, JSON.stringify(subscriptions, null, 2))
  chmodSync(SUBS_FILE, 0o600)
}

loadSubs()

export function addSubscription(
  subscription: PushSubscription,
  userAgent?: string,
): StoredSubscription {
  // Dedup by endpoint — same device subscribing twice
  const existing = subscriptions.find(s => s.subscription.endpoint === subscription.endpoint)
  if (existing) {
    existing.subscription = subscription
    existing.userAgent = userAgent
    saveSubs()
    return existing
  }
  const entry: StoredSubscription = {
    id: crypto.randomUUID(),
    subscription,
    userAgent,
    createdAt: new Date().toISOString(),
  }
  subscriptions.push(entry)
  saveSubs()
  return entry
}

export function removeSubscription(endpoint: string): boolean {
  const before = subscriptions.length
  subscriptions = subscriptions.filter(s => s.subscription.endpoint !== endpoint)
  if (subscriptions.length !== before) {
    saveSubs()
    return true
  }
  return false
}

export function subscriptionCount(): number {
  return subscriptions.length
}

export function listSubscriptions(): Array<{ id: string; userAgent?: string; createdAt: string }> {
  return subscriptions.map(s => ({ id: s.id, userAgent: s.userAgent, createdAt: s.createdAt }))
}

// ── Send ──────────────────────────────────────────────────────────────────

export type WebPushEvent = "approval" | "permission" | "waiting"

export interface WebPushPayload {
  event: WebPushEvent
  title: string
  body: string
  tag?: string
  url?: string
  requireInteraction?: boolean
}

export async function sendWebPush(payload: WebPushPayload): Promise<{ sent: number; removed: number }> {
  if (subscriptions.length === 0) return { sent: 0, removed: 0 }

  const message = JSON.stringify(payload)
  const deadEndpoints: string[] = []
  let sent = 0

  await Promise.all(
    subscriptions.map(async s => {
      try {
        await webpush.sendNotification(s.subscription, message, {
          TTL: payload.event === "approval" || payload.event === "permission" ? 300 : 60,
          urgency: payload.event === "waiting" ? "normal" : "high",
        })
        sent++
      } catch (e: unknown) {
        // 404/410 = subscription revoked on the device — prune silently
        const statusCode = (e as { statusCode?: number })?.statusCode
        if (statusCode === 404 || statusCode === 410) {
          deadEndpoints.push(s.subscription.endpoint)
        } else {
          process.stderr.write(
            `\x1b[2m[companion]\x1b[0m \x1b[31mweb-push error\x1b[0m ${statusCode ?? ""} ${
              e instanceof Error ? e.message : String(e)
            }\n`,
          )
        }
      }
    }),
  )

  for (const endpoint of deadEndpoints) removeSubscription(endpoint)

  return { sent, removed: deadEndpoints.length }
}

export function pushEnabled(): boolean {
  return subscriptions.length > 0
}

export function configSummary(): { publicKey: string; subs: number; subject: string } {
  return { publicKey: vapid.publicKey, subs: subscriptions.length, subject: vapid.subject }
}
