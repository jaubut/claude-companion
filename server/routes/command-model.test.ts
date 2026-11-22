import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAuthToken } from "../lib/auth"
import { type Session, recordSession } from "../lib/sessions"

// /api/command/list, /api/command/suggest and /api/model/open|set for a desk
// row, through the real server (auth gate, route chain). The command list is
// fed by a canned init line (a desk turn's system/init), never a pane.

const dir = mkdtempSync(join(tmpdir(), "command-model-"))
process.env.COMPANION_DB_PATH ??= join(dir, "test.db")
process.env.COMPANION_AUTH_TOKEN ??= "command-model-token-0123456789abcdef"
const TOKEN = getAuthToken()
let server: { port: number; stop(force?: boolean): void }
let row: Session
let deskRunner: typeof import("../wiring/desk-deliver").deskRunner

const INIT_LINE = JSON.stringify({
  type: "system", subtype: "init", session_id: "cm-sid", slash_commands: ["clear", "compact", "model", "review", "caveman:caveman"],
  skills: ["review", "caveman:caveman"], claude_code_version: "2.1.327",
})

beforeAll(async () => {
  const { createCompanionServer } = await import("../companion-server")
  server = createCompanionServer(0) as unknown as { port: number; stop(force?: boolean): void }
  ;({ deskRunner } = await import("../wiring/desk-deliver"))
  deskRunner.override({ stateFile: join(dir, "desk.json") })
  const { commandCatalog } = await import("../lib/command-catalog")
  commandCatalog.useFile(join(dir, "commands.json"))
  commandCatalog.noteLine(dir, INIT_LINE)
  row = recordSession({ cwd: dir, agent: "claude", sessionId: "cm-sid", herdrPane: "headless:desk:cm-sid", model: "claude-opus-5-5[1m]" }, { sessionIdConfirmed: true })!
})
afterAll(() => server.stop(true))

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

test("command list: the init-derived catalog, every entry with a kind, warm in < 50 ms", async () => {
  const t0 = performance.now()
  const r = await post("/api/command/list", { key: row.key })
  expect(performance.now() - t0).toBeLessThan(50)
  expect(r.status).toBe(200)
  expect(r.body).toMatchObject({ ok: true, key: row.key, cached: true })
  const commands = r.body.commands as Array<{ name: string; kind: string }>
  expect(commands.map((c) => c.name)).toEqual(["/clear", "/compact", "/model", "/review", "/caveman:caveman"])
  expect(commands.find((c) => c.name === "/review")?.kind).toBe("custom")
  expect(commands.find((c) => c.name === "/compact")?.kind).toBe("default")
})

test("suggest: filtered from the catalog, source list; unknown key 410; bad prefix 400", async () => {
  expect(await post("/api/command/suggest", { key: row.key, prefix: "c" })).toEqual({ status: 200, body: {
    ok: true, key: row.key, prefix: "c", source: "list",
    commands: [{ name: "/clear", description: "" }, { name: "/compact", description: "" }, { name: "/caveman:caveman", description: "" }],
  } })
  expect((await post("/api/command/suggest", { key: "claude:sid:nope", prefix: "c" })).status).toBe(410)
  expect((await post("/api/command/suggest", { key: row.key, prefix: "a b;" })).status).toBe(200)
  expect((await post("/api/command/suggest", { key: row.key, prefix: "$x" })).status).toBe(400)
})

test("model open/set: one claude-only list (no auto), index round-trips, current on the base id, no agent flip", async () => {
  const open = await post("/api/model/open", { key: row.key })
  expect(open.status).toBe(200)
  const choices = open.body.choices as Array<{ index: number; text: string; current: boolean }>
  expect(choices.some((c) => c.text.startsWith("Auto"))).toBe(false)
  expect(choices.some((c) => c.text.startsWith("GPT"))).toBe(false)
  expect(choices.find((c) => c.current)?.text).toStartWith("Opus 5.5")
  const sonnet = choices.find((c) => c.text.startsWith("Sonnet 5.5"))!
  const set = await post("/api/model/set", { key: row.key, index: sonnet.index, scope: "session" })
  expect(set).toEqual({ status: 200, body: { ok: true, key: row.key, scope: "session", chosen: { index: sonnet.index, text: sonnet.text, current: true } } })
  expect(deskRunner.modelFor("cm-sid")).toBe("claude-sonnet-5-5")
  const again = await post("/api/model/open", { key: row.key })
  expect((again.body.choices as typeof choices).find((c) => c.current)?.index).toBe(sonnet.index)
  expect((await post("/api/model/set", { key: row.key, index: 99 })).status).toBe(400)
  const { getSessionByKey, removeSessionByKey } = await import("../lib/sessions")
  expect(getSessionByKey(row.key)?.agent).toBe("claude")

  const gemRow = recordSession({ cwd: dir, agent: "gemini", sessionId: "gm-sid", taskId: "gm-task", herdrPane: "headless:worker:gm-task", model: "" }, { sessionIdConfirmed: true })!
  const gemOpen = await post("/api/model/open", { key: gemRow.key })
  expect(gemOpen.status).toBe(200)
  const gemChoices = gemOpen.body.choices as Array<{ index: number; text: string; current: boolean }>
  expect(gemChoices.find((c) => c.current)?.text).toStartWith("Gemini 4 Argon (High)")
  removeSessionByKey(gemRow.key)
})
