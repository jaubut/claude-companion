/**
 * Client-side Web Push helpers. All paths assume the service worker ships at /sw.js
 * and the server exposes /api/push/* endpoints.
 */

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export function isPushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" })
  } catch (e) {
    console.warn("SW registration failed", e)
    return null
  }
}

export async function getSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.ready
  return reg.pushManager.getSubscription()
}

export async function enablePush(): Promise<{ ok: boolean; reason?: string }> {
  if (!isPushSupported()) return { ok: false, reason: "Push not supported in this browser" }

  // On iOS, permission prompt is only allowed when running as an installed PWA.
  const isStandalone =
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    (window.navigator as { standalone?: boolean }).standalone === true
  const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent)
  if (isIos && !isStandalone) {
    return {
      ok: false,
      reason: "On iOS, add to Home Screen first (Safari → Share → Add to Home Screen), then open from there.",
    }
  }

  const permission = await Notification.requestPermission()
  if (permission !== "granted") return { ok: false, reason: `Notification permission ${permission}` }

  const reg = await navigator.serviceWorker.ready

  // Already subscribed? Make sure the server has us on file.
  let sub = await reg.pushManager.getSubscription()

  if (!sub) {
    const keyRes = await fetch("/api/push/vapid-key")
    if (!keyRes.ok) return { ok: false, reason: "Could not fetch VAPID key" }
    const { publicKey } = (await keyRes.json()) as { publicKey: string }
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    })
  }

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  })
  if (!res.ok) return { ok: false, reason: `Server subscribe failed: ${res.status}` }

  return { ok: true }
}

export async function disablePush(): Promise<{ ok: boolean }> {
  if (!isPushSupported()) return { ok: true }
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return { ok: true }
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {
    /* ignore network errors — the server can't help if we can't reach it */
  })
  await sub.unsubscribe()
  return { ok: true }
}

export async function testPush(): Promise<boolean> {
  try {
    const res = await fetch("/api/push/test", { method: "POST" })
    return res.ok
  } catch {
    return false
  }
}
