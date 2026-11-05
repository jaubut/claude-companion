import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The guard itself, in a child process with a temp HOME: a broken guard then
// costs a temp file, never the host's real flag.

const MODULE = join(import.meta.dir, "super-auto.ts")
const root = mkdtempSync(join(tmpdir(), "super-auto-flag-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function toggleInChild(env: Record<string, string>): Promise<string> {
  const home = mkdtempSync(join(root, "home-"))
  const flag = join(home, ".claude-companion", "super-auto.flag")
  mkdirSync(join(home, ".claude-companion"))
  writeFileSync(flag, "sentinel")
  const code = `const { setSuperAuto } = await import(${JSON.stringify(MODULE)}); setSuperAuto(false)`
  const proc = Bun.spawn([process.execPath, "-e", code], { cwd: home, env: { PATH: process.env.PATH, HOME: home, ...env }, stdout: "ignore", stderr: "ignore" })
  expect(await proc.exited).toBe(0)
  return flag
}

test("under test, setSuperAuto leaves the HOME flag alone", async () => {
  expect(readFileSync(await toggleInChild({ NODE_ENV: "test" }), "utf8")).toBe("sentinel")
})

test("control: a real server does remove it, so the guard test can fail", async () => {
  expect(existsSync(await toggleInChild({ NODE_ENV: "production" }))).toBe(false)
})

test("COMPANION_SUPER_FLAG is the only file a test can reach", async () => {
  const override = join(root, "override.flag")
  writeFileSync(override, "x")
  const flag = await toggleInChild({ NODE_ENV: "test", COMPANION_SUPER_FLAG: override })
  expect(existsSync(override)).toBe(false)
  expect(readFileSync(flag, "utf8")).toBe("sentinel")
})

// Each boot is a child process, like a server restart.
async function boot(home: string, code = ""): Promise<void> {
  const script = `const { setSuperAuto } = await import(${JSON.stringify(MODULE)}); ${code}`
  const proc = Bun.spawn([process.execPath, "-e", script], { cwd: home, env: { PATH: process.env.PATH, HOME: home, NODE_ENV: "production" }, stdout: "ignore", stderr: "ignore" })
  expect(await proc.exited).toBe(0)
}

const rows = (home: string): Array<Record<string, unknown>> =>
  readFileSync(join(home, ".claude-companion", "super-auto-changes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)

test("every change is logged once with source, server, time, old and new", async () => {
  const home = mkdtempSync(join(root, "log-"))
  await boot(home, `setSuperAuto(true, "phone"); setSuperAuto(true, "phone again"); setSuperAuto(false, "curl")`)
  const [first, on, off, ...rest] = rows(home)
  expect(first).toMatchObject({ old: null, new: false, source: "first boot with this log" })
  expect(on).toMatchObject({ old: false, new: true, source: "phone" })
  expect(off).toMatchObject({ old: true, new: false, source: "curl" })
  expect(off?.server).toBeString()
  expect(String(off?.time)).toMatch(/^\d{4}-\d\d-\d\dT/)
  expect(rest).toEqual([])
})

test("a flag removed behind the server's back is logged at the next boot, once", async () => {
  const home = mkdtempSync(join(root, "gone-"))
  await boot(home, `setSuperAuto(true, "phone")`)
  rmSync(join(home, ".claude-companion", "super-auto.flag"))
  await boot(home)
  await boot(home)
  expect(rows(home).at(-1)).toMatchObject({ old: true, new: false, source: "flag file changed outside the server" })
  expect(rows(home)).toHaveLength(3)
})

test("a restart keeps SUPER on without a new row", async () => {
  const home = mkdtempSync(join(root, "keep-"))
  await boot(home, `setSuperAuto(true, "phone")`)
  await boot(home)
  expect(existsSync(join(home, ".claude-companion", "super-auto.flag"))).toBe(true)
  expect(rows(home)).toHaveLength(2)
})
