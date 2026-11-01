import { describe, expect, test } from "bun:test"
import { READS_PER_HOUR, ReadLimiter, checkReadUrl, isAllowedHostUrl, isBlockedUrl, isLoginWallPath, pageKind } from "./web-read-policy"

// bin/web-read policy: the host allowlist, the blocked write paths, the rate limit.

describe("checkReadUrl — host allowlist", () => {
  for (const url of ["https://www.instagram.com/p/C1x2y3/", "https://instagram.com/reel/abc123/?igsh=x", "https://www.instagram.com/natgeo/"]) {
    test(`allows ${url}`, () => expect(checkReadUrl(url).ok).toBe(true))
  }
  for (const url of [
    "http://www.instagram.com/p/abc/", // not https
    "https://www.tiktok.com/@x/video/1",
    "https://instagram.com.evil.example/p/abc/",
    "https://evilinstagram.com/p/abc/",
    "https://user:pw@www.instagram.com/p/abc/",
    "https://www.instagram.com:8443/p/abc/",
    "https://scontent.cdninstagram.com/v/t51/x.jpg", // CDN is media, not a page
    "file:///etc/passwd",
  ]) {
    test(`refuses ${url}`, () => expect(checkReadUrl(url)).toEqual({ ok: false, error: "url_not_allowed" }))
  }
  test("bad input", () => {
    for (const v of [undefined, 42, "", "not a url", "x".repeat(2_001)]) expect(checkReadUrl(v)).toEqual({ ok: false, error: "bad_url" })
  })
  test("drops the fragment", () => expect(checkReadUrl("https://www.instagram.com/p/abc/#x")).toEqual({ ok: true, url: "https://www.instagram.com/p/abc/" }))
})

describe("blocked URL patterns (write paths never reached)", () => {
  for (const url of [
    "https://www.instagram.com/direct/inbox/",
    "https://www.instagram.com/direct/t/123/",
    "https://www.instagram.com/create/select/",
    "https://www.instagram.com/stories/natgeo/123/",
    "https://www.instagram.com/accounts/edit/",
    "https://www.instagram.com/accounts/logout/",
    "https://www.instagram.com/web/friendships/123/follow/",
    "https://www.instagram.com/web/likes/123/like/",
    "https://www.instagram.com/api/v1/friendships/create/123/",
    "https://www.instagram.com/api/v1/media/123_456/like/",
    "https://www.instagram.com/api/v1/web/comments/123/add/",
  ]) {
    test(`blocks ${url}`, () => {
      expect(isBlockedUrl(url)).toBe(true)
      expect(checkReadUrl(url)).toEqual({ ok: false, error: "url_blocked" })
    })
  }
  test("reading paths are not blocked", () => {
    for (const url of ["https://www.instagram.com/p/abc/", "https://www.instagram.com/reel/abc/", "https://www.instagram.com/natgeo/"]) expect(isBlockedUrl(url)).toBe(false)
  })
})

describe("media hosts", () => {
  test("CDN allowed for media, others not", () => {
    expect(isAllowedHostUrl("https://scontent-yyz1-1.cdninstagram.com/o1/v/t16/f2/m86/x.mp4?efg=1")).toBe(true)
    expect(isAllowedHostUrl("https://video.xx.fbcdn.net/v/x.mp4")).toBe(true)
    expect(isAllowedHostUrl("https://127.0.0.1/x.mp4")).toBe(false)
    expect(isAllowedHostUrl("http://scontent.cdninstagram.com/x.mp4")).toBe(false)
  })
})

describe("pageKind / login wall", () => {
  test("kinds", () => {
    expect(pageKind("https://www.instagram.com/reel/abc/")).toBe("reel")
    expect(pageKind("https://www.instagram.com/p/abc/")).toBe("post")
    expect(pageKind("https://www.instagram.com/natgeo/p/abc/")).toBe("post")
    expect(pageKind("https://www.instagram.com/natgeo/")).toBe("profile")
    expect(pageKind("https://www.instagram.com/explore/")).toBe("page")
  })
  test("login wall paths", () => {
    expect(isLoginWallPath("/accounts/login/")).toBe(true)
    expect(isLoginWallPath("/challenge/abc/")).toBe(true)
    expect(isLoginWallPath("/p/abc/")).toBe(false)
  })
})

describe("ReadLimiter", () => {
  test(`${READS_PER_HOUR} an hour, sliding`, () => {
    const l = new ReadLimiter()
    const t0 = 1_000_000
    for (let i = 0; i < READS_PER_HOUR; i++) expect(l.take(t0 + i * 1_000).ok).toBe(true)
    const refused = l.take(t0 + 30 * 60_000)
    expect(refused).toEqual({ ok: false, retryAfterSec: 30 * 60 })
    expect(l.take(t0 + 60 * 60_000).ok).toBe(true)
  })
})
