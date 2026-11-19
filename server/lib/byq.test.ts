import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UI_BLOCK_WIDTHS } from "./board-schema"

// BYQ manifest + thumbnails (canvas auto-layout S1): the CDN fetch is
// host-allowlisted and type-checked, then cached by <kind>-<id>.

const saved = { HOME: process.env.HOME, BYQ_LIB: process.env.BYQ_LIB }
const home = mkdtempSync(join(tmpdir(), "cc-byq-home-"))
const lib = mkdtempSync(join(tmpdir(), "cc-byq-lib-"))
process.env.HOME = home
process.env.BYQ_LIB = lib
afterAll(() => Object.assign(process.env, saved))
writeFileSync(join(lib, "index.json"), JSON.stringify([
  { id: "ok-hero-1", kind: "component", thumbnailUrl: "https://ftspw3fevajkuozl.public.blob.vercel-storage.com/a.webp", path: null },
  { id: "evil-1", kind: "component", thumbnailUrl: "https://169.254.169.254/latest/meta-data", path: null },
  { id: "http-1", kind: "component", thumbnailUrl: "http://byqsupply-components.netlify.app/x.webp", path: null },
  { id: "svg-1", kind: "gem", thumbnailUrl: "https://byqsupply-components.netlify.app/x.svg", path: null },
]))
const { BYQ_MANIFEST, byqThumb, byqThumbDir } = await import("./byq")
// Bun caches os.homedir() at first use: clear this file's names wherever the cache is.
for (const f of ["component-ok-hero-1.webp", "gem-svg-1.svg"]) rmSync(join(byqThumbDir(), f), { force: true })
const WEBP = Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1"), Buffer.alloc(16)])

describe("byq", () => {
  test("manifest: committed metadata only, widths match the schema, slugs unique", () => {
    expect(BYQ_MANIFEST.widths).toEqual(UI_BLOCK_WIDTHS)
    const slugs = BYQ_MANIFEST.items.map((i) => i.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(slugs.length).toBeGreaterThanOrEqual(13)
    for (const i of BYQ_MANIFEST.items) {
      expect(Object.keys(i).sort()).toEqual(["category", "component", "file", "fonts", "kind", "name", "slug", "thumb", "thumbHash"])
      expect(i.thumb).toBe(`${i.kind}-${i.slug}`)
    }
  })

  test("thumb: fetched once from an allowed host, then served from the cache", async () => {
    let calls = 0
    const fetcher = (async (url: URL) => { calls++; expect(url.hostname).toBe("ftspw3fevajkuozl.public.blob.vercel-storage.com"); return new Response(WEBP) }) as unknown as typeof fetch
    const t = (await byqThumb("component-ok-hero-1.jpg", fetcher))!
    expect(t.mime).toBe("image/webp")
    expect(t.path).toBe(join(byqThumbDir(), "component-ok-hero-1.webp"))
    expect(readFileSync(t.path).equals(WEBP)).toBe(true)
    expect((await byqThumb("component-ok-hero-1", fetcher))!.path).toBe(t.path)
    expect(calls).toBe(1)
  })

  test("thumb: bad names, other hosts, http, non-images and fetch failures → null, nothing fetched or cached", async () => {
    let calls = 0
    const fetcher = (async () => { calls++; return new Response("<svg onload=alert(1)>") }) as unknown as typeof fetch
    for (const name of ["../auth.token", "component-..%2fx", "component-", "evil-1", "component-missing-1", "component-evil-1", "component-http-1"]) {
      expect(await byqThumb(name, fetcher)).toBeNull()
    }
    expect(calls).toBe(0)
    expect(await byqThumb("gem-svg-1", fetcher)).toBeNull()
    expect(calls).toBe(1)
    expect(existsSync(join(byqThumbDir(), "gem-svg-1.svg"))).toBe(false)
    const failing = (async () => { throw new Error("offline") }) as unknown as typeof fetch
    expect(await byqThumb("component-ok-hero-2", failing)).toBeNull()
  })
})
