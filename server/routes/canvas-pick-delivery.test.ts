import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realHerdr } from "../lib/herdr"
import { keyGate } from "../lib/key-gate"
import * as keyboard from "../lib/keyboard-inject"
import * as submit from "../lib/submit-confirm"
import * as context from "../lib/canvas"
import { recordSession, removeSessionByKey } from "../lib/sessions"
import * as dialogs from "../wiring/dialogs"
import { createCanvasRoute } from "./canvas"
import { deliverInject } from "./api"

process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "canvas-pick-lock-")), "test.db")
let canvas: typeof import("../wiring/canvas")

beforeAll(async () => { canvas = await import("../wiring/canvas") })
afterAll(() => { for (const n of canvas.canvasStore.nodes()) canvas.canvasStore.removeNode(n.id) })

for (const waitAt of ["pane", "herdr keyboard", "tmux keyboard"] as const) test(`pick: tty reused during the ${waitAt} lock wait types nothing and releases the claim`, async () => {
  const tmux = waitAt === "tmux keyboard"
  const meta = { cwd: "/tmp/canvas-pick-lock", tty: "/dev/pts/987", ...(tmux ? { tmuxPane: "%987" } : { herdrPane: "w987:p1" }) }
  const original = recordSession({ ...meta, sessionId: "sid-before-wait" }, { sessionIdConfirmed: true })!
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const pickWaiting = Promise.withResolvers<void>()
  const typed: string[] = []
  const injectConfirmed = submit.injectConfirmed
  const injectText = keyboard.injectText
  const gateSend = keyGate.send
  const spies = [
    spyOn(dialogs, "yieldPaneForInject").mockResolvedValue(true),
    spyOn(dialogs, "openDialogFor").mockResolvedValue(null),
    spyOn(dialogs, "screenSnapshotFor").mockResolvedValue(undefined),
    spyOn(dialogs, "paneWidthFor").mockResolvedValue(undefined),
    spyOn(submit, "injectConfirmed").mockImplementation((...args) => {
      const pending = injectConfirmed(...args)
      if (waitAt === "pane") pickWaiting.resolve()
      return pending
    }),
    spyOn(keyGate, "send").mockImplementation((...args) => {
      const pending = gateSend(...args)
      if (waitAt !== "pane" && args[1] === "Enter") pickWaiting.resolve()
      return pending
    }),
    // Only replace the external tmux process; its delivery lock and final guard stay real.
    spyOn(keyboard, "injectText").mockImplementation((text, target, opts) => injectText(text, target, {
      ...opts, sendKeys: async (args) => {
        if (args.includes("-l")) typed.push(args.at(-1)!)
        else submit.noteUserPromptSubmit({ tty: meta.tty }, text)
        return { ok: true, reason: "" }
      },
    })),
    spyOn(realHerdr, "call").mockImplementation(async (args) => {
      if (args[0] === "agent" && args[1] === "prompt") {
        if (args[3] === "earlier prompt") { entered.resolve(); await release.promise }
        else typed.push(args[3]!)
        submit.noteUserPromptSubmit({ tty: meta.tty }, args[3])
      }
      return {}
    }),
  ]
  canvas.setCanvasDeliver(deliverInject)
  const route = createCanvasRoute({
    store: canvas.canvasStore, status: () => ({}), host: "test", notify: () => {},
    send: canvas.canvasSend, pickNotify: canvas.canvasPickNotify, references: () => [], query: async () => [],
  })
  const node = canvas.canvasStore.addNode({
    kind: "preview", ref: "http://localhost/direction.html", x: 0, y: 0, w: 1, h: 1,
    data: { direction: "bold", group: "lock-wait", sessionKey: original.key },
  }, 1).node
  const pick = async () => {
    const req = new Request(`http://localhost/api/canvas/nodes/${node.id}/pick`, { method: "POST", body: "{}" })
    return (await route(req, new URL(req.url)))!
  }
  const earlier = waitAt === "pane" ? injectConfirmed("earlier prompt", original)
    : keyGate.send(tmux ? "%987" : "herdr|w987:p1", "Down", async () => { entered.resolve(); await release.promise })
  let pending: Promise<Response> | undefined
  try {
    await entered.promise // An earlier delivery holds the real pane or keyboard lock.
    pending = pick()
    await pickWaiting.promise // Initial binding check and async inject guards have passed.
    expect(typed).toEqual([])
    removeSessionByKey(original.key)
    const replacement = recordSession({ ...meta, sessionId: "sid-after-wait" }, { sessionIdConfirmed: true })!
    expect(replacement.key).toBe(original.key)
    release.resolve()
    await earlier
    const response = await pending
    expect(typed).toEqual([])
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false, error: "target_changed", delivered: false })
    expect(canvas.canvasStore.node(node.id)?.data.picked).toBe(true)

    // Restoring the bound agent proves the failed claim is retryable, not stuck sending/sent.
    removeSessionByKey(original.key)
    recordSession({ ...meta, sessionId: "sid-before-wait" }, { sessionIdConfirmed: true })
    const retry = await pick()
    expect(await retry.json()).toMatchObject({ ok: true, delivered: true })
    expect(typed).toEqual(["Picked direction: bold — http://localhost/direction.html"])
  } finally {
    release.resolve()
    await earlier
    await pending
    for (const spy of spies) spy.mockRestore()
    canvas.canvasStore.removeNode(node.id)
    removeSessionByKey(original.key)
  }
})

for (const edgeSend of [false, true]) for (const guarded of [false, true]) {
  test(`${edgeSend ? "edge /send" : "shared /send"}: ${guarded ? "opt-in guard refuses a reused tty" : "omitting the callback preserves main behavior"}`, async () => {
    const meta = { cwd: "/tmp/canvas-send-default", tty: "/dev/pts/989", herdrPane: "w989:p1" }
    const original = recordSession({ ...meta, sessionId: "send-before" }, { sessionIdConfirmed: true })!
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const typed: string[] = []
    const spies = [
      spyOn(dialogs, "yieldPaneForInject").mockImplementation(async () => { entered.resolve(); await release.promise; return true }),
      spyOn(dialogs, "openDialogFor").mockResolvedValue(null),
      spyOn(dialogs, "screenSnapshotFor").mockResolvedValue(undefined),
      spyOn(dialogs, "paneWidthFor").mockResolvedValue(undefined),
      spyOn(context, "contextPrompt").mockResolvedValue({ ok: true, text: "edge prompt" }),
      spyOn(realHerdr, "call").mockImplementation(async (args) => {
        if (args[1] === "prompt") { typed.push(args[3]!); submit.noteUserPromptSubmit({ tty: meta.tty }, args[3]) }
        return {}
      }),
    ]
    canvas.setCanvasDeliver(deliverInject)
    const from = canvas.canvasStore.addNode({ kind: "task", ref: "task-send", x: 0, y: 0, w: 1, h: 1, data: {} }, 1).node
    const to = canvas.canvasStore.addNode({ kind: "agent", ref: original.key, x: 0, y: 0, w: 1, h: 1, data: {} }, 1).node
    const edge = canvas.canvasStore.addEdge({ kind: "context", from: from.id, to: to.id }, 1)
    if (!edge.ok) throw new Error(edge.error)
    const route = createCanvasRoute({ store: canvas.canvasStore, status: () => ({}), host: "test", notify: () => {},
      send: (e) => canvas.canvasSend(e, guarded ? () => true : undefined), pickNotify: canvas.canvasPickNotify,
      references: () => [], query: async () => [] })
    const req = new Request(`http://localhost/api/canvas/edges/${edge.edge.id}/send`, { method: "POST" })
    const pending = edgeSend ? route(req, new URL(req.url))
      : deliverInject("phone prompt", original.key, undefined, guarded ? original.sessionId : undefined, guarded ? () => true : undefined)
    try {
      await entered.promise
      removeSessionByKey(original.key)
      recordSession({ ...meta, sessionId: "send-after" }, { sessionIdConfirmed: true })
      release.resolve()
      const response = (await pending)!
      expect(response.status).toBe(guarded ? 409 : 200)
      expect(await response.json()).toMatchObject(guarded ? { ok: false, error: "target_changed" } : { ok: true })
      expect(typed).toEqual(guarded ? [] : [edgeSend ? "edge prompt" : "phone prompt"])
      if (edgeSend) expect(canvas.canvasStore.edge(edge.edge.id)?.state).toBe(guarded ? "failed" : "sent")
      if (guarded && edgeSend) {
        canvas.canvasStore.patchNode(to.id, { ref: original.key }, 2)
        expect(await (await route(req, new URL(req.url)))!.json()).toMatchObject({ ok: true, edge: { state: "sent" } })
        expect(typed).toEqual(["edge prompt"])
      }
    } finally {
      release.resolve()
      await pending
      for (const spy of spies) spy.mockRestore()
      for (const node of [from, to]) canvas.canvasStore.removeNode(node.id)
      removeSessionByKey(original.key)
    }
  })
}

for (const waitAt of ["preflight", "keyboard"] as const) test(`pick: group move during ${waitAt} suppresses stale A after picking B`, async () => {
  const meta = { cwd: "/tmp/canvas-group-wait", tty: "/dev/pts/988", herdrPane: "w988:p1", sessionId: "group-sid" }
  const session = recordSession(meta, { sessionIdConfirmed: true })!
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const waiting = Promise.withResolvers<void>()
  const typed: string[] = []
  let first = true
  const gateSend = keyGate.send
  const spies = [
    spyOn(dialogs, "yieldPaneForInject").mockImplementation(async () => {
      if (first && waitAt === "preflight") { first = false; entered.resolve(); await release.promise }
      return true
    }),
    spyOn(dialogs, "openDialogFor").mockResolvedValue(null),
    spyOn(dialogs, "screenSnapshotFor").mockResolvedValue(undefined),
    spyOn(dialogs, "paneWidthFor").mockResolvedValue(undefined),
    spyOn(keyGate, "send").mockImplementation((...args) => {
      const result = gateSend(...args)
      if (args[1] === "Enter") waiting.resolve()
      return result
    }),
    spyOn(realHerdr, "call").mockImplementation(async (args) => {
      if (args[1] === "prompt") { typed.push(args[3]!); submit.noteUserPromptSubmit({ tty: meta.tty }, args[3]) }
      return {}
    }),
  ]
  canvas.setCanvasDeliver(deliverInject)
  const route = createCanvasRoute({ store: canvas.canvasStore, status: () => ({}), host: "test", notify: () => {},
    send: canvas.canvasSend, pickNotify: canvas.canvasPickNotify, references: () => [], query: async () => [] })
  const nodes = ["A", "B"].map((direction) => canvas.canvasStore.addNode({ kind: "preview", ref: `http://localhost/${direction}`,
    x: 0, y: 0, w: 1, h: 1, data: { direction, group: direction, sessionKey: session.key } }, 1).node)
  const call = async (id: string, method: string, suffix = "", data = {}) => {
    const req = new Request(`http://localhost/api/canvas/nodes/${id}${suffix}`, { method, body: JSON.stringify(data) })
    return (await route(req, new URL(req.url)))!
  }
  const held = waitAt === "keyboard" ? keyGate.send("herdr|w988:p1", "Down", async () => { entered.resolve(); await release.promise }) : null
  let a: Promise<Response> | undefined
  let b: Promise<Response> | undefined
  try {
    a = call(nodes[0]!.id, "POST", "/pick")
    await entered.promise
    if (held) await waiting.promise
    expect((await call(nodes[0]!.id, "PATCH", "", { data: { direction: "A", group: "B" } })).status).toBe(200)
    b = call(nodes[1]!.id, "POST", "/pick")
    if (!held) expect(await (await b).clone().json()).toMatchObject({ ok: true, delivered: true })
    release.resolve()
    await held
    expect(await (await a).json()).toMatchObject({ ok: true, delivered: false })
    expect(await (await b).json()).toMatchObject({ ok: true, delivered: true })
    expect(typed).toEqual(["Picked direction: B — http://localhost/B"])
    expect(await (await call(nodes[0]!.id, "POST", "/pick")).json()).toMatchObject({ ok: true, delivered: true })
    expect(typed).toEqual(["Picked direction: B — http://localhost/B", "Picked direction: A — http://localhost/A"])
  } finally {
    release.resolve()
    await Promise.all([held, a, b])
    for (const spy of spies) spy.mockRestore()
    for (const node of nodes) canvas.canvasStore.removeNode(node.id)
    removeSessionByKey(session.key)
  }
})
