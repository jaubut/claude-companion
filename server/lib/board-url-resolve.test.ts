import { describe, expect, test } from "bun:test"
import { extractGenericPageImages, extractPinterestImages, parsePublicHttpUrl, resolveBoardUrl, upgradePinimgUrl } from "./board-url-resolve"

describe("board-url-resolve", () => {
  test("blocks private/loopback/tailnet URLs and non-http schemes", () => {
    expect(parsePublicHttpUrl("http://127.0.0.1:4245/api/status")).toBeNull()
    expect(parsePublicHttpUrl("http://localhost:3000/foo")).toBeNull()
    expect(parsePublicHttpUrl("http://192.168.1.5/img.png")).toBeNull()
    expect(parsePublicHttpUrl("https://zettlab.tailfc45f2.ts.net/foo")).toBeNull()
    expect(parsePublicHttpUrl("file:///etc/passwd")).toBeNull()
    expect(parsePublicHttpUrl("https://www.pinterest.com/pin/123456/")?.hostname).toBe("www.pinterest.com")
  })

  test("upgrades smaller pinimg thumbnails to 736x", () => {
    expect(upgradePinimgUrl("https://i.pinimg.com/236x/aa/bb/cc/deadbeef.jpg")).toBe(
      "https://i.pinimg.com/736x/aa/bb/cc/deadbeef.jpg",
    )
    expect(upgradePinimgUrl("https://i.pinimg.com/originals/aa/bb/cc/deadbeef.jpg")).toBe(
      "https://i.pinimg.com/originals/aa/bb/cc/deadbeef.jpg",
    )
  })

  test("extracts single pin image from og:image and board images deduped by hash", () => {
    const pinHtml = `<html><head><meta property="og:title" content="Minimal Chair | Pinterest"><meta property="og:image" content="https://i.pinimg.com/474x/11/22/33/pin1.jpg"></head></html>`
    const pin = extractPinterestImages(pinHtml, new URL("https://www.pinterest.com/pin/987654321/"))
    expect(pin).toEqual({
      kind: "pin",
      title: "Minimal Chair",
      urls: ["https://i.pinimg.com/736x/11/22/33/pin1.jpg"],
    })

    const boardHtml = `
      <meta property="og:title" content="UI Inspiration | Pinterest">
      <img src="https://i.pinimg.com/236x/aa/bb/cc/aaa111.jpg">
      <img src="https://i.pinimg.com/736x/aa/bb/cc/aaa111.jpg">
      <img src="https://i.pinimg.com/474x/dd/ee/ff/bbb222.png">
    `
    const board = extractPinterestImages(boardHtml, new URL("https://www.pinterest.com/jaubut/ui-inspiration/"))
    expect(board.kind).toBe("board")
    expect(board.title).toBe("UI Inspiration")
    expect(board.urls).toEqual([
      "https://i.pinimg.com/736x/aa/bb/cc/aaa111.jpg",
      "https://i.pinimg.com/736x/dd/ee/ff/bbb222.png",
    ])
  })

  test("resolveBoardUrl downloads and saves Pinterest pin image into board assets", async () => {
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const mockFetch = (async (input: string | URL) => {
      const u = String(input)
      if (u.includes("pinterest.com/pin/")) {
        return new Response(
          `<meta property="og:title" content="Nordic Lamp | Pinterest"><meta property="og:image" content="https://i.pinimg.com/736x/11/22/33/lamp.png">`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        )
      }
      return new Response(fakePng, { status: 200, headers: { "Content-Type": "image/png" } })
    }) as unknown as typeof fetch

    const out = await resolveBoardUrl("https://www.pinterest.com/pin/123456/", {
      fetch: mockFetch,
      save: () => ({ ok: true, src: "/api/board/assets/abc123.png", path: "/tmp/abc123.png", file: "abc123.png", mime: "image/png" }),
      probeSize: async () => ({ w: 736, h: 920 }),
    })

    expect(out).toEqual({
      ok: true,
      kind: "pin",
      title: "Nordic Lamp",
      sourceUrl: "https://www.pinterest.com/pin/123456/",
      images: [{ src: "/api/board/assets/abc123.png", w: 736, h: 920, mime: "image/png" }],
    })
  })

  test("extractGenericPageImages resolves relative OG/Twitter/img URLs for any site", () => {
    const html = `
      <html><head>
        <title>Linear — Method</title>
        <meta property="og:image" content="/assets/og-hero.png">
        <meta name="twitter:image" content="https://cdn.linear.app/card.webp">
      </head><body>
        <img src="/icons/favicon.svg">
        <img src="/media/product.jpg">
      </body></html>
    `
    const out = extractGenericPageImages(html, new URL("https://linear.app/method"))
    expect(out).toEqual({
      kind: "image",
      title: "Linear — Method",
      urls: [
        "https://linear.app/assets/og-hero.png",
        "https://cdn.linear.app/card.webp",
        "https://linear.app/media/product.jpg",
      ],
    })
  })

  test("resolveBoardUrl captures full-page screenshot for non-Pinterest web URLs", async () => {
    const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const mockFetch = (async () =>
      new Response("<html><head><title>Linear</title></head></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as unknown as typeof fetch

    const out = await resolveBoardUrl("https://linear.app/method", {
      fetch: mockFetch,
      capturePage: async () => ({
        bytes: fakeJpeg,
        mime: "image/jpeg",
        title: "Linear Method",
        finalUrl: "https://linear.app/method",
      }),
      save: () => ({ ok: true, src: "/api/board/assets/page123.jpg", path: "/tmp/page123.jpg", file: "page123.jpg", mime: "image/jpeg" }),
      probeSize: async () => ({ w: 1440, h: 4800 }),
    })

    expect(out).toEqual({
      ok: true,
      kind: "page",
      title: "Linear Method",
      sourceUrl: "https://linear.app/method",
      images: [{ src: "/api/board/assets/page123.jpg", w: 1440, h: 4800, mime: "image/jpeg" }],
    })
  })
})
