import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordPeer } from "../lib/vault-guard"

// POST /api/spawn-session with agent "shell": request shape and cwd
// validation, refused before any tmux runs.

let handleApiRoute: (req: Request, url: URL) => Promise<Response | null>

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "api-shell-")), "test.db")
  handleApiRoute = (await import("./api")).handleApiRoute
})

// From loopback by default: a shell spawn is refused off the tailnet
// (lib/terminal-bridge.ts shellNetworkRefusal), checked first.
async function spawn(body: unknown, peer = "127.0.0.1"): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request("http://localhost:4245/api/spawn-session", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  recordPeer(req, peer)
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

test("shell spawn: resume must be a session id, checked before the cwd", async () => {
  expect(await spawn({ agent: "shell", cwd: "/tmp", resume: "x; rm -rf ~" })).toEqual({ status: 400, json: { ok: false, error: "bad_resume" } })
  expect(await spawn({ agent: "shell", cwd: "/tmp", resume: 42 })).toEqual({ status: 400, json: { ok: false, error: "bad_resume" } })
})

test("shell spawn: refused from the LAN before anything else is looked at", async () => {
  expect(await spawn({ agent: "shell", cwd: "/tmp" }, "192.168.2.40")).toEqual({ status: 403, json: { ok: false, error: "network_refused" } })
})

// repo + seed (Brain ▸ Queue "Open in a new session"): validated before any spawn.
test("agent spawn: seed and repo are refused on a shell spawn", async () => {
  expect(await spawn({ agent: "shell", cwd: "/tmp", seed: "hi" })).toEqual({ status: 400, json: { ok: false, error: "agent_only" } })
  expect(await spawn({ agent: "shell", repo: "x" })).toEqual({ status: 400, json: { ok: false, error: "agent_only" } })
})

test("agent spawn: a bad or over-cap seed is a 400 before anything starts", async () => {
  expect(await spawn({ cwd: "/tmp", seed: 7 })).toEqual({ status: 400, json: { ok: false, error: "bad_seed" } })
  expect(await spawn({ cwd: "/tmp", seed: "x".repeat(4001) })).toEqual({ status: 400, json: { ok: false, error: "seed_too_long" } })
})

test("agent spawn: a repo must be a plain name, and one with no checkout here is a 409", async () => {
  expect(await spawn({ repo: "../etc" + "/x" })).toEqual({ status: 400, json: { ok: false, error: "bad_repo" } })
  expect(await spawn({ repo: "a b" })).toEqual({ status: 400, json: { ok: false, error: "bad_repo" } })
  expect(await spawn({ repo: 3 })).toEqual({ status: 400, json: { ok: false, error: "bad_repo" } })
  expect(await spawn({ repo: "no-such-repo-anywhere-zz" })).toEqual({ status: 409, json: { ok: false, error: "no_checkout", repo: "no-such-repo-anywhere-zz" } })
})
