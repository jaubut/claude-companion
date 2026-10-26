import { expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HerdrPaneSizer } from "./pane-mirror"

// A stand-in herdr: logs its argv, then each stdin line, until EOF.
function fakeHerdr(body = 'while IFS= read -r l; do echo "$l" >> "$LOG"; done; echo eof >> "$LOG"') {
  const dir = mkdtempSync(join(tmpdir(), "cc-sizer-"))
  const bin = join(dir, "herdr")
  const log = join(dir, "log")
  writeFileSync(bin, `#!/bin/sh\nLOG=${log}\necho "argv $*" >> "$LOG"\n${body}\n`)
  chmodSync(bin, 0o755)
  writeFileSync(log, "")
  return { bin, lines: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) }
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(10)
}

test("sizer: first size spawns the controller, later sizes go over stdin, null closes stdin; no loss reported", async () => {
  const h = fakeHerdr()
  let lost = 0
  const s = new HerdrPaneSizer("w3:p1", () => { lost++ }, h.bin)
  s.set({ cols: 48, rows: 30 })
  s.set({ cols: 40, rows: 25 })
  await until(() => h.lines().length >= 2)
  s.set(null)
  await until(() => h.lines().includes("eof"))
  await Bun.sleep(30)
  expect(h.lines()).toEqual([
    "argv terminal session control w3:p1 --cols 48 --rows 30",
    '{"type":"terminal.resize","cols":40,"rows":25}',
    "eof",
  ])
  expect(lost).toBe(0)
  s.set(null) // nothing held → no-op
})

test("sizer: a controller that ends on its own (refused, killed) reports the loss once; the next size respawns", async () => {
  const h = fakeHerdr("exit 0")
  let lost = 0
  const s = new HerdrPaneSizer("w3:p1", () => { lost++ }, h.bin)
  s.set({ cols: 48, rows: 30 })
  await until(() => lost > 0)
  expect(lost).toBe(1)
  s.set({ cols: 50, rows: 30 })
  await until(() => lost > 1)
  expect(h.lines()).toEqual([
    "argv terminal session control w3:p1 --cols 48 --rows 30",
    "argv terminal session control w3:p1 --cols 50 --rows 30",
  ])
})
