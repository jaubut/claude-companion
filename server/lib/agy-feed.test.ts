import { expect, spyOn, test } from "bun:test"
import { deliverHeadlessAgyTurn } from "./agy-feed"

test("a headless agy turn spawns with no Turso, db or Companion/broker secret", () => {
  const seeded = { TURSO_AUTH_TOKEN: "t", TURSO_DATABASE_URL: "libsql://x", LIBSQL_AUTH_TOKEN: "l", DATABASE_URL: "d", COMPANION_AUTH_TOKEN: "c", BROKER_TOKEN: "b" }
  const saved = Object.fromEntries(Object.keys(seeded).map((k) => [k, process.env[k]]))
  Object.assign(process.env, seeded)
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ unref() {} })) as unknown as typeof Bun.spawn)
  try {
    expect(deliverHeadlessAgyTurn({ sessionId: "s", cwd: "/tmp", prompt: "p" })).toBe(true)
    const env = (spawn.mock.calls[0]![1] as { env: Record<string, string | undefined> }).env
    for (const k of Object.keys(seeded)) expect(env[k]).toBeUndefined()
    expect(env.CLAUDE_NO_AGENT_ENV).toBe("1")
    expect(env.PATH).toBe(process.env.PATH)
  } finally {
    spawn.mockRestore()
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
})
