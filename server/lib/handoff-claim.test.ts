import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mintHandoffClaim, verifyHandoffClaim } from "./handoff-claim"

const keysFile = () => join(mkdtempSync(join(tmpdir(), "cc-claim-")), "sub", "handoff-claim.keys")
const ID = "0123456789abcdef0123456789abcdef"

describe("handoff claim", () => {
  test("the first mint creates a 0600 key file; the claim verifies for its exact task id, repo and turn", () => {
    const file = keysFile()
    const claim = mintHandoffClaim(ID, "claude-companion", "t-42", file)!
    expect(claim).toMatch(/^hc1\.[0-9a-f]{8}\.t-42\.[A-Za-z0-9_-]{43}$/)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(verifyHandoffClaim(claim, ID, "claude-companion", file)).toMatchObject({ ok: true, turnId: "t-42" })
    expect(verifyHandoffClaim(claim, ID, "Claude-Companion", file).ok).toBe(true) // the repo is case-folded once
    expect(mintHandoffClaim(ID, "claude-companion", "t-42", file)).toBe(claim) // deterministic: a replay gets the same claim
  })

  test("another task id, repo or turn is a bad mac", () => {
    const file = keysFile()
    const claim = mintHandoffClaim(ID, "claude-companion", "t-42", file)!
    expect(verifyHandoffClaim(claim, `${ID.slice(0, 31)}0`, "claude-companion", file)).toEqual({ ok: false, reason: "bad_mac" })
    expect(verifyHandoffClaim(claim, ID, "claude-config", file)).toEqual({ ok: false, reason: "bad_mac" })
    const [v, kid, , mac] = claim.split(".")
    expect(verifyHandoffClaim(`${v}.${kid}.t-43.${mac}`, ID, "claude-companion", file)).toEqual({ ok: false, reason: "bad_mac" })
  })

  test("missing, malformed or truncated never throws", () => {
    const file = keysFile()
    const claim = mintHandoffClaim(ID, "claude-companion", "t-42", file)!
    expect(verifyHandoffClaim(undefined, ID, "claude-companion", file)).toEqual({ ok: false, reason: "missing" })
    expect(verifyHandoffClaim("", ID, "claude-companion", file)).toEqual({ ok: false, reason: "missing" })
    for (const bad of ["hc1", `${claim}.x`, claim.replace(/^hc1/, "hc2"), claim.slice(0, -1), `${claim.slice(0, -1)}+`, "hc1.zz.t.m"]) {
      expect(verifyHandoffClaim(bad, ID, "claude-companion", file)).toEqual({ ok: false, reason: "malformed" })
    }
  })

  test("rotation: a new key signs, the old one still verifies until its line is deleted", () => {
    const file = keysFile()
    const old = mintHandoffClaim(ID, "claude-companion", "t-1", file)!
    const oldKey = readFileSync(file, "utf8").trim()
    const newKey = randomBytes(32).toString("base64url")
    writeFileSync(file, `${newKey}\n${oldKey}\n`)
    const fresh = mintHandoffClaim(ID, "claude-companion", "t-1", file)!
    expect(fresh).not.toBe(old)
    expect(verifyHandoffClaim(old, ID, "claude-companion", file).ok).toBe(true)
    expect(verifyHandoffClaim(fresh, ID, "claude-companion", file).ok).toBe(true)
    writeFileSync(file, `${newKey}\n`)
    expect(verifyHandoffClaim(old, ID, "claude-companion", file)).toEqual({ ok: false, reason: "unknown_key" })
  })

  test("no key file: verify fails closed, never creates one", () => {
    const file = keysFile()
    const claim = mintHandoffClaim(ID, "claude-companion", "t-1", keysFile())!
    expect(verifyHandoffClaim(claim, ID, "claude-companion", file)).toEqual({ ok: false, reason: "no_keys" })
    expect(() => statSync(file)).toThrow()
  })

  test("a key file with no usable key is left alone and mints nothing", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cc-claim-")), "handoff-claim.keys")
    writeFileSync(file, "not-a-key\n")
    expect(mintHandoffClaim(ID, "claude-companion", "t-1", file)).toBeNull()
    expect(readFileSync(file, "utf8")).toBe("not-a-key\n")
  })
})
