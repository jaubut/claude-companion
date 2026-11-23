import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MAX_PAGE_IMAGES, extractPage, largestSrc } from "./link-media-extract"

// Fixtures: docs/fixtures/link-media/. The Pinterest one is trimmed from a real capture; the
// Dribbble and Behance ones are modeled on their CDN markup (both refuse plain HTTP).
const fixture = (name: string): string => readFileSync(join(import.meta.dir, "../../docs/fixtures/link-media", `${name}.html`), "utf8")

describe("bin/media page extractor", () => {
  test("Pinterest pin: only the closeup image, upgraded to the original from the page JSON, 736x as fallback", () => {
    const out = extractPage(fixture("pinterest-pin"), new URL("https://ca.pinterest.com/pin/342555115431838113/"))
    expect(out.images).toEqual([[
      "https://i.pinimg.com/originals/c0/c3/53/c0c353f04fca2c2aca59a1b088e672bd.png",
      "https://i.pinimg.com/736x/c0/c3/53/c0c353f04fca2c2aca59a1b088e672bd.jpg",
    ]])
    expect(out.title).toBe("Webpage animation | Web design for projects, Cool design on a website, Login page ui ux")
    expect(out.description).toStartWith('A login page for "Where Knowledge Comes Alive,"')
  })

  test("Pinterest pin without the closeup marker falls back to og:image", () => {
    const html = fixture("pinterest-pin").replace(/elementtiming="closeup-image-main[^"]*"/, "")
    const out = extractPage(html, new URL("https://www.pinterest.com/pin/1/"))
    expect(out.images[0]![0]).toBe("https://i.pinimg.com/originals/c0/c3/53/c0c353f04fca2c2aca59a1b088e672bd.png")
  })

  test("Dribbble shot: every shot attachment at original size; avatar, hidden and 'more by' thumbnails dropped", () => {
    const out = extractPage(fixture("dribbble-shot"), new URL("https://dribbble.com/shots/27460154-Dashboard"))
    expect(out.images.map((c) => c[0])).toEqual([
      "https://cdn.dribbble.com/userupload/45001001/file/main-a1b2c3.png",
      "https://cdn.dribbble.com/userupload/45001002/file/detail-d4e5f6.png",
      "https://cdn.dribbble.com/userupload/45001003/file/mobile-0a9b8c.jpg",
    ])
    // The size the page showed stays as a fallback candidate.
    expect(out.images[0]).toContain("https://cdn.dribbble.com/userupload/45001001/file/main-a1b2c3.png?resize=1600x&vertical=center")
    expect(out.author).toBe("Seto")
  })

  test("Behance project: project modules only, largest srcset/<source> first", () => {
    const out = extractPage(fixture("behance-project"), new URL("https://www.behance.net/gallery/218164889/Brand-Identity"))
    expect(out.images.map((c) => c[0])).toEqual([
      "https://mir-s3-cdn-cf.behance.net/project_modules/max_3840/aaa111.png",
      "https://mir-s3-cdn-cf.behance.net/project_modules/2800_webp/bbb222.png",
      "https://mir-s3-cdn-cf.behance.net/project_modules/disp/ccc333.jpg",
      "https://mir-s3-cdn-cf.behance.net/project_modules/disp/ddd444.jpg",
    ])
    expect(out.images[1]).toContain("https://mir-s3-cdn-cf.behance.net/project_modules/max_1200/bbb222.png")
  })

  test("any page: the widest rendered images, og:image when none is large, never svg or data:", () => {
    const page = (imgs: string): string => `<html><head><meta property="og:image" content="/card.png"></head><body>${imgs}</body></html>`
    const base = new URL("https://studio.example/work")
    const big = extractPage(page('<img src="/hero.jpg" data-media-w="1200"><img src="/logo.svg" data-media-w="1200"><img src="/side.jpg" data-media-w="400"><img src="data:image/png;base64,AA" data-media-w="1200">'), base)
    expect(big.images).toEqual([["https://studio.example/hero.jpg"]])
    const small = extractPage(page('<img src="/icon.png" data-media-w="64">'), base)
    expect(small.images).toEqual([["https://studio.example/card.png"]])
  })

  test("caps at 12 images", () => {
    const imgs = Array.from({ length: 20 }, (_, i) => `<img src="/s${i}.jpg" data-media-w="1000">`).join("")
    expect(extractPage(`<body>${imgs}</body>`, new URL("https://a.example/")).images).toHaveLength(MAX_PAGE_IMAGES)
  })

  test("srcset: biggest descriptor wins, commas inside URLs survive", () => {
    expect(largestSrc("a.jpg 320w, b.jpg 1600w, c.jpg 800w")).toBe("b.jpg")
    expect(largestSrc("https://x/w_400,h_300/a.jpg 1x,https://x/w_800,h_600/a.jpg 2x")).toBe("https://x/w_800,h_600/a.jpg")
    expect(largestSrc("")).toBeNull()
  })
})
