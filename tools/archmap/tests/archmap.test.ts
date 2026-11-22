import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FIELD_GUIDE_CAP, fieldGuideLint } from "../lint"

let root = ""
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "archmap-fg-")) })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const lines = (n: number) => Array.from({ length: n }, (_, i) => `- trap ${i + 1}`).join("\n")

describe("fieldGuideLint", () => {
  test("no FIELD_GUIDE.md, or one within the cap (trailing newline ignored), is clean", () => {
    expect(fieldGuideLint(root)).toEqual([])
    writeFileSync(join(root, "FIELD_GUIDE.md"), `${lines(FIELD_GUIDE_CAP)}\n`)
    expect(fieldGuideLint(root)).toEqual([])
  })

  test("over the cap blocks with the field-guide-cap rule", () => {
    writeFileSync(join(root, "FIELD_GUIDE.md"), `${lines(FIELD_GUIDE_CAP + 1)}\n`)
    const [issue, ...rest] = fieldGuideLint(root)
    expect(rest).toEqual([])
    expect(issue).toMatchObject({ target: "repo", module: "FIELD_GUIDE.md", rule: "field-guide-cap", blocking: true })
    expect(issue!.detail).toContain("101 lines")
  })

  test("a symlink blocks even when its target is short", () => {
    writeFileSync(join(root, "real.md"), "- trap")
    symlinkSync(join(root, "real.md"), join(root, "FIELD_GUIDE.md"))
    expect(fieldGuideLint(root)).toMatchObject([{ rule: "field-guide-cap", blocking: true }])
  })
})
