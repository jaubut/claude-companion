import { test, expect, describe, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ARTIFACTS_PER_BLOCK, artifactKey, detectArtifacts } from "./artifacts"

const dir = mkdtempSync(join(tmpdir(), "cc-artifacts-"))
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe("detectArtifacts", () => {
  test("GitHub PR url → kind pr, canonical url, 'PR #n · repo' title", () => {
    const got = detectArtifacts("Opened https://github.com/jaubut/claude-companion/pull/41/files, done.")
    expect(got).toEqual([
      { kind: "pr", title: "PR #41 · claude-companion", url: "https://github.com/jaubut/claude-companion/pull/41" },
    ])
    expect(artifactKey(got[0]!)).toBe("art:pr:https://github.com/jaubut/claude-companion/pull/41")
  })

  test("TLS note refs → kind note with ref; unknown prefixes and wrong lengths ignored", () => {
    const got = detectArtifacts("Filed RES-B9CL on PRJ-WCLS (also IDE-AB12, TIK-0000, MTG-ZZ99). Not FOO-ABCD, RES-ABCDE, xRES-ABCD.")
    expect(got.map((a) => a.ref)).toEqual(["RES-B9CL", "PRJ-WCLS", "IDE-AB12", "TIK-0000", "MTG-ZZ99"])
    expect(got[0]).toEqual({ kind: "note", title: "RES-B9CL", ref: "RES-B9CL" })
  })

  test("existing absolute file of a known type → kind file with basename title", () => {
    const shot = join(dir, "shot.png")
    const cut = join(dir, "edit.fcpxml")
    writeFileSync(shot, "x")
    writeFileSync(cut, "x")
    const got = detectArtifacts(`Saved to ${shot}.\nExported \`${cut}\``)
    expect(got).toEqual([
      { kind: "file", title: "shot.png", path: shot },
      { kind: "file", title: "edit.fcpxml", path: cut },
    ])
  })

  test("missing files, unknown extensions and relative paths are ignored", () => {
    const txt = join(dir, "notes.txt")
    writeFileSync(txt, "x")
    writeFileSync(join(dir, "rel.md"), "x")
    expect(detectArtifacts(`${join(dir, "gone.pdf")} ${txt} rel.md ./rel.md`)).toEqual([])
  })

  test("plain https URLs (non-PR, and image urls) are not artifacts", () => {
    const exists = () => true
    const text = "See https://example.com/x.png and https://github.com/jaubut/repo/issues/3 and https://github.com/jaubut/repo"
    expect(detectArtifacts(text, exists)).toEqual([])
  })

  test("dedupes within one text", () => {
    const pr = "https://github.com/o/r/pull/7"
    const got = detectArtifacts(`${pr} ${pr}/commits RES-AAAA RES-AAAA`)
    expect(got.map((a) => a.kind)).toEqual(["pr", "note"])
  })

  test(`caps at ${ARTIFACTS_PER_BLOCK} per block, in text order`, () => {
    const text = Array.from({ length: 8 }, (_, i) => `https://github.com/o/r/pull/${i + 1}`).join(" ")
    const got = detectArtifacts(text)
    expect(got).toHaveLength(ARTIFACTS_PER_BLOCK)
    expect(got.map((a) => a.url?.split("/").pop())).toEqual(["1", "2", "3", "4", "5"])
  })

  test("empty text → nothing", () => {
    expect(detectArtifacts("")).toEqual([])
  })
})
