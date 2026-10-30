import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { isSecretPath, sentFilePath, storeSentFile, sweepSentFiles } from "./sent-files"

// Real files in a temp dir; the store is COMPANION_SENT_FILES_DIR.

const src = mkdtempSync(join(tmpdir(), "cc-sent-src-"))
const store = mkdtempSync(join(tmpdir(), "cc-sent-store-"))

beforeAll(() => { process.env.COMPANION_SENT_FILES_DIR = store })
afterAll(() => {
  delete process.env.COMPANION_SENT_FILES_DIR
  rmSync(src, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
})

test("secret paths are recognised, ordinary ones are not", () => {
  const h = homedir()
  for (const p of [
    join(h, ".ssh/id_ed25519"), join(h, ".config/tls-agent/secrets.env"), join(h, ".claude-companion/auth.token"),
    join(h, ".claude-companion/auth.token.bak-2026-10-04"), join(h, ".claude-companion/companion.db"),
    "/srv/app/.env", "/srv/app/.env.local", "/srv/app/.secrets", "/k/server.pem", "/k/tls.key", "/backup/id_rsa.pub", "/proc/self/environ",
  ]) expect(isSecretPath(p)).toBe(true)
  for (const p of [join(h, ".claude-companion/media/x.jpg"), join(h, ".claude-companion/sent-files/a/b.zip"), "/tmp/shot.png", "/srv/report.csv"]) {
    expect(isSecretPath(p)).toBe(false)
  }
})

test("a zip is copied byte-identical and found by its id", async () => {
  const p = join(src, "bundle.zip")
  writeFileSync(p, Buffer.from([0x50, 0x4b, 3, 4, 1, 2, 3]))
  const got = (await storeSentFile(p))!
  expect(got.name).toBe("bundle.zip")
  expect(readFileSync(got.path)).toEqual(readFileSync(p))
  expect(sentFilePath(got.id)).toEqual({ path: got.path, name: "bundle.zip" })
})

test("the same file twice is one id, one copy, a touched mtime", async () => {
  const p = join(src, "data.csv")
  writeFileSync(p, "a,b\n1,2\n")
  const a = (await storeSentFile(p))!
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(store, a.id), old, old)
  const b = (await storeSentFile(p))!
  expect(b.id).toBe(a.id)
  expect(statSync(join(store, a.id)).mtimeMs).toBeGreaterThan(old.getTime())
})

test("refused: secret file, symlink to a secret, directory, over 50 MB, missing", async () => {
  const env = join(src, ".env.local")
  writeFileSync(env, "TOKEN=x")
  const link = join(src, "innocent.txt")
  symlinkSync(join(src, ".env.local"), link)
  const dir = join(src, "folder")
  mkdirSync(dir)
  const big = join(src, "big.mov")
  writeFileSync(big, "")
  truncateSync(big, 50 * 1024 * 1024 + 1)
  for (const p of [env, link, dir, big, join(src, "nope.png")]) expect(await storeSentFile(p)).toBeNull()
})

test("unknown ids and a dir with no single file resolve to null", () => {
  expect(sentFilePath("../../etc")).toBeNull()
  expect(sentFilePath("0".repeat(32))).toBeNull()
})

test("the sweep removes entries older than 7 days, keeps fresh ones", async () => {
  const p = join(src, "old.txt")
  writeFileSync(p, "old")
  const old = (await storeSentFile(p))!
  const q = join(src, "fresh.txt")
  writeFileSync(q, "fresh")
  const fresh = (await storeSentFile(q))!
  const eightDays = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  utimesSync(join(store, old.id), eightDays, eightDays)
  expect(sweepSentFiles()).toEqual([old.id])
  expect(sentFilePath(old.id)).toBeNull()
  expect(sentFilePath(fresh.id)).not.toBeNull()
})
