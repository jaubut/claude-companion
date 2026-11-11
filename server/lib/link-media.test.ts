import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LOCAL_INPUT, VIDEO_FORMAT, asImage, beforeDeadline, build, imageTitle, isSafeMediaInfo, jsonOrNull, run, ytArgs } from "./link-media"

describe("bin/media pipeline", () => {
  test("yt-dlp ignores host config and goes through the guard proxy", () => {
    const a = ytArgs("http://127.0.0.1:9")
    expect(a).toContain("--ignore-config")
    expect(a.slice(a.indexOf("--proxy"), a.indexOf("--proxy") + 2)).toEqual(["--proxy", "http://127.0.0.1:9"])
  })

  test("yt-dlp never runs ffprobe on the download, and its ffmpeg speaks http(s) only", () => {
    const a = ytArgs("http://127.0.0.1:1")
    expect(a[a.indexOf("--fixup") + 1]).toBe("never")
    expect(a[a.indexOf("--downloader-args") + 1]).toStartWith("ffmpeg_i:-protocol_whitelist http,https,")
    expect(a.join(" ")).not.toMatch(/whitelist \S*(file|rtmp)/)
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

  test("every video format alternative is limited to proxied protocols (no rtmp)", () => {
    for (const alt of VIDEO_FORMAT.split("/")) expect(alt).toEndWith("[protocol~='^(https?|m3u8(_native)?|http_dash_segments)$']")
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

  test("isSafeMediaInfo accepts http(s)/HLS/DASH and rejects rtmp/file/non-http URLs", () => {
    expect(isSafeMediaInfo({ url: "https://cdn.example.com/v.mp4", protocol: "https" })).toBe(true)
    expect(isSafeMediaInfo({ formats: [{ url: "https://cdn.example.com/master.m3u8", protocol: "m3u8_native" }] })).toBe(true)
    expect(isSafeMediaInfo({ url: "rtmp://live.example.com/app/stream", protocol: "rtmp" })).toBe(false)
    expect(isSafeMediaInfo({ url: "file:///etc/passwd" })).toBe(false)
    expect(isSafeMediaInfo({ formats: [{ url: "rtmp://live.example.com/s", protocol: "rtmp" }] })).toBe(false)
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
})
