import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// POST /api/spawn-session with agent "shell": request shape and cwd
// validation, refused before any tmux runs.

let handleApiRoute: (req: Request, url: URL) => Promise<Response | null>

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "api-shell-")), "test.db")
  handleApiRoute = (await import("./api")).handleApiRoute
})

async function spawn(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request("http://localhost:4245/api/spawn-session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const res = (await handleApiRoute(req, new URL(req.url)))!
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

test("shell spawn: cwd required", async () => {
  expect(await spawn({ agent: "shell" })).toEqual({ status: 400, json: { ok: false, error: "cwd required" } })
})

test("shell spawn: relative cwd refused", async () => {
  expect(await spawn({ agent: "shell", cwd: "repo" })).toEqual({ status: 400, json: { ok: false, error: "cwd must be absolute" } })
})

test("shell spawn: missing dir and a file are refused, with the path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shell-route-"))
  const file = join(dir, "f")
  writeFileSync(file, "")
  expect((await spawn({ agent: "shell", cwd: join(dir, "nope") })).json.error).toBe(`cwd does not exist: ${join(dir, "nope")}`)
  expect((await spawn({ agent: "shell", cwd: file })).json.error).toBe(`cwd is not a directory: ${file}`)
})

test("shell spawn: an injection-shaped cwd is just a path that does not exist", async () => {
  const r = await spawn({ agent: "shell", cwd: "/tmp/x'; touch /tmp/pwned; '" })
  expect(r.status).toBe(400)
  expect(String(r.json.error)).toStartWith("cwd does not exist:")
})
