import { createHash } from "node:crypto"
import type { ApnsPayload } from "./apns"

// POST /api/body/alert — pure parts: validation, the push-ownership rule, the
// APNs payload and the per-component push gate (rate limit + coalesce + the
// once-a-day "Body report"). Side effects (turn, WS, push) are wired in
// wiring/body.ts. Contract: docs/body-api.md.

export type Severity = "critical" | "warning" | "info"
const SEVERITIES: readonly Severity[] = ["critical", "warning", "info"]

export interface BodyAlert {
  component_id: string
  severity: Severity
  title: string
  message: string
  state: string | null
  from_state: string | null
}

export const PUSH_WINDOW_MS = 15 * 60_000
export const PUSH_BODY_MAX = 180
const TITLE_MAX = 200
const MESSAGE_MAX = 4000
const ID_MAX = 200
const STATE_MAX = 32
const DAILY_REPORT = /^body report\b/i

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

/** Parsed alert, or an error string for the 400. */
export function validateAlert(raw: unknown): BodyAlert | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be a JSON object" }
  const o = raw as Record<string, unknown>
  const component_id = str(o.component_id, ID_MAX)
  if (!component_id) return { error: "component_id required" }
  if (!SEVERITIES.includes(o.severity as Severity)) return { error: "severity must be critical|warning|info" }
  const title = str(o.title, TITLE_MAX)
  if (!title) return { error: "title required" }
  const message = str(o.message, MESSAGE_MAX)
  if (!message) return { error: "message required" }
  for (const k of ["state", "from_state"] as const) {
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== "string") return { error: `${k} must be a string` }
  }
  return {
    component_id, severity: o.severity as Severity, title, message,
    state: str(o.state, STATE_MAX), from_state: str(o.from_state, STATE_MAX),
  }
}

// ── Who pushes ──────────────────────────────────────────────────────────────
// Each host's collector posts to its own server, and in forward mode the Mac
// still handles this endpoint locally. To never double-fire, a server pushes
// only when it has an APNs sender AND owns the component: `mac:*` → the Mac
// server, every other prefix (`zettlab:*`, `cloud:*`, …) → the Zettlab server.
// An id with no `host:` prefix belongs to whichever server received it.

export type BodyHost = "mac" | "zettlab"

/** This server's identity: COMPANION_BODY_HOST, else darwin → mac, else zettlab. */
export function selfBodyHost(env: Record<string, string | undefined> = process.env, platform: string = process.platform): BodyHost {
  const raw = env.COMPANION_BODY_HOST?.trim().toLowerCase()
  if (raw === "mac" || raw === "zettlab") return raw
  return platform === "darwin" ? "mac" : "zettlab"
}

export function componentOwner(componentId: string, self: BodyHost): BodyHost {
  const i = componentId.indexOf(":")
  if (i <= 0) return self
  return componentId.slice(0, i).toLowerCase() === "mac" ? "mac" : "zettlab"
}

export function ownsPush(componentId: string, self: BodyHost, senderConfigured: boolean): boolean {
  return senderConfigured && componentOwner(componentId, self) === self
}

// ── Payload ─────────────────────────────────────────────────────────────────

export function clampChars(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, " ").trim()]
  return chars.length <= max ? chars.join("") : chars.slice(0, max - 1).join("").trimEnd() + "…"
}

/** `body-<id>`, or `body-<sha256 prefix>` when that exceeds APNs' 64 bytes. */
export function collapseIdFor(componentId: string): string {
  const id = `body-${componentId}`
  if (Buffer.byteLength(id) <= 64) return id
  return `body-${createHash("sha256").update(componentId).digest("hex").slice(0, 40)}`
}

export function isDailyReport(a: BodyAlert): boolean {
  return a.severity === "info" && DAILY_REPORT.test(a.title)
}

export function alertPushPayload(a: BodyAlert, coalesced = 0): ApnsPayload {
  const extra = coalesced > 0 ? ` (+${coalesced} more in 15 min)` : ""
  const level = a.severity === "critical" ? "time-sensitive" : a.severity === "warning" ? "active" : "passive"
  return {
    title: clampChars(a.title, 120),
    body: clampChars(clampChars(a.message, PUSH_BODY_MAX - extra.length) + extra, PUSH_BODY_MAX),
    category: "body_alert",
    threadId: "body",
    collapseId: isDailyReport(a) ? "body-report" : collapseIdFor(a.component_id),
    interruptionLevel: level,
    userInfo: { kind: "body_alert", component_id: a.component_id },
  }
}

// ── Push gate ───────────────────────────────────────────────────────────────
// critical/warning: at most one push per component per 15 min. Alerts inside
// the window are coalesced: at the window's end ONE trailing push carries the
// worst (then latest) of them plus the count. An `info` alert reporting the
// component back to `ok` drops a pending trailing push (it recovered).
// info: never pushes, except a "Body report…" title, once per local day.

export interface PushGateDeps {
  push: (payload: ApnsPayload) => void
  now?: () => number
  /** Test seam for the trailing-push timer. */
  schedule?: (fn: () => void, ms: number) => void
  windowMs?: number
}

export interface PushGate {
  /** true when this alert pushed immediately. */
  offer(a: BodyAlert): boolean
}

const RANK: Record<Severity, number> = { critical: 2, warning: 1, info: 0 }

function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function defaultSchedule(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms)
  ;(t as unknown as { unref?: () => void }).unref?.()
}

export function createPushGate(deps: PushGateDeps): PushGate {
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? defaultSchedule
  const windowMs = deps.windowMs ?? PUSH_WINDOW_MS
  const slots = new Map<string, { lastAt: number; pending: BodyAlert | null; count: number; armed: boolean }>()
  let reportDay = ""

  function flush(id: string): void {
    const s = slots.get(id)
    if (!s) return
    s.armed = false
    if (!s.pending || s.count === 0) return
    deps.push(alertPushPayload(s.pending, s.count - 1))
    slots.set(id, { lastAt: now(), pending: null, count: 0, armed: false })
  }

  return {
    offer(a) {
      if (a.severity === "info") {
        if (a.state === "ok") {
          const s = slots.get(a.component_id)
          if (s) { s.pending = null; s.count = 0 }
        }
        if (!isDailyReport(a) || reportDay === localDay(now())) return false
        reportDay = localDay(now())
        deps.push(alertPushPayload(a))
        return true
      }
      const s = slots.get(a.component_id)
      if (!s || now() - s.lastAt >= windowMs) {
        deps.push(alertPushPayload(a))
        slots.set(a.component_id, { lastAt: now(), pending: null, count: 0, armed: false })
        return true
      }
      if (!s.pending || RANK[a.severity] >= RANK[s.pending.severity]) s.pending = a
      s.count++
      if (!s.armed) {
        s.armed = true
        schedule(() => flush(a.component_id), Math.max(0, s.lastAt + windowMs - now()))
      }
      return false
    },
  }
}
