import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realHerdr } from "../lib/herdr"
import { keyGate } from "../lib/key-gate"
import * as keyboard from "../lib/keyboard-inject"
import * as submit from "../lib/submit-confirm"
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
