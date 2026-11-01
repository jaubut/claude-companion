import { expect, test } from "bun:test"
import { CdpConnection } from "./cdp"

// The --remote-debugging-pipe wire: NUL-terminated JSON, replies by id, events by session.

test("frames split across chunks, replies by id, events routed to their session only", async () => {
  const sent: string[] = []
  const conn = new CdpConnection((f) => sent.push(f))
  const reply = conn.send("Runtime.evaluate", { expression: "1" }, "S1")
  expect(sent).toEqual([`${JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1" }, sessionId: "S1" })}\0`])
  const seen: unknown[] = []
  conn.on("S1", "Network.requestWillBeSent", (p) => seen.push(p.n))
  const wire = `{"method":"Network.requestWillBeSent","sessionId":"S2","params":{"n":0}}\0{"method":"Network.requestWillBeSent","sessionId":"S1","params":{"n":1}}\0{"id":1,"result":{"ok":true}}\0`
  conn.feed(wire.slice(0, 50))
  conn.feed(wire.slice(50))
  expect(await reply).toEqual({ ok: true })
  expect(seen).toEqual([1])
  conn.off("S1")
  conn.feed(`{"method":"Network.requestWillBeSent","sessionId":"S1","params":{"n":2}}\0`)
  expect(seen).toEqual([1])
})

test("a call past its deadline rejects; a dead pipe rejects pending and later calls", async () => {
  const conn = new CdpConnection(() => undefined)
  await expect(conn.send("Browser.getVersion", {}, undefined, 10)).rejects.toThrow("timed out")
  const pending = conn.send("Target.createTarget")
  conn.fail("cdp: browser exited")
  await expect(pending).rejects.toThrow("browser exited")
  await expect(conn.send("Target.createTarget")).rejects.toThrow("browser exited")
})
