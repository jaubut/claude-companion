import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Handoff claim: the server's proof that it filed a `jeremie` handoff row for this exact task id and repo on this
// Jeremie turn (wiring/brain-handoff.ts mints it, nothing else does). The brain relays it to the lead, the lead passes
// it to `bin/worker dispatch --claim`, and every sink that turns the row into trust (worker bind, PR link, startup
// replay) verifies it, so a dispatch under another open handoff's id can't inherit that row's origin.
// Keys: a 0600 file, never process.env, so no spawned process inherits them. Line 1 signs, every line verifies:
// rotate by prepending a new key and dropping the old line once its open handoff PRs are closed; deleting a line
// revokes its claims (those PRs read origin unknown). The Mac needs a copy of the file, or its worker PRs read unknown.

export const handoffKeysPath = (): string => join(process.env.HOME || homedir(), ".claude-companion", "handoff-claim.keys")

export type ClaimCheck = { ok: true; turnId: string; kid: string } | { ok: false; reason: "missing" | "malformed" | "no_keys" | "unknown_key" | "bad_mac" }

const CLAIM_RE = /^hc1\.([0-9a-f]{8})\.([\w:-]{1,64})\.([A-Za-z0-9_-]{43})$/

function readKeys(file: string): Buffer[] {
  try {
    return readFileSync(file, "utf8").split("\n").map((l) => Buffer.from(l.trim(), "base64url")).filter((k) => k.length === 32)
  } catch {
    return []
  }
}

const kidOf = (key: Buffer): string => createHash("sha256").update(key).digest("hex").slice(0, 8)
const macOf = (key: Buffer, taskId: string, repo: string, turnId: string): string =>
  createHmac("sha256", key).update(`companion-handoff-claim/v1\n${taskId}\n${repo.toLowerCase()}\n${turnId}`).digest("base64url")

/** `hc1.<kid>.<turnId>.<mac>`; the key file is created (0600) on the first mint. null = no usable key. */
export function mintHandoffClaim(taskId: string, repo: string, turnId: string, file = handoffKeysPath()): string | null {
  if (!readKeys(file).length) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600, flag: "wx" }) // never overwrites
    } catch { /* exists (another mint won, or a file to leave alone) */ }
  }
  const key = readKeys(file)[0]
  return key ? `hc1.${kidOf(key)}.${turnId}.${macOf(key, taskId, repo, turnId)}` : null
}

/** Constant-time check of a claim for this task id and repo. Never throws, never logs the claim. */
export function verifyHandoffClaim(claim: unknown, taskId: string, repo: string, file = handoffKeysPath()): ClaimCheck {
  if (typeof claim !== "string" || !claim) return { ok: false, reason: "missing" }
  const m = CLAIM_RE.exec(claim)
  if (!m) return { ok: false, reason: "malformed" }
  const keys = readKeys(file)
  if (!keys.length) return { ok: false, reason: "no_keys" }
  const key = keys.find((k) => kidOf(k) === m[1])
  if (!key) return { ok: false, reason: "unknown_key" }
  const want = Buffer.from(macOf(key, taskId, repo, m[2]!))
  const got = Buffer.from(m[3]!)
  return got.length === want.length && timingSafeEqual(got, want) ? { ok: true, turnId: m[2]!, kid: m[1]! } : { ok: false, reason: "bad_mac" }
}
