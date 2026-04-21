/**
 * Push notifications via ntfy.sh (or a self-hosted ntfy instance).
 *
 * Opt-in via env var. If unset, push is silently disabled.
 *
 *   COMPANION_NTFY_TOPIC   — full URL, e.g. https://ntfy.sh/claude-companion-abc123
 *                            OR just the topic slug — we default the host to ntfy.sh
 *   COMPANION_NTFY_TOKEN   — optional bearer for self-hosted auth
 *   COMPANION_URL          — URL used as the tap-target (default http://<LAN IP>:4245)
 */

type PushEvent = "approval" | "waiting" | "permission"

export interface PushOptions {
  title: string
  body: string
  event: PushEvent
  tool?: string
  clickUrl?: string
}

function resolveHost(): { host: string; topic: string } | null {
  const raw = process.env.COMPANION_NTFY_TOPIC?.trim()
  if (!raw) return null
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const u = new URL(raw)
    const topic = u.pathname.replace(/^\/+|\/+$/g, "")
    if (!topic) return null
    return { host: `${u.protocol}//${u.host}`, topic }
  }
  return { host: "https://ntfy.sh", topic: raw }
}

const PRIORITY_BY_EVENT: Record<PushEvent, number> = {
  approval: 5,   // max — buzz through silent mode
  permission: 5,
  waiting: 3,    // default
}

const TAG_BY_EVENT: Record<PushEvent, string[]> = {
  approval: ["warning"],
  permission: ["key"],
  waiting: ["hourglass_flowing_sand"],
}

let consecutiveFailures = 0

export async function pushNotification(opts: PushOptions): Promise<boolean> {
  const target = resolveHost()
  if (!target) return false

  // JSON body API — unlike header-based API, handles Unicode natively.
  const payload: Record<string, unknown> = {
    topic: target.topic,
    title: opts.title,
    message: opts.body,
    priority: PRIORITY_BY_EVENT[opts.event],
    tags: TAG_BY_EVENT[opts.event],
  }
  if (opts.clickUrl) payload.click = opts.clickUrl

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  const token = process.env.COMPANION_NTFY_TOKEN?.trim()
  if (token) headers.Authorization = `Bearer ${token}`

  try {
    const res = await fetch(target.host, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) {
      consecutiveFailures++
      if (consecutiveFailures <= 3) {
        process.stderr.write(
          `\x1b[2m[companion]\x1b[0m \x1b[31mpush failed\x1b[0m ${res.status} ${await res.text()}\n`,
        )
      }
      return false
    }
    consecutiveFailures = 0
    return true
  } catch (e) {
    consecutiveFailures++
    if (consecutiveFailures <= 3) {
      process.stderr.write(
        `\x1b[2m[companion]\x1b[0m \x1b[31mpush error\x1b[0m ${e instanceof Error ? e.message : String(e)}\n`,
      )
    }
    return false
  }
}

export function pushEnabled(): boolean {
  return resolveHost() !== null
}

export function pushConfig(): { url: string; hasToken: boolean } | null {
  const target = resolveHost()
  if (!target) return null
  return { url: `${target.host}/${target.topic}`, hasToken: !!process.env.COMPANION_NTFY_TOKEN }
}
