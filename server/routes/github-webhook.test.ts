import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHmac } from "node:crypto"
import { buildGithubIssueTaskId } from "../lib/github-webhook"
import { createGithubWebhookStore } from "../lib/github-webhook-store"
import type { SupervisedTaskSnapshot } from "../lib/worker-supervisor"
import { createGithubWebhookDispatcher } from "../wiring/github-webhook"
import { createGithubWebhookRoute } from "./github-webhook"

const SECRET = "test-github-webhook-secret-987654321"
const ID = buildGithubIssueTaskId("jaubut/ndi-tx-enclosure", 1)
const databases: Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })

function issuePayload(action = "opened", label?: string, number = 1) {
  return { action, ...(label ? { label: { name: label } } : {}), sender: { login: "jaubut" },
    repository: { full_name: "jaubut/ndi-tx-enclosure", name: "ndi-tx-enclosure", owner: { login: "jaubut" } },
    issue: { number, user: { login: "jaubut" }, state: "open", title: "Build enclosure", body: "Implement CAD_SPEC.md", labels: [] } }
}

function snapshot(taskId = ID, status: SupervisedTaskSnapshot["status"] = "running"): SupervisedTaskSnapshot {
  return { taskId, repo: "ndi-tx-enclosure", title: "Build enclosure", builder: "test", family: "claude", model: null,
    branch: `dispatch/${taskId}`, worktree: "/tmp/test", sessionId: "test", status, turnCount: 1, step: "Starting", pct: 0,
    result: "", prUrl: null, error: null, startedAt: 1, updatedAt: 1, completedAt: null }
}

function world(db = new Database(":memory:")) {
  databases.push(db)
  const store = createGithubWebhookStore(db)
  const calls: Array<Record<string, unknown>> = [], comments: string[][] = [], brain: string[] = [], logs: string[] = [], filed: string[] = []
  const workers: SupervisedTaskSnapshot[] = []
  let branches: string[] = [], ghDown = false, commentDown = false, fileDown = false, uncertain = false
  const deps = {
    localHost: "zettlab", env: {}, store, autoDrain: false, log: (s: string) => logs.push(s),
    listLocalTasks: () => workers,
    listHostTasks: async (_host: string) => workers,
    brainReceipt: (s: string) => { brain.push(s) },
    tasks: {
      prepare: async (req: { taskId: string }) => { if (fileDown) throw new Error("db down"); filed.push(req.taskId); return { claim: "test-claim", settled: false } },
      start: async (_id: string) => true, defer: async (_id: string) => {},
    },
    gh: async (args: string[]) => {
      if (args[0] === "pr") return { code: ghDown ? 1 : 0, stdout: JSON.stringify(branches.map((headRefName) => ({ headRefName }))), stderr: "" }
      if (args[0] === "api") return { code: 0, stdout: "", stderr: "" }
      comments.push(args)
      return { code: commentDown ? 1 : 0, stdout: "", stderr: "" }
    },
    callMcpDispatch: async (args: Record<string, unknown>) => {
      calls.push(args)
      if (uncertain) return { ok: false, error: "peer_unreachable: timeout" }
      const task = snapshot(String(args.task_id))
      workers.push(task)
      return { ok: true, host: "zettlab", task }
    },
  }
  const dispatcher = createGithubWebhookDispatcher(deps)
  return { dispatcher, deps, store, workers, calls, comments, brain, logs, filed,
    cap: (v: string[]) => { branches = v }, ghDown: (v: boolean) => { ghDown = v }, commentDown: (v: boolean) => { commentDown = v },
    fileDown: (v: boolean) => { fileDown = v }, uncertain: (v: boolean) => { uncertain = v } }
}

describe("GitHub durable dispatch wiring", () => {
  test("signed HTTP acceptance queues promptly, files before the worker and routes a claim through bin/worker's MCP", async () => {
    const w = world()
    const route = createGithubWebhookRoute({ dispatcher: w.dispatcher, getSecret: () => SECRET })
    const body = JSON.stringify(issuePayload())
    const url = new URL("http://localhost/webhooks/github")
    const res = await route(new Request(url.toString(), { method: "POST", body, headers: {
      "x-github-event": "issues", "x-github-delivery": "one", "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    } }), url)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toMatchObject({ status: "queued", taskId: ID })
    expect(w.calls).toHaveLength(0)
    await w.dispatcher.drain()
    expect(w.filed).toEqual([ID])
    expect(w.calls[0]).toMatchObject({ task_id: ID, repo: "ndi-tx-enclosure", claim: "test-claim", require_claim: true, host: "local" })
    expect(w.calls[0]?.prompt).toContain(`TASK ${ID}`)
    expect(w.brain[0]).toContain(ID)
    expect(w.brain[0]).toContain("/tasks?task=")
    expect(w.comments[0]?.at(-1)).toContain(ID)
  })

  test("concurrent deliveries, a new label and receiver reconstruction never duplicate any finished/failed/running task", async () => {
    const w = world()
    const results = await Promise.all([w.dispatcher.handleEvent("issues", "one", issuePayload()), w.dispatcher.handleEvent("issues", "one", issuePayload())])
    expect(results.map((r) => r.status)).toEqual(["queued", "duplicate_delivery"])
    await Promise.all([w.dispatcher.drain(), w.dispatcher.drain()])
    for (const status of ["running", "failed", "completed"] as const) {
      w.workers[0]!.status = status
      const restored = createGithubWebhookDispatcher(w.deps)
      expect((await restored.handleEvent("issues", `label-${status}`, issuePayload("labeled", "agent"))).status).toBe("already_dispatched")
      expect((await restored.handleEvent("issues", "one", issuePayload())).status).toBe("duplicate_delivery")
      await restored.drain()
    }
    expect(w.calls).toHaveLength(1)
    expect(w.comments).toHaveLength(1)
    expect(w.brain).toHaveLength(1)
  })

  test("explicit redispatch starts another turn only after the worker stops, and its delivery remains idempotent", async () => {
    const w = world()
    await w.dispatcher.handleEvent("issues", "one", issuePayload())
    await w.dispatcher.drain()
    await w.dispatcher.handleEvent("issues", "two", issuePayload("labeled", "redispatch"))
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(1)
    w.workers[0]!.status = "completed"
    await w.dispatcher.handleEvent("issues", "three", issuePayload("labeled", "redispatch"))
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(2)
    expect((await w.dispatcher.handleEvent("issues", "three", issuePayload("labeled", "redispatch"))).status).toBe("duplicate_delivery")
  })

  test("full cap queues, drain resumes at capacity, running workers reserve slots and existing PRs aren't double counted", async () => {
    const w = world()
    w.cap(["one", "two", "three"])
    await w.dispatcher.handleEvent("issues", "one", issuePayload())
    await w.dispatcher.drain()
    expect(w.store.get(ID)).toMatchObject({ state: "queued", reason: "pr_cap" })
    expect(w.calls).toHaveLength(0)
    w.cap(["one", "two"])
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(1)
    await w.dispatcher.handleEvent("issues", "two", issuePayload("opened", undefined, 2))
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(1)
    w.cap(["one", `dispatch/${ID}`])
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(2)
  })

  test("Turso or capacity lookup failure never starts a worker; a comment failure retries only the receipt", async () => {
    const w = world()
    w.fileDown(true)
    await w.dispatcher.handleEvent("issues", "one", issuePayload())
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(0)
    w.fileDown(false); w.ghDown(true)
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(0)
    w.ghDown(false); w.commentDown(true)
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(1)
    w.commentDown(false)
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(1)
    expect(w.store.get(ID)?.issueReceipt).toBe(true)
  })

  test("ambiguous peer acceptance never falls back or respawns; a later snapshot reconciles the receipt", async () => {
    const w = world()
    w.uncertain(true)
    const payload = issuePayload("labeled", "host:mac")
    await w.dispatcher.handleEvent("issues", "one", payload)
    await w.dispatcher.drain()
    expect(w.calls[0]?.host).toBe("mac")
    expect(w.store.get(ID)?.state).toBe("uncertain")
    await w.dispatcher.drain()
    expect(w.calls).toHaveLength(1)
    w.workers.push(snapshot())
    await w.dispatcher.drain()
    expect(w.store.get(ID)?.state).toBe("dispatched")
    expect(w.calls).toHaveLength(1)
  })

  test("outsider actor/text is logged and never stored in jobs, filed, commented or sent to a worker", async () => {
    const w = world()
    for (const action of ["opened", "labeled", "reopened"]) {
      const payload = issuePayload(action, "agent")
      payload.issue.user.login = "outsider"
      const res = await w.dispatcher.handleEvent("issues", action, payload)
      expect(res.status).toBe("ignored")
    }
    await w.dispatcher.drain()
    expect(w.store.jobs()).toHaveLength(0)
    expect(w.calls).toHaveLength(0)
    expect(w.filed).toHaveLength(0)
    expect(w.comments).toHaveLength(0)
    expect(w.logs.every((s) => s.includes("author_not_allowed"))).toBe(true)
  })
})
