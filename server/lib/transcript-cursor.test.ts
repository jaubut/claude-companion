import { test, expect, describe, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECK_BYTES, readAppended, readLineAt } from "./transcript-cursor"

const dir = mkdtempSync(join(tmpdir(), "cc-cursor-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const line = (o: unknown) => JSON.stringify(o) + "\n"

describe("transcript cursor", () => {
  test("entries carry the byte location their line can be re-read from", () => {
    const path = join(dir, "loc.jsonl")
    const a = line({ n: 1, pad: "é".repeat(10) }) // multi-byte: offsets are bytes, not chars
    const b = line({ n: 2 })
    writeFileSync(path, a + b)
    const key = {}
    const read = readAppended(key, path)!
    expect(read.entries.map((e) => e.entry.n)).toEqual([1, 2])
    for (const e of read.entries) expect(readLineAt(path, e.offset, e.length)).toEqual(e.entry)
    expect(read.cursor.offset).toBe(Buffer.byteLength(a + b))
    expect(readAppended(key, path)!.entries).toEqual([])
    appendFileSync(path, line({ n: 3 }))
    const more = readAppended(key, path)!
    expect(more.entries.map((e) => e.entry.n)).toEqual([3])
    expect(readLineAt(path, more.entries[0]!.offset, more.entries[0]!.length)).toEqual({ n: 3 })
  })

  test("a rewrite that keeps the size but changes the bytes before the offset resets the cursor", () => {
    const path = join(dir, "check.jsonl")
    writeFileSync(path, line({ v: "aaaa" }) + line({ v: "bbbb" }))
    const key = {}
    expect(readAppended(key, path)!.entries.length).toBe(2)
    writeFileSync(path, line({ v: "cccc" }) + line({ v: "dddd" })) // same size, same inode
    const again = readAppended(key, path)!
    expect(again.entries.map((e) => e.entry.v)).toEqual(["cccc", "dddd"])
    expect(again.cursor.check.length).toBeLessThanOrEqual(CHECK_BYTES)
    // a larger rewrite whose prefix differs resets too
    writeFileSync(path, line({ v: "eeee" }) + line({ v: "ffff" }) + line({ v: "gggg" }))
    expect(readAppended(key, path)!.entries.map((e) => e.entry.v)).toEqual(["eeee", "ffff", "gggg"])
    // a plain append keeps the cursor: only the new line comes back
    appendFileSync(path, line({ v: "hhhh" }))
    expect(readAppended(key, path)!.entries.map((e) => e.entry.v)).toEqual(["hhhh"])
  })

  test("readLineAt returns null for a short read or non-JSON bytes", () => {
    const path = join(dir, "short.jsonl")
    writeFileSync(path, line({ ok: true }))
    expect(readLineAt(path, 0, 500)).toBeNull()
    expect(readLineAt(path, 1, 4)).toBeNull()
    expect(readLineAt(join(dir, "missing.jsonl"), 0, 4)).toBeNull()
  })
})
