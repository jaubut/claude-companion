import { test, expect, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HerdrSocketError, herdrSocketCall } from "./herdr-socket"

// A fake herdr: one NDJSON reply per connection, then close (herdr 0.9.5).
const dir = mkdtempSync(join(tmpdir(), "herdr-sock-"))
const path = join(dir, "h.sock")
const seen: unknown[] = []
const server = Bun.listen({
  unix: path,
  socket: {
    data(s, d) {
      const req = JSON.parse(d.toString().trim()) as { id: string; method: string; params: Record<string, unknown> }
      seen.push(req)
      if (req.method === "slow") return
      const body = req.method === "boom"
        ? { id: req.id, error: { code: "pane_not_found", message: "no pane" } }
        : { id: req.id, result: { type: "pane_read", read: { text: "hi\r\n" } } }
      s.write(JSON.stringify(body) + "\n")
      s.end()
    },
  },
})
afterAll(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }) })

test("socket: one request, its result (the reply closes the connection; that close is not an error)", async () => {
  const r = await herdrSocketCall("pane.read", { pane_id: "w1:p1", source: "visible", format: "ansi" }, { socketPath: path })
  expect(r).toEqual({ type: "pane_read", read: { text: "hi\r\n" } })
  expect(seen.at(-1)).toMatchObject({ method: "pane.read", params: { pane_id: "w1:p1" } })
})

test("socket: herdr's error code is kept; silence times out; no socket fails to connect", async () => {
  const codeOf = (p: Promise<unknown>) => p.then(() => "ok", (e: HerdrSocketError) => e.code)
  expect(await codeOf(herdrSocketCall("boom", {}, { socketPath: path }))).toBe("pane_not_found")
  expect(await codeOf(herdrSocketCall("slow", {}, { socketPath: path, timeoutMs: 50 }))).toBe("timeout")
  expect(await codeOf(herdrSocketCall("x", {}, { socketPath: join(dir, "none.sock") }))).toBe("connect_failed")
})
