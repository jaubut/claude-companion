// Idempotency-Key for the phone's retrying POSTs (/api/inject, /api/answer).
// The iOS outbox persists a send and retries it after an app kill, so a
// request that was delivered but never dequeued arrives twice. The first
// request with a key runs; a repeat within TTL_MS replays its status + body
// with `Idempotent-Replayed: true`; a repeat while the first is in flight
// shares its promise. 5xx and throws are forgotten so a real failure retries.
// No header → the handler runs exactly as before.
//
// ponytail: in-memory, lost on server restart; move to disk if that ever matters.

export const TTL_MS = 24 * 60 * 60 * 1000
export const MAX_KEY_LENGTH = 128

interface Remembered { status: number; body: string; contentType: string | null }
interface Entry { result: Promise<Remembered>; expires: number }

const entries = new Map<string, Entry>()

function evictExpired(now: number): void {
  for (const [k, e] of entries) if (e.expires <= now) entries.delete(k)
}

function toResponse(r: Remembered, replayed: boolean): Response {
  const headers = new Headers()
  if (r.contentType) headers.set("content-type", r.contentType)
  if (replayed) headers.set("Idempotent-Replayed", "true")
  return new Response(r.body, { status: r.status, headers })
}

/** Run `handler` at most once per (scope, Idempotency-Key) within TTL_MS. */
export async function withIdempotency(
  req: Request,
  scope: string,
  handler: () => Promise<Response>,
  now: () => number = Date.now,
): Promise<Response> {
  const key = req.headers.get("idempotency-key")
  if (!key) return handler()
  if (key.length > MAX_KEY_LENGTH) {
    return Response.json({ ok: false, error: "idempotency-key-too-long" }, { status: 400 })
  }

  const id = `${scope}\n${key}`
  const t = now()
  evictExpired(t)
  const hit = entries.get(id)
  if (hit) return toResponse(await hit.result, true)

  // Set synchronously, before any await, so a concurrent repeat finds it.
  const result = (async (): Promise<Remembered> => {
    const res = await handler()
    return { status: res.status, body: await res.text(), contentType: res.headers.get("content-type") }
  })()
  const entry: Entry = { result, expires: t + TTL_MS }
  entries.set(id, entry)

  let r: Remembered
  try {
    r = await result
  } catch (err) {
    if (entries.get(id) === entry) entries.delete(id)
    throw err
  }
  if (r.status >= 500 && entries.get(id) === entry) entries.delete(id)
  return toResponse(r, false)
}

/** Test seam: forget every remembered key. */
export function resetIdempotency(): void {
  entries.clear()
}
