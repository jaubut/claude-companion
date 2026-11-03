import { beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { ApnsPayload } from "../lib/apns"
import type { Turn, TurnCard } from "../lib/orchestrator-chat"
import { deliveryText } from "../lib/brain"
import { ALERT_TTL_MS, createWorkerBlocked, pushWithRetry } from "../lib/worker-blocked"

// Blocked dispatch worker alerts (lib/worker-blocked.ts + routes/worker-blocked.ts)
// over fakes: an in-memory turn store, a clock, captured frames and pushes. The
// route module's live wiring opens sqlite, so it gets a temp DB and is imported late.

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-worker-blocked-")), "test.db")

let route: typeof import("./worker-blocked")["workerBlockedRoute"]
let live: typeof import("./worker-blocked")["handleWorkerBlockedRoute"]
let chat: typeof import("../lib/orchestrator-chat")
beforeAll(async () => {
  const mod = await import("./worker-blocked")
  route = mod.workerBlockedRoute
  live = mod.handleWorkerBlockedRoute
  chat = await import("../lib/orchestrator-chat")
})

const DIALOG = "Bash command\n  echo {a,'b'} && curl -H 'Authorization: Bearer abc123secret'\nContains brace with quote character (expansion obfuscation). Do you want to proceed?"
const OPTIONS = [{ key: "1", label: "Yes" }, { key: "2", label: "Yes, and switch to auto mode" }, { key: "3", label: "No" }]

function harness() {
  const turns = new Map<string, Turn>()
  const frames: Array<Record<string, unknown>> = []
  const pushes: ApnsPayload[] = []
  let t = 1_000_000
  const make = () => createWorkerBlocked({
    appendTurn: (text, card) => {
      const turn: Turn = { id: randomUUID(), threadId: "brain", role: "orchestrator", text, taskId: null, createdAt: t, card }
      turns.set(turn.id, turn)
      return turn
    },
    getTurn: (id) => turns.get(id) ?? null,
    setCard: (id, patch: Partial<TurnCard>) => {
      const cur = turns.get(id)
      if (!cur?.card) return null
      const next = { ...cur, card: { ...cur.card, ...patch } }
      turns.set(id, next)
      return next
    },
    findByPostKey: (key) => [...turns.values()].find((x) => x.card?.postKey === key) ?? null,
    openIds: () => [...turns.values()].filter((x) => x.card?.kind === "worker_blocked" && x.card.state === "open").map((x) => x.id),
    broadcast: (f) => frames.push(f),
    push: (p) => pushes.push(p),
    now: () => t,
  })
  let alerts = make()
  let handle = route(alerts)
  async function call(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; json: Record<string, unknown>; replayed: boolean }> {
    const url = new URL(`http://localhost:4245${path}`)
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (key) headers["idempotency-key"] = key
    const res = await handle(new Request(url.href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), url)
    if (!res) throw new Error(`unrouted ${method} ${path}`)
    return { status: res.status, json: await res.json() as Record<string, unknown>, replayed: res.headers.get("idempotent-replayed") === "true" }
  }
  const post = (key = "runner-1", worker = "dispatch-0123abcd") =>
    call("POST", "/hooks/worker-blocked", { taskId: "0123abcd99999999", title: "Fix tax rounding", worker, dialog: DIALOG, options: OPTIONS }, key)
  // A server restart: new store instance, same persisted turns.
  const restart = () => { alerts = make(); handle = route(alerts) }
  return { turns, frames, pushes, call, post, restart, sweep: () => alerts.sweep(), advance: (ms: number) => { t += ms } }
}

test("a dialog becomes one open card without auto mode, secrets redacted, and one push", async () => {
  const h = harness()
  const r = await h.post()
  expect(r.status).toBe(201)
  expect(r.json.state).toBe("open")
  const card = h.turns.get(r.json.id as string)!.card!
  expect(card.kind).toBe("worker_blocked")
  expect(card.options).toEqual([{ id: "1", label: "Yes" }, { id: "3", label: "No" }])
  expect(card.dialog).not.toContain("abc123secret")
  expect(h.turns.get(r.json.id as string)!.text).not.toMatch(/auto mode/i)
  expect(h.frames).toHaveLength(1)
  expect(h.pushes).toHaveLength(1)
  expect(h.pushes[0]!.userInfo).toMatchObject({ kind: "worker_blocked", turnId: r.json.id })
})

test("only dispatch-<id8> workers are accepted", async () => {
  const h = harness()
  for (const w of ["cc-0123abcd", "builder-0123abcd", "tko-0123abcd", "dispatch-xyz", "dispatch-0123abcd-x"]) {
    const r = await h.post(`k-${w}`, w)
    expect(r.status).toBe(422)
    expect(r.json.error).toBe("not_dispatch_worker")
  }
  expect(h.turns.size).toBe(0)
  expect(h.pushes).toHaveLength(0)
})

test("a runner retry with the same key replays: no second card or push", async () => {
  const h = harness()
  const a = await h.post("same")
  const b = await h.post("same")
  expect(b.status).toBe(200)
  expect(b.replayed).toBe(true)
  expect(b.json.id).toBe(a.json.id)
  expect(h.turns.size).toBe(1)
  expect(h.pushes).toHaveLength(1)
})

test("one answer per dialog: first wins, same key replays, others get 409; the runner sees the key", async () => {
  const h = harness()
  const id = (await h.post()).json.id as string
  expect((await h.call("GET", `/hooks/worker-blocked/${id}`)).json).toMatchObject({ state: "open", choice: null })
  expect((await h.call("POST", `/api/orchestrator/worker-blocked/${id}/choose`, { optionId: "2" }, "p1")).json.error).toBe("unknown_option")
  const first = await h.call("POST", `/api/orchestrator/worker-blocked/${id}/choose`, { optionId: "1" }, "p1")
  expect(first.status).toBe(200)
  expect(first.json).toMatchObject({ state: "answered", choice: { key: "1", label: "Yes" } })
  const again = await h.call("POST", `/api/orchestrator/worker-blocked/${id}/choose`, { optionId: "1" }, "p1")
  expect(again.replayed).toBe(true)
  const other = await h.call("POST", `/api/orchestrator/worker-blocked/${id}/choose`, { optionId: "3" }, "p2")
  expect(other.status).toBe(409)
  expect(other.json.error).toBe("already_answered")
  expect(h.turns.get(id)!.card).toMatchObject({ state: "answered", chosen: "1" })
  expect((await h.call("GET", `/hooks/worker-blocked/${id}`)).json).toMatchObject({ state: "answered", choice: { key: "1" } })
})

test("close and TTL both expire an open card; an expired card refuses an answer", async () => {
  const h = harness()
  const a = (await h.post("a")).json.id as string
  expect((await h.call("POST", `/hooks/worker-blocked/${a}/close`)).json.state).toBe("expired")
  expect((await h.call("POST", `/api/orchestrator/worker-blocked/${a}/choose`, { optionId: "1" })).status).toBe(410)
  const b = (await h.post("b")).json.id as string
  h.advance(ALERT_TTL_MS)
  expect((await h.call("GET", `/hooks/worker-blocked/${b}`)).json.state).toBe("expired")
  expect(h.turns.get(b)!.card!.state).toBe("expired")
  expect(h.frames.at(-1)).toMatchObject({ type: "orchestrator", turn: { id: b, card: { state: "expired" } } })
})

test("an answered card stays answered when the runner closes it", async () => {
  const h = harness()
  const id = (await h.post()).json.id as string
  await h.call("POST", `/api/orchestrator/worker-blocked/${id}/choose`, { optionId: "3" })
  expect((await h.call("POST", `/hooks/worker-blocked/${id}/close`)).json).toMatchObject({ state: "answered", choice: { key: "3" } })
})

// End to end over the live wiring (sqlite turn store) and a fake herdr pane: the
// runner posts the dialog, the phone answers, the runner polls and types the key.
test("e2e: fake worker dialog → persisted card → choice → keys sent to the pane", async () => {
  const call = async (method: string, path: string, body?: unknown, key?: string) => {
    const url = new URL(`http://127.0.0.1:4245${path}`)
    const headers: Record<string, string> = { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }
    const res = (await live(new Request(url.href, { method, headers, body: body ? JSON.stringify(body) : undefined }), url))!
    return { status: res.status, json: await res.json() as Record<string, unknown> }
  }
  const pane = { name: "dispatch-85860c7f", keys: [] as string[] }
  const posted = await call("POST", "/hooks/worker-blocked", { taskId: "85860c7f00000000", title: "Alert on stuck approvals", worker: pane.name, dialog: DIALOG, options: OPTIONS }, "85860c7f:dlg1")
  const id = posted.json.id as string
  console.log("[e2e] POST alert →", posted.status, JSON.stringify(posted.json))
  console.log("[e2e] card →", JSON.stringify(chat.getTurn(id)?.card))
  const chosen = await call("POST", `/api/orchestrator/worker-blocked/${id}/choose`, { optionId: "1" }, "phone-tap-1")
  console.log("[e2e] phone choose →", chosen.status, JSON.stringify(chosen.json))
  const second = await call("POST", `/api/orchestrator/worker-blocked/${id}/choose`, { optionId: "3" }, "phone-tap-2")
  console.log("[e2e] second answer →", second.status, JSON.stringify(second.json))
  const poll = await call("GET", `/hooks/worker-blocked/${id}`)
  const choice = poll.json.choice as { key: string } | null
  if (choice) pane.keys.push(choice.key) // what the runner sends through herdr
  console.log("[e2e] runner poll →", JSON.stringify(poll.json), "· keys sent to", pane.name, JSON.stringify(pane.keys))
  expect(posted.status).toBe(201)
  expect(second.status).toBe(409)
  expect(pane.keys).toEqual(["1"])
  expect(chat.getTurn(id)?.card).toMatchObject({ kind: "worker_blocked", state: "answered", chosen: "1" })
})

test("the brain hears a sanitized brief: task, tool, short reason, no dialog text or options", async () => {
  const h = harness()
  const turn = h.turns.get((await h.post()).json.id as string)!
  const said = deliveryText([{ id: turn.id, text: turn.text, createdAt: turn.createdAt, card: turn.card, role: "orchestrator" }])
  expect(said).toContain("task 0123abcd99999999 (dispatch-0123abcd)")
  expect(said).toContain("Bash dialog")
  expect(said).toContain("never answer it, type into or drive that worker's pane")
  for (const raw of ["echo", "curl", "Authorization", "obfuscation", "1. Yes", "3. No"]) expect(said).not.toContain(raw)
})

test("older iOS builds: kind is a plain string and turn.text still carries the dialog and options", async () => {
  // Shipped decoder (claude-companion-ios BrainTrace.swift TurnCard): kind: String, unknown keys ignored,
  // the card decoded with try? — so an unknown kind never fails the turn, and text is the fallback.
  const h = harness()
  const turn = h.turns.get((await h.post()).json.id as string)!
  expect(typeof turn.card!.kind).toBe("string")
  expect(turn.text).toContain("Do you want to proceed?")
  expect(turn.text).toContain("1. Yes")
  expect(turn.text).toContain("3. No")
})

test("replay keys survive a restart: same create key replays, same answer key replays", async () => {
  const h = harness()
  const a = await h.post("runner-k")
  const id = a.json.id as string
  await h.call("POST", `/api/orchestrator/worker-blocked/${id}/choose`, { optionId: "1" }, "phone-k")
  h.restart()
  const again = await h.post("runner-k")
  expect(again.status).toBe(200)
  expect(again.json.id).toBe(id)
  expect(h.turns.size).toBe(1)
  expect(h.pushes).toHaveLength(1)
  const answer = await h.call("POST", `/api/orchestrator/worker-blocked/${id}/choose`, { optionId: "1" }, "phone-k")
  expect(answer.status).toBe(200)
  expect(answer.replayed).toBe(true)
})

test("an unread alert expires on the sweep and is re-broadcast", async () => {
  const h = harness()
  const id = (await h.post()).json.id as string
  h.sweep()
  expect(h.turns.get(id)!.card!.state).toBe("open")
  h.advance(ALERT_TTL_MS)
  h.sweep()
  expect(h.turns.get(id)!.card!.state).toBe("expired")
  expect(h.frames.at(-1)).toMatchObject({ type: "orchestrator", turn: { id, card: { state: "expired" } } })
})

test("pushWithRetry retries transient failures and stops on success or when only pruned tokens remain", async () => {
  const P: ApnsPayload = { title: "t", body: "b", category: "dispatch_task" }
  const waits: number[] = []
  const sleep = async (ms: number) => { waits.push(ms) }
  const results = [{ sent: 0, pruned: 0, total: 1 }, { sent: 1, pruned: 0, total: 1 }]
  let n = 0
  expect(await pushWithRetry(async () => { if (n++ === 0) throw new Error("net"); return results[n - 2]! }, P, sleep)).toBe(true)
  expect(n).toBe(3)
  expect(waits).toEqual([5_000, 30_000])
  let m = 0
  expect(await pushWithRetry(async () => { m++; return { sent: 0, pruned: 0, total: 1 } }, P, sleep)).toBe(false)
  expect(m).toBe(4)
  expect(await pushWithRetry(async () => ({ sent: 0, pruned: 1, total: 1 }), P, sleep)).toBe(true)
})
