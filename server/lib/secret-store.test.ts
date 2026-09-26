import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleKeyCommand, isKeyCommand, parseKeyCommand, upsertLine } from "./secret-store"

const ok = async () => ({ ok: true, detail: "" })
const fail = async () => ({ ok: false, detail: "boom" })
const tmp = () => join(mkdtempSync(join(tmpdir(), "secret-store-")), "secrets.env")

test("only /key messages are intercepted", () => {
  expect(isKeyCommand("/key FAL_KEY abc")).toBe(true)
  expect(isKeyCommand("  /KEY")).toBe(true)
  expect(isKeyCommand("/keyboard")).toBe(false)
  expect(isKeyCommand("please /key FAL_KEY abc")).toBe(false)
})

test("parse errors never echo the value", () => {
  for (const t of ["/key", "/key lower sekret", "/key FAL_KEY", "/key FAL_KEY it's-sekret", "/key FAL_KEY sekret bad/host"]) {
    const r = parseKeyCommand(t)
    expect("error" in r).toBe(true)
    expect(JSON.stringify(r)).not.toContain("sekret")
  }
  expect(parseKeyCommand("/key FAL_KEY v=1#x *.fal.run api.x.io:443")).toEqual({ name: "FAL_KEY", value: "v=1#x", hosts: ["*.fal.run", "api.x.io:443"] })
})

test("upsert replaces only the named line", () => {
  const before = "# c\nA_KEY='1'  # a.io\nFAL_KEY='old'\nexport B_KEY=2\n"
  expect(upsertLine(before, { name: "FAL_KEY", value: "new", hosts: ["*.fal.run"] }))
    .toBe("# c\nA_KEY='1'  # a.io\nexport B_KEY=2\nFAL_KEY='new'  # *.fal.run\n")
})

test("saves 0600, reply carries the name but never the value", async () => {
  const storePath = tmp()
  const r = await handleKeyCommand("/key FAL_KEY sekret123 *.fal.run", { storePath, sync: ok })
  expect(r?.ok).toBe(true)
  expect(JSON.stringify(r)).not.toContain("sekret123")
  expect(JSON.stringify(r)).toContain("FAL_KEY")
  expect(readFileSync(storePath, "utf8")).toContain("FAL_KEY='sekret123'  # *.fal.run\n")
  expect(statSync(storePath).mode & 0o777).toBe(0o600)
})

test("sync failure rolls back, and removes a store that did not exist", async () => {
  const storePath = tmp()
  writeFileSync(storePath, "A_KEY='1'\n")
  const r = await handleKeyCommand("/key FAL_KEY sekret", { storePath, sync: fail })
  expect(r?.ok).toBe(false)
  expect(readFileSync(storePath, "utf8")).toBe("A_KEY='1'\n")

  const fresh = tmp()
  await handleKeyCommand("/key FAL_KEY sekret", { storePath: fresh, sync: fail })
  expect(existsSync(fresh)).toBe(false)
})

test("non-/key text passes through untouched", async () => {
  expect(await handleKeyCommand("hello", { storePath: tmp(), sync: ok })).toBeNull()
})
