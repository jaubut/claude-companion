import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-lead-")), "test.db")
const { createBrainLead, leadArgs } = await import("./brain-lead")
const { fakeHerdr } = await import("../lib/herdr-fake.test-util")
const { spawnInHerdr } = await import("../lib/spawn-session")

const NAME = "lead-claude-companion"

describe("repo lead", () => {
  test("spawn: its args pass the real gate, and a dead lead's stale record is cleared", async () => {
    expect(await spawnInHerdr("/srv/repo", "claude", { COMPANION_TASK_ID: NAME }, fakeHerdr().h, { name: NAME, args: leadArgs(NAME) })).toMatchObject({ ok: true })
    const stopped: string[] = []
    let taken = true
    const lead = createBrainLead({
      running: async () => false, stop: async (n) => { stopped.push(n); taken = false },
      spawn: async () => taken ? { ok: false, error: `name_taken: ${NAME}` } : { ok: true },
      shellPid: async () => "", parentPid: async () => "",
    })
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: false, state: "down" })
    expect(stopped).toEqual([NAME])
    expect(await lead.ensure("claude-companion", NAME)).toMatchObject({ ok: true, state: "started" })
  })

  test("identity: only a process under the lead pane's shell is the lead", async () => {
    const parents: Record<string, string> = { "40": "30", "30": "20", "20": "1", "90": "80", "80": "1" }
    const lead = (shell: string) => createBrainLead({
      running: async () => true, spawn: async () => ({ ok: true }), stop: async () => {},
      shellPid: async () => shell, parentPid: async (p) => parents[p] ?? "",
    })
    expect(await lead("20").verified(NAME, "40")).toBe(true)
    expect(await lead("20").verified(NAME, "90")).toBe(false)
    expect(await lead("20").verified(NAME, "20; rm")).toBe(false)
    expect(await lead("").verified(NAME, "40")).toBe(false)
  })
})
