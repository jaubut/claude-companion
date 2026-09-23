// Image feed events carry a mediaId, never bytes. The bytes live behind
// GET /api/media/:id, which sits under the server's /api/* bearer gate — so an
// <img src> can't load it directly; fetch with the header, hand back a blob URL.

const TOKEN_KEY = "companion.token"

// The pairing token. A `?token=` on the page URL (the pairing link) wins and
// is persisted so later loads without it still authenticate.
// Injectable for tests; the browser defaults read the page URL + localStorage.
export function readAuthToken(
  search: string = typeof window === "undefined" ? "" : window.location.search,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof window === "undefined" ? null : window.localStorage,
): string {
  const fromUrl = new URLSearchParams(search).get("token")?.trim()
  if (fromUrl) {
    try { storage?.setItem(TOKEN_KEY, fromUrl) } catch { /* private mode: still usable this load */ }
    return fromUrl
  }
  try { return storage?.getItem(TOKEN_KEY) ?? "" } catch { return "" }
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
