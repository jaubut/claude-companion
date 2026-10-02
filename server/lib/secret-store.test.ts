import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type SyncFn, deleteSecret, editLine, handleKeyCommand, isKeyCommand, listNames, listSecrets,
  parseKeyCommand, setSecretHosts, upsertSecret, validHosts, validValue, vaultDeps,
} from "./secret-store"
import { clock, resetVaultLimits } from "./vault-guard"

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
  // Never the real ~/.claude/tools/tls-secrets.py: a temp stand-in marks the host writable.
  process.env.TLS_SECRETS_TOOL = join(dir, "tls-secrets.py")
  writeFileSync(process.env.TLS_SECRETS_TOOL, "")
  resetVaultLimits()
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
  for (const t of ["/key", "/key lower sekret", "/key FAL_KEY", "/key FAL_KEY it's-sekret", "/key FAL_KEY sekret --hosts bad/host"]) {
    const r = await handleKeyCommand(t)
    expect(r?.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain("sekret")
  }
  const r = await handleKeyCommand("/key FAL_KEY sekret123 --hosts *.fal.run")
  expect(r).toMatchObject({ ok: true, name: "FAL_KEY", hosts: ["*.fal.run"] })
  expect(JSON.stringify(r)).not.toContain("sekret123")
  expect(await handleKeyCommand("hello")).toBeNull()
})

test("/key grammar: a value with a space is rejected, never split into value + hosts", async () => {
  writeFileSync(store, FILE)
  for (const t of [
    "/key FAL_KEY sekret part2",            // space inside the value
    "/key FAL_KEY sekret api.fal.run",      // legacy positional host
    "/key FAL_KEY sekret --hosts a.io b.io", // hosts not comma-joined
    "/key FAL_KEY sekret --hosts",          // flag without a list
    "/key FAL_KEY --hosts a.io",            // flag in the value slot
  ]) {
    const r = await handleKeyCommand(t)
    expect(r).toMatchObject({ ok: false, status: 400, error: "bad_key_command" })
    expect(r!.message).toContain("--hosts")
    expect(JSON.stringify(r)).not.toContain("sekret")
  }
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(0)

  expect(parseKeyCommand("/key FAL_KEY v1")).toEqual({ name: "FAL_KEY", value: "v1", hosts: [] })
  expect(parseKeyCommand("/key FAL_KEY v1 --hosts a.io,*.b.io")).toEqual({ name: "FAL_KEY", value: "v1", hosts: ["a.io", "*.b.io"] })
  const ok = await handleKeyCommand("/key FAL_KEY sekret777 --hosts a.io,b.io")
  expect(ok).toMatchObject({ ok: true, hosts: ["a.io", "b.io"] })
  expect(JSON.parse(readFileSync(auditFile, "utf8").trim())).toMatchObject({ device_claimed: "chat", transport: "chat", peer: "unknown" })
})

test("/key shares the 10/min write budget → 429 with retry_after, store untouched", async () => {
  const t0 = 1_000_000
  const realNow = clock.now
  clock.now = () => t0
  try {
    for (let i = 0; i < 10; i++) expect((await handleKeyCommand(`/key FAL_KEY v${i}`))!.ok).toBe(true)
    const before = readFileSync(store, "utf8")
    const r = await handleKeyCommand("/key FAL_KEY sekret-over")
    expect(r).toMatchObject({ ok: false, status: 429, error: "rate_limited", retry_after: 60 })
    expect(readFileSync(store, "utf8")).toBe(before)
    clock.now = () => t0 + 60_000
    expect((await handleKeyCommand("/key FAL_KEY v11"))!.ok).toBe(true)
  } finally {
    clock.now = realNow
  }
})

test("tls-secrets.py absent → every mutation is 501 vault_unavailable, store untouched, list still works", async () => {
  writeFileSync(store, FILE)
  process.env.TLS_SECRETS_TOOL = join(dirname(store), "missing-tls-secrets.py")
  for (const r of [
    await upsertSecret({ name: "FAL_KEY", value: "sekret" }),
    await setSecretHosts("A_KEY", ["x.io"]),
    await deleteSecret("A_KEY"),
    await handleKeyCommand("/key FAL_KEY sekret"),
  ]) expect(r).toMatchObject({ ok: false, status: 501, error: "vault_unavailable" })
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(0)
  expect(existsSync(auditFile)).toBe(false)
  expect(listSecrets().map((e) => e.name)).toEqual(["A_KEY", "FAL_KEY", "B_KEY"])
})
