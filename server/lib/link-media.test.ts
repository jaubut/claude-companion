import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  LOCAL_INPUT,
  MediaError,
  VIDEO_FORMAT,
  analyseVideoOrPage,
  asImage,
  beforeDeadline,
  build,
  cleanVideoFiles,
  imageTitle,
  isSafeMediaInfo,
  jsonOrNull,
  pickCaptionUrl,
  readCappedUtf8,
  run,
  shouldFallbackToPage,
  ytArgs,
} from "./link-media"
import {
  CHALLENGED_ERR,
  CHROMIUM_ARGS,
  CHROMIUM_NO_SANDBOX_ARGS,
  CHROMIUM_PROXY_BYPASS,
  OVER,
  allowPageRequest,
  fetchFirst,
  installRouteGuard,
  launchChromium,
  loadPage,
} from "./link-media-browser"

describe("bin/media pipeline", () => {
  test("yt-dlp ignores host config and goes through the guard proxy", () => {
    const a = ytArgs("http://127.0.0.1:9")
    expect(a).toContain("--ignore-config")
    expect(a.slice(a.indexOf("--proxy"), a.indexOf("--proxy") + 2)).toEqual(["--proxy", "http://127.0.0.1:9"])
  })

  test("yt-dlp never runs ffprobe on the download, uses native HLS, and blocks ffmpeg_i network protocols", () => {
    const a = ytArgs("http://127.0.0.1:1")
    expect(a[a.indexOf("--fixup") + 1]).toBe("never")
    expect(a).toContain("--hls-prefer-native")
    expect(a[a.indexOf("--downloader-args") + 1]).toBe("ffmpeg_i:-protocol_whitelist crypto")
    expect(a.join(" ")).not.toMatch(/whitelist \S*(file|rtmp|http|tcp|tls)/)
  })

  test.skipIf(!Bun.which("ffprobe"))("the local ffmpeg refuses a playlist saved as video.*", async () => {
    const dir = mkdtempSync(join(tmpdir(), "media-local-"))
    const list = join(dir, "video.m3u8")
    writeFileSync(list, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/x.ts\n#EXT-X-ENDLIST\n")
    const r = await run(["ffprobe", "-v", "error", ...LOCAL_INPUT, list], Date.now() + 5_000)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("whitelist")
    rmSync(dir, { recursive: true, force: true })
  })

  test("every video format alternative is limited to native proxied protocols (no ffmpeg m3u8 or rtmp)", () => {
    for (const alt of VIDEO_FORMAT.split("/")) expect(alt).toEndWith("[protocol~='^(https?|m3u8_native|http_dash_segments)$']")
  })

  test("a hung step fails with 504 at the deadline instead of hanging the job", async () => {
    const t0 = Date.now()
    await expect(beforeDeadline(new Promise(() => {}), Date.now() + 50)).rejects.toMatchObject({ status: 504 })
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(await beforeDeadline(Promise.resolve(7), Date.now() + 50)).toBe(7)
  })

  test("a timed-out command takes its children down with it", async () => {
    const pidFile = join(tmpdir(), `media-run-${process.pid}-${Date.now()}`)
    await expect(run(["sh", "-c", `sleep 30 & echo $! > ${pidFile}; wait`], Date.now() + 300)).rejects.toMatchObject({ status: 504 })
    const child = Number(readFileSync(pidFile, "utf8"))
    let alive = true
    for (let i = 0; i < 20 && alive; i++) {
      try { process.kill(child, 0); await Bun.sleep(50) } catch { alive = false }
    }
    expect(alive).toBe(false)
    expect(existsSync(pidFile)).toBe(true)
  })

  test("image detection uses the GET's content type (no HEAD)", async () => {
    const img = new Response("x", { headers: { "content-type": "image/png" } })
    expect(await asImage(img)).toBe(img)
    expect(await asImage(new Response("<html>", { headers: { "content-type": "text/html" } }))).toBeNull()
    expect(await asImage(new Response("no", { status: 403, headers: { "content-type": "image/png" } }))).toBeNull()
    expect(await asImage(null)).toBeNull()
  })

  test("unreadable JSON is null, not a throw", () => {
    expect(jsonOrNull<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
    expect(jsonOrNull("")).toBeNull()
    expect(jsonOrNull('{"a":')).toBeNull()
    expect(jsonOrNull('"\\u12"')).toBeNull()
  })

  test("a malformed %-escape in the image name doesn't fail the job", () => {
    expect(imageTitle(new URL("https://8.8.8.8/a%E0.jpg"))).toBe("a%E0.jpg")
    expect(imageTitle(new URL("https://8.8.8.8/caf%C3%A9.jpg"))).toBe("café.jpg")
    expect(imageTitle(new URL("https://8.8.8.8/"))).toBeNull()
  })

  test("isSafeMediaInfo accepts http(s)/native-HLS/DASH (including merged https+https) and rejects ffmpeg-m3u8/rtmp/file/non-http URLs", () => {
    expect(isSafeMediaInfo({ url: "https://cdn.example.com/v.mp4", protocol: "https" })).toBe(true)
    expect(isSafeMediaInfo({ protocol: "https+https", formats: [{ url: "https://cdn.example.com/v.mp4", protocol: "https" }, { url: "https://cdn.example.com/a.m4a", protocol: "https" }] })).toBe(true)
    expect(isSafeMediaInfo({ formats: [{ url: "https://cdn.example.com/master.m3u8", protocol: "m3u8_native" }] })).toBe(true)
    expect(isSafeMediaInfo({ formats: [{ url: "https://cdn.example.com/master.m3u8", protocol: "m3u8" }] })).toBe(false)
    expect(isSafeMediaInfo({ protocol: "https+rtmp" })).toBe(false)
    expect(isSafeMediaInfo({ url: "rtmp://live.example.com/app/stream", protocol: "rtmp" })).toBe(false)
    expect(isSafeMediaInfo({ url: "file:///etc/passwd" })).toBe(false)
    expect(isSafeMediaInfo({ formats: [{ url: "rtmp://live.example.com/s", protocol: "rtmp" }] })).toBe(false)
  })

  test("pickCaptionUrl selects preferred safe vtt URL and readCappedUtf8 aborts when decompressed stream exceeds maxBytes", async () => {
    expect(pickCaptionUrl({
      language: "fr",
      subtitles: {
        en: [{ ext: "vtt", url: "https://cdn.example.com/en.vtt" }],
        "fr-CA": [{ ext: "srv3", url: "https://cdn.example.com/fr.srv3" }, { ext: "vtt", url: "https://cdn.example.com/fr.vtt" }],
      },
    })).toBe("https://cdn.example.com/fr.vtt")
    expect(pickCaptionUrl({
      automatic_captions: {
        en: [{ ext: "vtt", url: "file:///etc/passwd" }, { ext: "vtt", url: "https://cdn.example.com/auto-en.vtt", protocol: "m3u8" }],
      },
    })).toBeNull()

    const small = new Response("WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n")
    expect(await readCappedUtf8(small, 1024)).toContain("hello")

    let extraPolls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        extraPolls++
        controller.enqueue(new Uint8Array(600))
      },
    })
    expect(await readCappedUtf8(new Response(stream), 1000)).toBeNull()
    expect(extraPolls).toBe(2)
  })

  test("a timed-out attempt stages in an isolated temp dir and never clobbers a retry's cache dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "media-stage-"))
    const dir = join(root, "cache-item")
    const url = new URL("https://8.8.8.8/pic.jpg")
    let firstWorkDir = ""
    let firstSettled = false

    try {
      const first = await build(url, dir, {
        timeoutMs: 40,
        attempt: async (workDir) => {
          firstWorkDir = workDir
          await Bun.sleep(120)
          // Late write after timeout + after the retry has already committed `dir`
          if (existsSync(workDir)) writeFileSync(join(workDir, "image.jpg"), "stale-from-attempt-1")
          firstSettled = true
          return { kind: "image", frames: [join(workDir, "image.jpg")], contactSheet: null }
        },
      })
      expect(first.status).toBe(504)
      expect(existsSync(dir)).toBe(false)

      // Retry starts immediately while attempt 1 is still in flight
      const second = await build(url, dir, {
        timeoutMs: 1_000,
        attempt: async (workDir) => {
          expect(workDir).not.toBe(firstWorkDir)
          writeFileSync(join(workDir, "image.jpg"), "fresh-from-attempt-2")
          return { kind: "image", frames: [join(workDir, "image.jpg")], contactSheet: null }
        },
      })
      expect(second.status).toBe(200)
      expect(second.body.frames).toEqual([join(dir, "image.jpg")])

      // Wait for attempt 1's late background work to finish and run its cleanup
      await Bun.sleep(120)
      expect(firstSettled).toBe(true)
      expect(existsSync(firstWorkDir)).toBe(false)
      expect(readFileSync(join(dir, "image.jpg"), "utf8")).toBe("fresh-from-attempt-2")
      expect(existsSync(join(dir, "result.json"))).toBe(true)
      expect(readdirSync(root)).toEqual(["cache-item"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("shouldFallbackToPage refuses post-download 422s, video-only hosts, and bot/auth errors, while allowing Unsupported URL and design pages", () => {
    // Post-download errors never fall back
    expect(shouldFallbackToPage(new URL("https://dribbble.com/shots/1"), new MediaError(422, "unreadable video"))).toBe(false)
    expect(shouldFallbackToPage(new URL("https://dribbble.com/shots/1"), new MediaError(422, "no frames could be extracted"))).toBe(false)

    // Non-422 errors never fall back
    expect(shouldFallbackToPage(new URL("https://dribbble.com/shots/1"), new MediaError(502, "download failed"))).toBe(false)

    // Video-only platforms never fall back even on 422 fetchInfo errors
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.tiktok.com/@user/video/123",
      "https://vimeo.com/123456",
    ]) {
      expect(
        shouldFallbackToPage(
          new URL(u),
          new MediaError(422, "could not read this link: ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot"),
        ),
      ).toBe(false)
      expect(
        shouldFallbackToPage(new URL(u), new MediaError(422, "could not read this link: ERROR: Unsupported URL: " + u)),
      ).toBe(false)
    }

    // Instagram or generic video auth/rate-limit/unavailable errors never fall back
    expect(
      shouldFallbackToPage(
        new URL("https://www.instagram.com/reel/ABC123/"),
        new MediaError(422, "could not read this link: ERROR: [Instagram] ABC123: Requested content is not available, rate-limit reached or login required"),
      ),
    ).toBe(false)
    expect(
      shouldFallbackToPage(
        new URL("https://video.example.com/v/1"),
        new MediaError(422, "could not read this link: ERROR: Private video. Sign in if you've been granted access"),
      ),
    ).toBe(false)
    expect(
      shouldFallbackToPage(
        new URL("https://dribbble.com/shots/1"),
        new MediaError(422, "could not read this link: metadata over 10 MB"),
      ),
    ).toBe(false)

    // Design-reference pages and generic Unsupported URL / No video formats found DO fall back
    expect(
      shouldFallbackToPage(
        new URL("https://dribbble.com/shots/27460154-Dashboard"),
        new MediaError(422, "could not read this link: ERROR: Unsupported URL: https://dribbble.com/shots/27460154-Dashboard"),
      ),
    ).toBe(true)
    expect(
      shouldFallbackToPage(
        new URL("https://ca.pinterest.com/pin/342555115431838113/"),
        new MediaError(422, "could not read this link: ERROR: [Pinterest] 342555115431838113: No video formats found!"),
      ),
    ).toBe(true)
    expect(
      shouldFallbackToPage(
        new URL("https://www.behance.net/gallery/218164889/Brand-Identity"),
        new MediaError(422, "could not read this link: ERROR: [generic] Brand-Identity: Unable to download webpage: HTTP Error 403: Forbidden"),
      ),
    ).toBe(true)
    expect(
      shouldFallbackToPage(
        new URL("https://studio.example/work"),
        new MediaError(422, "could not read this link: ERROR: Unsupported URL: https://studio.example/work"),
      ),
    ).toBe(true)
  })

  test("analyseVideoOrPage cleans up leftover video.* files, skips fallback on post-download/video errors, and preserves 413/504 from analysePage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "media-fallback-"))
    try {
      // 1. Post-download probeDuration 422 cleans up video.* and does NOT call analysePage
      let pageCalled = false
      writeFileSync(join(dir, "video.mp4"), "leftover-bytes")
      await expect(
        analyseVideoOrPage(new URL("https://cdn.example.com/audio.mp4"), dir, Date.now() + 10_000, {
          video: async () => {
            throw new MediaError(422, "unreadable video")
          },
          page: async () => {
            pageCalled = true
            return { kind: "page" }
          },
        }),
      ).rejects.toMatchObject({ status: 422, reason: "unreadable video" })
      expect(pageCalled).toBe(false)
      expect(existsSync(join(dir, "video.mp4"))).toBe(false)

      // 2. Design page fallback sweeps leftover video.*, calls analysePage, and returns page result
      writeFileSync(join(dir, "video.webm"), "partial-video")
      writeFileSync(join(dir, "video.webm.part"), "partial-part")
      let filesSeenByPage: string[] = []
      const okOut = await analyseVideoOrPage(new URL("https://dribbble.com/shots/27460154"), dir, Date.now() + 10_000, {
        video: async () => {
          throw new MediaError(422, "could not read this link: ERROR: Unsupported URL: https://dribbble.com/shots/27460154")
        },
        page: async (_u, d) => {
          filesSeenByPage = readdirSync(d)
          return { kind: "page", frames: [] }
        },
      })
      expect(okOut.kind).toBe("page")
      expect(filesSeenByPage).toEqual([])

      // 3. Expired deadline before launching analysePage throws 504
      await expect(
        analyseVideoOrPage(new URL("https://dribbble.com/shots/27460154"), dir, Date.now() - 1, {
          video: async () => {
            throw new MediaError(422, "could not read this link: ERROR: Unsupported URL: https://dribbble.com/shots/27460154")
          },
          page: async () => ({ kind: "page" }),
        }),
      ).rejects.toMatchObject({ status: 504, reason: "media fetch timed out" })

      // 4. Quota OVER error from analysePage maps to 413 (not 422)
      await expect(
        analyseVideoOrPage(new URL("https://dribbble.com/shots/27460154"), dir, Date.now() + 10_000, {
          video: async () => {
            throw new MediaError(422, "could not read this link: ERROR: Unsupported URL: https://dribbble.com/shots/27460154")
          },
          page: async () => {
            throw new Error(OVER)
          },
        }),
      ).rejects.toMatchObject({ status: 413, reason: OVER })

      // 5. Timeout error from analysePage maps to 504 (not 422)
      await expect(
        analyseVideoOrPage(new URL("https://dribbble.com/shots/27460154"), dir, Date.now() + 10_000, {
          video: async () => {
            throw new MediaError(422, "could not read this link: ERROR: Unsupported URL: https://dribbble.com/shots/27460154")
          },
          page: async () => {
            throw new Error(" page.goto: Timeout 30000ms exceeded.")
          },
        }),
      ).rejects.toMatchObject({ status: 504 })

      // 6. cleanVideoFiles removes only video.* entries
      writeFileSync(join(dir, "video.mp4"), "v")
      writeFileSync(join(dir, "frame_01.jpg"), "f")
      cleanVideoFiles(dir)
      expect(readdirSync(dir)).toEqual(["frame_01.jpg"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("Chromium launch enforces proxy loopback bypass, host-resolver-rules, and tries sandbox first before falling back to --no-sandbox", async () => {
    expect(CHROMIUM_PROXY_BYPASS).toBe("<-loopback>")
    expect(CHROMIUM_ARGS).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1")
    expect(CHROMIUM_ARGS).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp")
    expect(CHROMIUM_ARGS).not.toContain("--no-sandbox")
    expect(CHROMIUM_ARGS).not.toContain("--disable-setuid-sandbox")

    // Succeeds on first attempt without --no-sandbox when host supports sandbox
    const calls1: Array<{ args?: string[]; proxy?: { server: string; bypass?: string } }> = []
    await launchChromium("/bin/chromium", "http://127.0.0.1:4321", Date.now() + 10_000, async (opts) => {
      calls1.push(opts as { args?: string[]; proxy?: { server: string; bypass?: string } })
      return {} as never
    })
    expect(calls1).toHaveLength(1)
    expect(calls1[0]!.proxy).toEqual({ server: "http://127.0.0.1:4321", bypass: "<-loopback>" })
    expect(calls1[0]!.args).toEqual(CHROMIUM_ARGS)

    // Falls back to adding --no-sandbox when first launch fails due to host sandbox restrictions
    const calls2: Array<{ args?: string[] }> = []
    await launchChromium("/bin/chromium", "http://127.0.0.1:4321", Date.now() + 10_000, async (opts) => {
      calls2.push(opts as { args?: string[] })
      if (calls2.length === 1) throw new Error("browserType.launch: FATAL:zygote_host_impl_linux.cc(127) No usable sandbox!")
      return {} as never
    })
    expect(calls2).toHaveLength(2)
    expect(calls2[0]!.args).not.toContain("--no-sandbox")
    expect(calls2[1]!.args).toEqual([...CHROMIUM_NO_SANDBOX_ARGS, ...CHROMIUM_ARGS])
  })

  test("Chromium route guard and fetchFirst allow public http(s)/data/blob and abort ws/file/loopback/private/IMDS URLs", async () => {
    const check = async (raw: string) => {
      try {
        const u = new URL(raw)
        if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false as const, reason: "scheme" }
        if (/^(localhost|.*\.localhost|127\.|169\.254\.|10\.|\[::1\]|\[fe80:)/.test(u.hostname)) {
          return { ok: false as const, reason: "private" }
        }
        return { ok: true as const, url: u }
      } catch {
        return { ok: false as const, reason: "invalid" }
      }
    }

    expect(await allowPageRequest("data:image/png;base64,AAAA", check)).toBe(true)
    expect(await allowPageRequest("blob:https://dribbble.com/123", check)).toBe(true)
    expect(await allowPageRequest("https://cdn.dribbble.com/userupload/1/file/a.png", check)).toBe(true)
    for (const blocked of [
      "ws://127.0.0.1:4245/ws",
      "wss://cdn.dribbble.com/ws",
      "file:///etc/passwd",
      "http://127.0.0.1:4245/hooks/brain/media",
      "http://localhost:4245/",
      "http://sub.localhost:4245/",
      "http://[::1]:4245/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[fe80::1]/",
    ]) {
      expect(await allowPageRequest(blocked, check)).toBe(false)
    }

    let handler: ((route: { request(): { url(): string }; continue(): Promise<void>; abort(code?: string): Promise<void> }) => Promise<void>) | null = null
    await installRouteGuard(
      {
        route: (async (_pat: unknown, fn: unknown) => {
          handler = fn as never
        }) as never,
      },
      check,
    )
    const continued: string[] = []
    const aborted: Array<[string, string | undefined]> = []
    for (const u of ["https://cdn.dribbble.com/a.png", "data:image/gif;base64,AA", "http://169.254.169.254/latest/meta-data", "ws://127.0.0.1:4245/"]) {
      await handler!({
        request: () => ({ url: () => u }),
        continue: async () => {
          continued.push(u)
        },
        abort: async (code) => {
          aborted.push([u, code])
        },
      })
    }
    expect(continued).toEqual(["https://cdn.dribbble.com/a.png", "data:image/gif;base64,AA"])
    expect(aborted).toEqual([
      ["http://169.254.169.254/latest/meta-data", "blockedbyclient"],
      ["ws://127.0.0.1:4245/", "blockedbyclient"],
    ])

    // fetchFirst skips candidate image URLs that fail checkUrl before calling ctx.request.get
    const requested: string[] = []
    const buf = await fetchFirst(
      {
        request: {
          get: async (u: string) => {
            requested.push(u)
            return {
              ok: () => true,
              headers: () => ({ "content-type": "image/jpeg" }),
              body: async () => Buffer.from("img-bytes"),
              dispose: async () => {},
            }
          },
        } as never,
      },
      ["http://127.0.0.1:4245/internal.jpg", "http://169.254.169.254/meta.jpg", "https://i.pinimg.com/originals/a.jpg"],
      "https://ca.pinterest.com/",
      Date.now() + 10_000,
      check,
    )
    expect(requested).toEqual(["https://i.pinimg.com/originals/a.jpg"])
    expect(buf?.toString()).toBe("img-bytes")
  })

  test("loadPage rejects when bot challenge is still active after the wait loop instead of caching a challenge screenshot", async () => {
    const fakePage = {
      goto: async () => null,
      evaluate: async (expr: string) => (expr.includes("challenge-container") ? true : undefined),
      waitForLoadState: async () => {},
    }
    await expect(loadPage(fakePage as never, new URL("https://dribbble.com/shots/1"), Date.now() + 5_000, 0)).rejects.toThrow(CHALLENGED_ERR)
  })
})
