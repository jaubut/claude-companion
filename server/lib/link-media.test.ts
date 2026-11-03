import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { VIDEO_FORMAT, asImage, beforeDeadline, imageTitle, run, ytArgs } from "./link-media"

describe("bin/media pipeline", () => {
  test("yt-dlp ignores host config and goes through the guard proxy", () => {
    const a = ytArgs("http://127.0.0.1:9")
    expect(a).toContain("--ignore-config")
    expect(a.slice(a.indexOf("--proxy"), a.indexOf("--proxy") + 2)).toEqual(["--proxy", "http://127.0.0.1:9"])
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

  test("a malformed %-escape in the image name doesn't fail the job", () => {
    expect(imageTitle(new URL("https://8.8.8.8/a%E0.jpg"))).toBe("a%E0.jpg")
    expect(imageTitle(new URL("https://8.8.8.8/caf%C3%A9.jpg"))).toBe("café.jpg")
    expect(imageTitle(new URL("https://8.8.8.8/"))).toBeNull()
  })
})
