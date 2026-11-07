import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordPeer } from "../lib/vault-guard"
import type { ShellSession } from "../lib/shell-sessions"

// POST /api/shell/close: request shape, the shell-list gate and auth. tmux
// points at a private -L server that never runs, so a kill reaches nothing;
// the kill itself is covered with a fake tmux in lib/shell-sessions.test.ts.

let handleApiRoute: (req: Request, url: URL) => Promise<Response | null>
let shells: typeof import("../lib/shell-sessions")
let sessions: typeof import("../lib/sessions")

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "api-shell-close-")), "test.db")
  process.env.COMPANION_TMUX_SOCKET = `cc-close-test-${process.pid}-${Date.now()}`
  process.env.HERDR_BIN = "false" // never the host's herdr
  process.env.COMPANION_AUTH_TOKEN ??= "shell-close-test-token-0123456789"
  handleApiRoute = (await import("./api")).handleApiRoute
  shells = await import("../lib/shell-sessions")
  sessions = await import("../lib/sessions")
})

afterAll(() => {
  shells.store.replace([])
  delete process.env.COMPANION_TMUX_SOCKET
  delete process.env.HERDR_BIN
})

const shell = (name: string, pane: string, claudeKey = ""): ShellSession => ({
  key: `shell:${name}`, name, cwd: "/tmp", workspaceId: "", herdrPane: "", terminalId: "", tmuxPane: pane, tmuxSocket: "/tmp/tmux-1000/cc", createdAt: 1, panePid: 0, claudeKey,
})

async function close(body: unknown, peer = "127.0.0.1"): Promise<{ status: number; json: Record<string, unknown> }> {
  const req = new Request("http://localhost:4245/api/shell/close", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  recordPeer(req, peer)
  const res = (await handleApiRoute(req, new URL(req.url)))!
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

test("close: name required, a string, bounded", async () => {
  expect(await close({})).toEqual({ status: 400, json: { ok: false, error: "bad_name" } })
  expect(await close({ name: 7 })).toEqual({ status: 400, json: { ok: false, error: "bad_name" } })
  expect(await close({ name: "x".repeat(201) })).toEqual({ status: 400, json: { ok: false, error: "bad_name" } })
})

test("close: refused from the LAN like a shell spawn", async () => {
  expect(await close({ name: "sh-x" }, "192.168.2.40")).toEqual({ status: 403, json: { ok: false, error: "network_refused" } })
})

test("close: a name not in the shell list is a 404", async () => {
  shells.store.replace([shell("sh-work", "%1")])
  expect(await close({ name: "no-such-shell" })).toEqual({ status: 404, json: { ok: false, error: "unknown_shell" } })
})

test("close: Claude panes, dispatch-* workers, the brain and herdr are not in the shell list → 404", async () => {
  shells.store.replace([shell("sh-work", "%1")])
  for (const name of ["cc-claude-companion", "dispatch-abc123", "brain", "herdr", "shell:sh-work"]) {
    expect(await close({ name })).toEqual({ status: 404, json: { ok: false, error: "unknown_shell" } })
  }
  expect(shells.listShellSessions().map((s) => s.name)).toEqual(["sh-work"])
})

test("close: a shell with a Claude running in it is refused (409), linked or on its pane now", async () => {
  shells.store.replace([shell("sh-linked", "%2", "claude:abc"), shell("sh-pane", "%3")])
  expect(await close({ name: "sh-linked" })).toEqual({ status: 409, json: { ok: false, error: "claude_running" } })
  const agent = sessions.recordSession({ cwd: "/tmp", tmuxPane: "%3", tmuxSocket: "/tmp/tmux-1000/cc", tty: "/dev/pts/shell-close-test" })!
  try {
    expect(await close({ name: "sh-pane" })).toEqual({ status: 409, json: { ok: false, error: "claude_running" } })
  } finally { sessions.removeSessionByKey(agent.key) }
  expect(shells.listShellSessions().map((s) => s.name)).toEqual(["sh-linked", "sh-pane"])
})

test("close: a listed shell already gone from tmux → ok gone:true, row dropped and broadcast; retry is gone:true too", async () => {
  shells.store.replace([shell("sh-old", "%4")])
  const seen: string[][] = []
  const off = shells.onShellSessions((list) => seen.push(list.map((s) => s.name)))
  try {
    expect(await close({ name: "sh-old" })).toEqual({ status: 200, json: { ok: true, gone: true } })
  } finally { off() }
  expect(seen).toEqual([[]])
  expect(await close({ name: "sh-old" })).toEqual({ status: 200, json: { ok: true, gone: true } })
})

test("close: the /api gate requires the bearer", async () => {
  const { createCompanionServer } = await import("../companion-server")
  const { getAuthToken } = await import("../lib/auth")
  const server = createCompanionServer(0)
  try {
    const url = `http://127.0.0.1:${server.port}/api/shell/close`
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "no-such-shell" }) }
    expect((await fetch(url, init)).status).toBe(401)
    const ok = await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${getAuthToken()}` } })
    expect(ok.status).toBe(404)
  } finally {
    server.stop(true)
  }
})
