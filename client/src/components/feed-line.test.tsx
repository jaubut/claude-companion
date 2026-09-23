import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { FeedLine } from "@/components/feed-line"
import type { FeedEvent } from "@/hooks/use-companion"
import { fetchMedia, readAuthToken } from "@/lib/media"

const noop = (): void => {}
const render = (ev: FeedEvent): string =>
  renderToStaticMarkup(<FeedLine ev={ev} sessions={[]} onPickKey={noop} />)

// Typed as FeedEvent: tests are part of tsconfig.app.json, so `tsc` fails if
// the widened kind/fields regress.
const image: FeedEvent = {
  id: "e1",
  ts: 0,
  kind: "image",
  mediaId: "0123456789abcdef0123456789abcdef",
  width: 800,
  height: 600,
  caption: "screenshot of the build",
  tool: "Read",
}

describe("FeedLine image", () => {
  test("renders caption + a placeholder sized from width/height", () => {
    const html = render(image)
    expect(html).toContain("<figcaption")
    expect(html).toContain("screenshot of the build")
    expect(html).toContain('data-media-state="loading"')
    expect(html).toContain("aspect-ratio:800 / 600")
  })

  test("no caption → no figcaption", () => {
    expect(render({ ...image, caption: undefined })).not.toContain("<figcaption")
  })

  test("image without mediaId renders nothing", () => {
    expect(render({ ...image, mediaId: undefined })).toBe("")
  })

  test("artifact / assistant_thinking still render nothing", () => {
    expect(render({ id: "a", ts: 0, kind: "artifact" })).toBe("")
    expect(render({ id: "t", ts: 0, kind: "assistant_thinking", text: "hmm" })).toBe("")
  })
})

describe("fetchMedia", () => {
  const blobUrl = (): string => "blob:x"

  test("sends the bearer header and returns a blob URL", async () => {
    let seen: { url: string; auth: string | null } = { url: "", auth: null }
    const fake = (async (url: string, init?: RequestInit) => {
      seen = { url, auth: new Headers(init?.headers).get("authorization") }
      return new Response("jpeg", { status: 200 })
    }) as unknown as typeof fetch
    const r = await fetchMedia(image.mediaId!, "tok", fake, blobUrl)
    expect(r).toEqual({ status: "ok", url: "blob:x" })
    expect(seen).toEqual({ url: `/api/media/${image.mediaId}`, auth: "Bearer tok" })
  })

  test("404 → expired, other non-2xx → error, throw → error", async () => {
    const status = (s: number) => (async () => new Response(null, { status: s })) as unknown as typeof fetch
    expect(await fetchMedia("id", "t", status(404), blobUrl)).toEqual({ status: "expired" })
    expect(await fetchMedia("id", "t", status(401), blobUrl)).toEqual({ status: "error", message: "HTTP 401" })
    const boom = (async () => { throw new Error("offline") }) as unknown as typeof fetch
    expect(await fetchMedia("id", "t", boom, blobUrl)).toEqual({ status: "error", message: "offline" })
  })
})

describe("readAuthToken", () => {
  const mem = (): Pick<Storage, "getItem" | "setItem"> & { m: Map<string, string> } => {
    const m = new Map<string, string>()
    return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) } }
  }
  test("the pairing link's ?token= wins and is remembered", () => {
    const store = mem()
    expect(readAuthToken("?token=abc123", store)).toBe("abc123")
    expect(store.m.get("companion.token")).toBe("abc123")
    expect(readAuthToken("", store)).toBe("abc123")
  })
  test("nothing paired → empty, and a throwing storage is survived", () => {
    expect(readAuthToken("", mem())).toBe("")
    const broken = { getItem: () => { throw new Error("private") }, setItem: () => { throw new Error("private") } }
    expect(readAuthToken("?token=x", broken)).toBe("x")
    expect(readAuthToken("", broken)).toBe("")
  })
})
