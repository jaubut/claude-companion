// Image feed events carry a mediaId, never bytes. The bytes live behind
// GET /api/media/:id, which sits under the server's /api/* bearer gate — so an
// <img src> can't load it directly; fetch with the header, hand back a blob URL.

const TOKEN_KEY = "companion.token"

// The pairing token. A `?token=` on the page URL (the pairing link) wins and
// is persisted so later loads without it still authenticate.
export function readAuthToken(): string {
  if (typeof window === "undefined") return ""
  const fromUrl = new URLSearchParams(window.location.search).get("token")?.trim()
  if (fromUrl) {
    window.localStorage.setItem(TOKEN_KEY, fromUrl)
    return fromUrl
  }
  return window.localStorage.getItem(TOKEN_KEY) ?? ""
}

export type MediaResult =
  | { status: "ok"; url: string }
  | { status: "expired" }
  | { status: "error"; message: string }

export async function fetchMedia(
  mediaId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  toUrl: (blob: Blob) => string = URL.createObjectURL,
): Promise<MediaResult> {
  try {
    const res = await fetchImpl(`/api/media/${encodeURIComponent(mediaId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (res.status === 404) return { status: "expired" }
    if (!res.ok) return { status: "error", message: `HTTP ${res.status}` }
    return { status: "ok", url: toUrl(await res.blob()) }
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) }
  }
}
