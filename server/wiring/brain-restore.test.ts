import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Herdr } from "../lib/herdr"
import type { AgentLookup } from "./takeover-liveness"
import type { BrainIdentity } from "./brain-restore"

// Stage 0b: the brain gets its identity back after a herdr restore
// (wiring/brain-restore.ts), against a fake herdr — never the real one.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-restore-")), "test.db")
process.env.COMPANION_AUTH_TOKEN ||= "vault-test-token-0123456789"

let mod: typeof import("./brain-restore")
beforeAll(async () => { mod = await import("./brain-restore") })

const PANE = "w1:p1"
const present: AgentLookup = { kind: "present", ref: { pane: PANE, workspaceId: "w1" } }

function fakeHerdr(shellPid: number | "throw"): Herdr & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    async call(args) {
      calls.push(args)
      if (shellPid === "throw") throw Object.assign(new Error("timeout"), { code: "timeout" })
      return { process_info: { shell_pid: shellPid, foreground_process_group_id: shellPid + 1 } }
    },
    read: async () => null,
    gate: async () => null,
  }
}

describe("herdrEpoch", () => {
  test("changes when the socket is re-created (server restart), stable otherwise, empty when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-herdr-epoch-"))
    const sock = join(dir, "herdr.sock")
    expect(mod.herdrEpoch(sock)).toBe("")
    writeFileSync(sock, "")
    const first = mod.herdrEpoch(sock)
    expect(first).not.toBe("")
    expect(mod.herdrEpoch(sock)).toBe(first)
    rmSync(sock)
    writeFileSync(join(dir, "hold"), "") // keep the old inode number from being reused at once
    writeFileSync(sock, "")
    expect(mod.herdrEpoch(sock)).not.toBe(first)
  })
})

describe("brainIdentity: the brain pane's shell env", () => {
  const envOf = (env: string[] | null) => async (pid: string) => (pid === "500" ? env : null)

  test("ok when spawnInHerdr's COMPANION_TASK_ID=brain is on the shell", async () => {
    const h = fakeHerdr(500)
    expect(await mod.brainIdentity(async () => present, h, envOf(["HOME=/h", "COMPANION_TASK_ID=brain"]))).toBe("ok")
    expect(h.calls).toEqual([["pane", "process-info", "--pane", PANE]])
  })

  test("lost when a restored pane has no COMPANION_TASK_ID (or another one)", async () => {
    expect(await mod.brainIdentity(async () => present, fakeHerdr(500), envOf(["HOME=/h"]))).toBe("lost")
    expect(await mod.brainIdentity(async () => present, fakeHerdr(500), envOf(["COMPANION_TASK_ID=x"]))).toBe("lost")
  })

  test("absent agent, herdr error, unreadable env: never lost", async () => {
    const env = envOf(["HOME=/h"])
    expect(await mod.brainIdentity(async () => ({ kind: "absent" }), fakeHerdr(500), env)).toBe("absent")
    expect(await mod.brainIdentity(async () => ({ kind: "error" }), fakeHerdr(500), env)).toBe("unknown")
    expect(await mod.brainIdentity(async () => ({ kind: "present", ref: { pane: "" } }), fakeHerdr(500), env)).toBe("unknown")
    expect(await mod.brainIdentity(async () => present, fakeHerdr("throw"), env)).toBe("unknown")
    expect(await mod.brainIdentity(async () => present, fakeHerdr(0), env)).toBe("unknown")
    expect(await mod.brainIdentity(async () => present, fakeHerdr(500), envOf(null))).toBe("unknown")
  })
})

describe("createBrainRestore: restore detection → one respawn", () => {
  function rig(ids: BrainIdentity[]) {
    const s = { epoch: "srv1", identities: [...ids], identityReads: 0, stops: 0, alive: true, log: [] as string[] }
    const r = mod.createBrainRestore({
      epoch: () => s.epoch,
      identity: async () => { s.identityReads++; return s.identities.shift() ?? "ok" },
      alive: async () => s.alive,
      stop: async () => { s.stops++ },
      log: (m) => s.log.push(m),
    })
    return { s, r }
  }

  test("same herdr instance: identity read once, then plain liveness (no herdr call per tick)", async () => {
    const { s, r } = rig(["ok"])
    expect(await r.alive()).toBe(true)
    expect(await r.alive()).toBe(true)
    expect(await r.alive()).toBe(true)
    expect(s.identityReads).toBe(1)
    expect(s.stops).toBe(0)
  })

  test("restore with identity lost: stopped once and reported dead, so the supervisor respawns (resume)", async () => {
    const { s, r } = rig(["ok", "lost", "lost"])
    expect(await r.alive()).toBe(true)
    s.epoch = "srv2" // herdr server restarted
    expect(await r.alive()).toBe(false)
    expect(s.stops).toBe(1)
    expect(s.log.join("\n")).toContain("herdr restore")
    // Next ticks on the same instance: never a second stop, whatever the respawned pane looks like.
    expect(await r.alive()).toBe(true)
    expect(await r.alive()).toBe(true)
    expect(s.stops).toBe(1)
    expect(s.identityReads).toBe(2)
  })

  test("restore with identity intact (live handoff): no respawn", async () => {
    const { s, r } = rig(["ok", "ok"])
    await r.alive()
    s.epoch = "srv2"
    expect(await r.alive()).toBe(true)
    expect(s.stops).toBe(0)
  })

  test("absent or unknown keeps checking until a definite answer (claude not up yet in the restored pane)", async () => {
    const { s, r } = rig(["absent", "unknown", "lost"])
    expect(await r.alive()).toBe(true)
    expect(await r.alive()).toBe(true)
    expect(s.stops).toBe(0)
    expect(await r.alive()).toBe(false)
    expect(s.stops).toBe(1)
    expect(s.identityReads).toBe(3)
  })

  test("Companion and herdr both restarted (reboot): the first tick checks", async () => {
    const { s, r } = rig(["lost"])
    expect(await r.alive()).toBe(false)
    expect(s.stops).toBe(1)
  })

  test("herdr socket unreadable: no check, no stop", async () => {
    const { s, r } = rig(["lost"])
    s.epoch = ""
    expect(await r.alive()).toBe(true)
    expect(s.identityReads).toBe(0)
  })
})
