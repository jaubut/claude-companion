import { expect, test } from "bun:test"
import { companionLog, formatLogLines, logPrefix } from "./log"

test("prefix carries an ISO UTC timestamp before [companion]", () => {
  const p = logPrefix(new Date("2026-09-24T12:34:56.789Z"))
  expect(p).toBe("\x1b[2m2026-09-24T12:34:56.789Z [companion]\x1b[0m")
})

test("companionLog writes one timestamped line to stderr", () => {
  const orig = process.stderr.write.bind(process.stderr)
  const out: string[] = []
  process.stderr.write = ((chunk: string) => { out.push(chunk); return true }) as typeof process.stderr.write
  try {
    companionLog("\x1b[32mdelivered (tmux)\x1b[0m → %89")
  } finally {
    process.stderr.write = orig
  }
  expect(out).toHaveLength(1)
  expect(out[0]).toMatch(/^\x1b\[2m\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[companion\]\x1b\[0m \x1b\[32mdelivered \(tmux\)\x1b\[0m → %89\n$/)
})

test("every physical line of a multiline message is timestamped", () => {
  const now = new Date("2026-09-24T12:34:56.789Z")
  const p = logPrefix(now)
  expect(formatLogLines("first\nsecond\n  at stack (x.ts:1)", now)).toBe(`${p} first\n${p} second\n${p}   at stack (x.ts:1)\n`)
})

test("a single-line message is unchanged in shape", () => {
  const now = new Date("2026-09-24T12:34:56.789Z")
  expect(formatLogLines("ok", now)).toBe(`${logPrefix(now)} ok\n`)
})

test("secureLogFile creates a missing log 0600 and narrows an existing one", async () => {
  const { mkdtempSync, statSync, writeFileSync, chmodSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { secureLogFile } = await import("./log")
  const dir = mkdtempSync(join(tmpdir(), "companion-log-"))
  try {
    const fresh = join(dir, "sub", "companion.log")
    expect(secureLogFile(fresh)).toBe(true)
    expect(statSync(fresh).mode & 0o777).toBe(0o600)

    const loose = join(dir, "loose.log")
    writeFileSync(loose, "boot banner\n")
    chmodSync(loose, 0o644)
    expect(secureLogFile(loose)).toBe(true)
    expect(statSync(loose).mode & 0o777).toBe(0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
