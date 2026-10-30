import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getPending, resolveApproval } from "../lib/pty-manager"
import { useLearnedAllowDb } from "../lib/learned-allow"
import { setSuperAutoInMemoryForTests, isSuperAuto } from "../lib/super-auto"
import { clients } from "../state"

// Answered at the terminal → the phone card clears (PRJ-48BS #2). Claude Code
// ends a waiting approval hook when the prompt is answered in the terminal.
// The REAL hook scripts run against the REAL route behind a real Bun.serve:
// when bash gets SIGTERM (or its whole process group does), its curl must go
// too, so the server sees the request abort and ends the card "elsewhere"
// (hook_gone). Before the fix bash died alone and the orphaned curl held the
// request open until the 290 s expiry. The script still exits 0, silent.

const HOOKS = join(import.meta.dir, "..", "..", "hooks")
const superWas = isSuperAuto()
const frames: Array<Record<string, unknown>> = []
const fake = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Parameters<typeof clients.add>[0]
let server: ReturnType<typeof Bun.serve>

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-term-"))
  process.env.COMPANION_DB_PATH = join(dir, "test.db")
  useLearnedAllowDb(join(dir, "learned.db"))
  await import("../wiring/events")
  const { handleHookRoute } = await import("./hooks")
  clients.add(fake)
  setSuperAutoInMemoryForTests(false)
  server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return Response.json({ ok: true })
      return (await handleHookRoute(req, url)) ?? new Response("nope", { status: 404 })
    },
  })
})
afterAll(() => {
  server.stop(true)
  setSuperAutoInMemoryForTests(superWas)
  clients.delete(fake)
})

const resolvedFor = (id: string) => frames.filter((f) => f.type === "resolved" && f.id === id).map((f) => f.decision)

function spawnHook(script: string, sessionId: string) {
  const env: Record<string, string | undefined> = { ...process.env, COMPANION_URL: `http://127.0.0.1:${server.port}` }
  delete env.DISPATCH_HEADLESS
  delete env.COMPANION_SCRAPE
  delete env.CLAUDE_CODE_SCRAPE_SESSION
  const body = { session_id: sessionId, tool_name: "Bash", tool_input: { command: `zz-term ${sessionId}` }, cwd: `/tmp/${sessionId}` }
  return Bun.spawn(["bash", join(HOOKS, script)], {
    env,
    stdin: new TextEncoder().encode(JSON.stringify(body)),
    stdout: "pipe",
    stderr: "pipe",
    // Own process group, so the group-kill case can signal -pid.
    detached: true,
  })
}

async function waitPending(sessionId: string) {
  for (let i = 0; i < 400; i++) {
    const r = getPending().find((x) => x.sessionId === sessionId)
    if (r) return r
    await Bun.sleep(10)
  }
  throw new Error("approval never reached the phone")
}

async function waitGone(id: string, ms = 3000): Promise<number> {
  const t0 = performance.now()
  while (performance.now() - t0 < ms) {
    if (!getPending().some((x) => x.id === id)) return performance.now() - t0
    await Bun.sleep(10)
  }
  return Infinity
}

for (const script of ["companion-permission.sh", "companion-approval.sh"]) {
  for (const target of ["bash", "group"] as const) {
    test(`${script}: SIGTERM to ${target === "bash" ? "bash alone" : "the process group"} → hook_gone, card ends 'elsewhere', exit 0, no output`, async () => {
      const sid = `term-${script.replace(/\W/g, "")}-${target}`
      const p = spawnHook(script, sid)
      const r = await waitPending(sid)
      process.kill(target === "bash" ? p.pid : -p.pid, "SIGTERM")
      expect(await waitGone(r.id)).toBeLessThan(3000)
      expect(resolvedFor(r.id)).toEqual(["elsewhere"])
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
      expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" })
    }, 10_000)
  }
}

test("control: a phone allow still reaches Claude Code through the real script", async () => {
  const p = spawnHook("companion-permission.sh", "term-allow")
  expect(resolveApproval((await waitPending("term-allow")).id, "allow")).toBe(true)
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
  expect(code).toBe(0)
  expect(JSON.stringify(JSON.parse(out))).toContain("allow")
}, 10_000)
