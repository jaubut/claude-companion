import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type SyncFn, deleteSecret, editLine, handleKeyCommand, isKeyCommand, listNames, listSecrets,
  setSecretHosts, upsertSecret, validHosts, validValue, vaultDeps,
} from "./secret-store"

const realSync = vaultDeps.sync
let syncCalls = 0
const ok: SyncFn = async () => { syncCalls++; return { ok: true, detail: "" } }
const fail: SyncFn = async () => { syncCalls++; return { ok: false, detail: "boom" } }
let store = ""
let auditFile = ""

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "secret-store-"))
  store = process.env.TLS_SECRETS_FILE = join(dir, "secrets.env")
  auditFile = process.env.TLS_VAULT_AUDIT_FILE = join(dir, "vault-audit.jsonl")
  syncCalls = 0
  vaultDeps.sync = ok
})
afterEach(() => { vaultDeps.sync = realSync })

const FILE = "# c\nA_KEY='1'  # a.io\n\nFAL_KEY='old'  # scripts\nexport B_KEY=2 # b.io\n"

test("only /key messages are intercepted", () => {
  expect(isKeyCommand("/key FAL_KEY abc")).toBe(true)
  expect(isKeyCommand("  /KEY")).toBe(true)
  expect(isKeyCommand("/keyboard")).toBe(false)
  expect(isKeyCommand("please /key FAL_KEY abc")).toBe(false)
})

test("validation: value and hosts", () => {
  for (const v of ["", "it's", 'a"b', "a\nb", "a\rb"]) expect(validValue(v)).toBe(false)
  expect(validValue("v=1#x")).toBe(true)
  expect(validHosts(["*.fal.run", "api.x.io:443"])).toBe(true)
  for (const h of [["bad/host"], ["plain"], ["a.io\n"], ["x.io #"], ["a.io", "b.io", "c.io", "d.io", "e.io", "f.io"]]) expect(validHosts(h)).toBe(false)
})

test("editLine: rotate in place keeps flags and every other line byte-identical", () => {
  expect(editLine(FILE, "FAL_KEY", { value: "new", hosts: ["*.fal.run"] }))
    .toBe("# c\nA_KEY='1'  # a.io\n\nFAL_KEY='new'  # *.fal.run scripts\nexport B_KEY=2 # b.io\n")
})

test("editLine: hosts only keeps the raw value; delete removes one line; create appends", () => {
  expect(editLine(FILE, "B_KEY", { hosts: ["c.io"] })).toBe("# c\nA_KEY='1'  # a.io\n\nFAL_KEY='old'  # scripts\nexport B_KEY=2  # c.io\n")
  expect(editLine(FILE, "A_KEY", { remove: true })).toBe("# c\n\nFAL_KEY='old'  # scripts\nexport B_KEY=2 # b.io\n")
  expect(editLine(FILE, "NEW_KEY", { value: "v", hosts: [] })).toBe(FILE + "NEW_KEY='v'\n")
  expect(editLine(FILE, "NOPE_KEY", { remove: true })).toBeNull()
  expect(editLine(FILE, "NOPE_KEY", { hosts: [] })).toBeNull()
  expect(listNames(FILE)).toEqual([
    { name: "A_KEY", hosts: ["a.io"], scripts: false },
    { name: "FAL_KEY", hosts: [], scripts: true },
    { name: "B_KEY", hosts: ["b.io"], scripts: false },
  ])
})

test("add → rotate → hosts → delete: 0600, synced each time, audited without the value", async () => {
  const add = await upsertSecret({ name: "FAL_KEY", value: "sekret123", hosts: ["*.fal.run"] }, "iphone")
  expect(add).toMatchObject({ ok: true, action: "created", name: "FAL_KEY", hosts: ["*.fal.run"] })
  expect(statSync(store).mode & 0o777).toBe(0o600)
  expect(readFileSync(store, "utf8")).toContain("FAL_KEY='sekret123'  # *.fal.run\n")

  const rot = await upsertSecret({ name: "FAL_KEY", value: "sekret456", hosts: ["*.fal.run"] }, "iphone")
  expect(rot.action).toBe("updated")
  expect((await setSecretHosts("FAL_KEY", ["*.fal.ai"])).action).toBe("hosts")
  expect(readFileSync(store, "utf8")).toContain("FAL_KEY='sekret456'  # *.fal.ai\n")
  expect(listSecrets()).toMatchObject([{ name: "FAL_KEY", hosts: ["*.fal.ai"], scripts: false }])
  expect(listSecrets()[0]!.updated_at).toMatch(/^\d{4}-/)

  expect((await deleteSecret("FAL_KEY")).action).toBe("deleted")
  expect(listSecrets()).toEqual([])
  expect(syncCalls).toBe(4)

  const log = readFileSync(auditFile, "utf8")
  expect(log.trim().split("\n").map((l) => JSON.parse(l).action)).toEqual(["created", "updated", "hosts", "deleted"])
  expect(log).not.toContain("sekret")
  expect(statSync(auditFile).mode & 0o777).toBe(0o600)
})

test("missing name → 404, bad input → 400, no sync", async () => {
  expect((await setSecretHosts("NOPE_KEY", [])).status).toBe(404)
  expect((await deleteSecret("NOPE_KEY")).status).toBe(404)
  expect((await upsertSecret({ name: "lower", value: "x" })).status).toBe(400)
  expect((await upsertSecret({ name: "A_KEY", value: "x", hosts: "a.io" })).status).toBe(400)
  expect(syncCalls).toBe(0)
})

test("sync failure → 500, store rolled back (or removed if new), no audit, value redacted", async () => {
  writeFileSync(store, FILE)
  vaultDeps.sync = async () => ({ ok: false, detail: "trace sekret99 here" })
  const r = await upsertSecret({ name: "FAL_KEY", value: "sekret99" })
  expect(r).toMatchObject({ ok: false, status: 500, error: "sync_failed" })
  expect(JSON.stringify(r)).not.toContain("sekret99")
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(existsSync(auditFile)).toBe(false)

  const fresh = process.env.TLS_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), "secret-store-")), "secrets.env")
  vaultDeps.sync = fail
  await upsertSecret({ name: "FAL_KEY", value: "sekret" })
  expect(existsSync(fresh)).toBe(false)
})

test("/key: parse errors and replies never echo the value; plain text passes", async () => {
  for (const t of ["/key", "/key lower sekret", "/key FAL_KEY", "/key FAL_KEY it's-sekret", "/key FAL_KEY sekret bad/host"]) {
    const r = await handleKeyCommand(t)
    expect(r?.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain("sekret")
  }
  const r = await handleKeyCommand("/key FAL_KEY sekret123 *.fal.run")
  expect(r).toMatchObject({ ok: true, name: "FAL_KEY", hosts: ["*.fal.run"] })
  expect(JSON.stringify(r)).not.toContain("sekret123")
  expect(await handleKeyCommand("hello")).toBeNull()
})
