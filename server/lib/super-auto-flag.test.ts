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
