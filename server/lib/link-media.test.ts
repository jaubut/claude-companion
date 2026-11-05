import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LOCAL_INPUT, VIDEO_FORMAT, asImage, beforeDeadline, imageTitle, jsonOrNull, run, ytArgs } from "./link-media"

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
})
