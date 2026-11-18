import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  type OpFn, type SyncFn, deleteSecret, editLine, handleKeyCommand, isKeyCommand, listNames, listSecrets,
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
const realOp = vaultDeps.op
afterEach(() => { vaultDeps.sync = realSync; vaultDeps.op = realOp })

// Fake `op`: never the real CLI or token. Records argv + stdin.
let opCalls: { args: string[]; stdin?: string }[] = []
function fakeOp(items: { id: string; title: string; tags?: string[] }[], failWith?: string): OpFn {
  opCalls = []
  return async (args, stdin) => {
    opCalls.push({ args, stdin })
    if (failWith) return { ok: false, out: failWith }
    return { ok: true, out: args[1] === "list" ? JSON.stringify(items) : args[1] === "create" ? '{"id":"new-id"}' : "{}" }
  }
}
const withOpToken = (): void => writeFileSync(join(dirname(store), "op-token"), "fake-token\n", { mode: 0o600 })

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

test("1Password up: create goes to the vault, value only on op's stdin, message names 1Password", async () => {
  withOpToken()
  vaultDeps.op = fakeOp([])
  const r = await upsertSecret({ name: "FAL_KEY", value: "sekret123", hosts: ["*.fal.run"] }, "iphone")
  expect(r).toMatchObject({ ok: true, action: "created" })
  expect(opCalls.map((c) => c.args)).toEqual([
    ["item", "list", "--vault", "Agents-Zettlab", "--format", "json"],
    ["item", "create", "--vault", "Agents-Zettlab", "--format", "json", "-"],
  ])
  expect(JSON.stringify(opCalls.map((c) => c.args))).not.toContain("sekret")
  expect(JSON.parse(opCalls[1]!.stdin!)).toEqual({ title: "FAL_KEY", category: "API_CREDENTIAL", tags: ["host:*.fal.run"],
    fields: [{ id: "credential", label: "credential", type: "CONCEALED", value: "sekret123" }] })
  expect(r.message).toBe("🔑 FAL_KEY enregistré (*.fal.run) dans 1Password (coffre Agents-Zettlab). Les nouvelles sessions l'auront; les sessions ouvertes gardent l'ancienne valeur jusqu'au redémarrage.")
  expect(readFileSync(store, "utf8")).toContain("FAL_KEY='sekret123'  # *.fal.run\n") // fallback kept in step
  expect(existsSync(join(dirname(store), ".env"))).toBe(false)
  expect(JSON.parse(readFileSync(auditFile, "utf8")).store).toBe("1password")
  expect(syncCalls).toBe(1)
})

test("1Password up: rotate edits the item and keeps non-host tags; retag and delete hit the same item", async () => {
  withOpToken()
  writeFileSync(store, FILE)
  vaultDeps.op = fakeOp([{ id: "abc", title: "FAL_KEY", tags: ["host:old.io", "scripts"] }])
  await upsertSecret({ name: "FAL_KEY", value: "sekret456", hosts: ["*.fal.run"] })
  expect(opCalls[1]!.args).toEqual(["item", "edit", "abc", "--vault", "Agents-Zettlab"])
  expect(JSON.parse(opCalls[1]!.stdin!).tags).toEqual(["host:*.fal.run", "scripts"])
  vaultDeps.op = fakeOp([{ id: "abc", title: "FAL_KEY", tags: ["host:old.io", "scripts"] }])
  await setSecretHosts("FAL_KEY", ["*.fal.ai"])
  expect(opCalls[1]).toEqual({ args: ["item", "edit", "abc", "--vault", "Agents-Zettlab", "--tags", "host:*.fal.ai,scripts"], stdin: undefined })
  vaultDeps.op = fakeOp([{ id: "abc", title: "FAL_KEY" }])
  expect((await deleteSecret("FAL_KEY")).message).toStartWith("FAL_KEY supprimé de 1Password (coffre Agents-Zettlab).")
  expect(opCalls[1]!.args).toEqual(["item", "delete", "abc", "--vault", "Agents-Zettlab"])
})

test("1Password down (bad token): secrets.env fallback written + synced, reply says so, no .env, value never echoed", async () => {
  withOpToken()
  writeFileSync(store, FILE)
  vaultDeps.op = fakeOp([], "[ERROR] DecodeSACredentials: illegal base64 data at input byte 4")
  const r = await upsertSecret({ name: "NEW_KEY", value: "sekret777", hosts: ["api.x.io"] })
  expect(r).toMatchObject({ ok: true, status: 200, action: "created" })
  expect(opCalls).toHaveLength(1)
  expect(readFileSync(store, "utf8")).toBe(FILE + "NEW_KEY='sekret777'  # api.x.io\n")
  expect(syncCalls).toBe(1)
  expect(r.message).toContain(`🔑 NEW_KEY enregistré (api.x.io) dans ${store}.`)
  expect(r.message).toContain("⚠️ 1Password injoignable ([ERROR] DecodeSACredentials: illegal base64 data at input byte 4)")
  expect(r.message).toContain("réenregistre NEW_KEY")
  expect(r.message).not.toContain("sekret777")
  expect(existsSync(join(dirname(store), ".env"))).toBe(false)
  expect(JSON.parse(readFileSync(auditFile, "utf8")).store).toBe("secrets.env")
})

test("op throws (missing binary): same fallback; no op-token → op never called", async () => {
  withOpToken()
  vaultDeps.op = async () => { throw new Error("spawn op ENOENT") }
  const r = await upsertSecret({ name: "A_KEY", value: "v1" })
  expect(r.ok).toBe(true)
  expect(r.message).toContain("1Password injoignable (spawn op ENOENT)")
  rmSync(join(dirname(store), "op-token"))
  vaultDeps.op = fakeOp([])
  const plain = await upsertSecret({ name: "A_KEY", value: "v2" })
  expect(opCalls).toHaveLength(0)
  expect(plain.message).toBe(`🔑 A_KEY enregistré (aucun hôte: jamais envoyé) dans ${store}. Les nouvelles sessions l'auront; les sessions ouvertes gardent l'ancienne valeur jusqu'au redémarrage.`)
})

test("sync failure after a 1Password create → the new item is deleted, file rolled back", async () => {
  withOpToken()
  writeFileSync(store, FILE)
  vaultDeps.op = fakeOp([])
  vaultDeps.sync = fail
  const r = await upsertSecret({ name: "NEW_KEY", value: "sekret" })
  expect(r).toMatchObject({ ok: false, error: "sync_failed" })
  expect(opCalls.at(-1)!.args).toEqual(["item", "delete", "new-id", "--vault", "Agents-Zettlab"])
  expect(r.message).toContain("Rien n'a changé.")
  expect(readFileSync(store, "utf8")).toBe(FILE)
})

test("sync failure + the create's undo fails → reply says the item stays in 1Password unmasked", async () => {
  withOpToken()
  const base = fakeOp([])
  vaultDeps.op = async (args, stdin) => args[1] === "delete" ? { ok: false, out: "network down" } : base(args, stdin)
  vaultDeps.sync = fail
  const r = await upsertSecret({ name: "NEW_KEY", value: "sekret" })
  expect(r).toMatchObject({ ok: false, error: "sync_failed" })
  expect(r.message).toContain("reste dans 1Password SANS masque (suppression échouée: network down)")
  expect(r.message).not.toContain("Rien n'a changé")
})

test("sync failure after a 1Password rotate → kept, but audited and mirrored", async () => {
  withOpToken()
  writeFileSync(store, FILE)
  vaultDeps.op = fakeOp([{ id: "abc", title: "FAL_KEY" }])
  vaultDeps.sync = fail
  const r = await upsertSecret({ name: "FAL_KEY", value: "sekret" })
  expect(r).toMatchObject({ ok: false, status: 500, error: "sync_failed" })
  expect(JSON.parse(readFileSync(auditFile, "utf8"))).toMatchObject({ action: "updated", name: "FAL_KEY", store: "1password" })
})

test("1Password down: rotate / retag / delete fail closed — nothing written, no sync, no audit", async () => {
  withOpToken()
  writeFileSync(store, FILE)
  vaultDeps.op = fakeOp([], "connection refused")
  for (const r of [
    await upsertSecret({ name: "FAL_KEY", value: "sekret" }),
    await setSecretHosts("FAL_KEY", ["x.io"]),
    await deleteSecret("FAL_KEY"),
  ]) expect(r).toMatchObject({ ok: false, status: 503, error: "op_unavailable" })
  expect(readFileSync(store, "utf8")).toBe(FILE)
  expect(syncCalls).toBe(0)
  expect(existsSync(auditFile)).toBe(false)
})

test("1Password up but the key only in secrets.env: retag / delete recorded as secrets.env", async () => {
  withOpToken()
  writeFileSync(store, FILE)
  vaultDeps.op = fakeOp([])
  const r = await deleteSecret("FAL_KEY")
  expect(r.message).toStartWith(`FAL_KEY supprimé de ${store}.`)
  expect(opCalls).toHaveLength(1)
  expect(JSON.parse(readFileSync(auditFile, "utf8")).store).toBe("secrets.env")
})

test("empty op-token → op not run, treated as 1Password down", async () => {
  writeFileSync(join(dirname(store), "op-token"), "  \n")
  const r = await upsertSecret({ name: "NEW_KEY", value: "v1" })
  expect(r.ok).toBe(true)
  expect(r.message).toContain("1Password injoignable (op-token vide)")
})

test("legacy env present → stale .env copy removed", async () => {
  const dir = dirname(store)
  writeFileSync(join(dir, "env"), "A_KEY='1'\n")
  writeFileSync(join(dir, ".env"), "OLD_KEY='leaked'\n")
  await upsertSecret({ name: "A_KEY", value: "2" })
  expect(existsSync(join(dir, ".env"))).toBe(false)
  expect(readFileSync(join(dir, "env"), "utf8")).toBe("A_KEY='2'\n")
})
