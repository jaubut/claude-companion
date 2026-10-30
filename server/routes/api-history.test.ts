import { test, expect } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// GET /api/sessions/history: a restarted server (empty feed) still gives a
// listed session's chat back, read from the transcript the session record
// names. Only a listed key resolves; the request never carries a path.
//
// Runs in a child process: the transcript dir comes from $HOME, which a test
// cannot change for its own process (os.homedir() keeps the startup value).

const SID = "0d5ab3a1-2c4e-4f60-8a7b-9c1d2e3f4a5b"
const CWD = "/home/aubut/work"

const script = `
const { recordSession } = await import(${JSON.stringify(join(import.meta.dir, "../lib/sessions"))})
const { handleApiRoute } = await import(${JSON.stringify(join(import.meta.dir, "api"))})
const key = recordSession({ cwd: ${JSON.stringify(CWD)}, sessionId: ${JSON.stringify(SID)}, tty: "/dev/pts/44", agent: "claude" }, { sessionIdConfirmed: true }).key
const out = []
for (const k of [key, "claude:tty:/dev/pts/99", "../../etc/passwd", ""]) {
  const url = new URL("http://localhost:4245/api/sessions/history?key=" + encodeURIComponent(k))
  const res = await handleApiRoute(new Request(url), url)
  out.push({ status: res.status, json: await res.json() })
}
console.log("RESULT" + JSON.stringify({ key, out }))
process.exit(0)
`

test("history: rows from the transcript on a fresh feed; unlisted keys 404", async () => {
  const home = mkdtempSync(join(tmpdir(), "api-history-"))
  const dir = join(home, ".claude", "projects", CWD.replace(/\//g, "-"))
  mkdirSync(dir, { recursive: true })
  const at = new Date(Date.now() - 3_600_000).toISOString()
  writeFileSync(join(dir, `${SID}.jsonl`), [
    { type: "user", uuid: "u1", timestamp: at, message: { role: "user", content: "price the chalet" } },
    { type: "assistant", uuid: "u2", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: "About 8% over comps." }] } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n")
  const proc = Bun.spawn(["bun", "-e", script], {
    env: { ...process.env, HOME: home, COMPANION_DB_PATH: join(home, "test.db") },
    stdout: "pipe", stderr: "ignore",
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT"))
  expect(line).toBeDefined()
  const { key, out } = JSON.parse(line!.slice(6)) as { key: string; out: Array<{ status: number; json: { key?: string; events?: Array<{ kind: string; text?: string; id: string }> } }> }
  expect(out[0]!.status).toBe(200)
  expect(out[0]!.json.key).toBe(key)
  expect(out[0]!.json.events!.map((e) => [e.kind, e.text])).toEqual([["user_prompt", "price the chalet"], ["assistant_text", "About 8% over comps."]])
  expect(out[0]!.json.events!.map((e) => e.id)).toEqual([`tx:${SID}:u1:0`, `tx:${SID}:u2:0`])
  for (const r of out.slice(1)) expect(r).toEqual({ status: 404, json: { ok: false, error: "unknown_session" } } as never)
}, 20_000)
