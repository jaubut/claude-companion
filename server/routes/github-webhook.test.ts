import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import type { SupervisedTaskSnapshot } from "../lib/worker-supervisor"
import { createGithubWebhookDispatcher } from "../wiring/github-webhook"
import { createGithubWebhookRoute } from "./github-webhook"

const SECRET = "test-github-webhook-secret-987654321"

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`
}

function fakeSnapshot(overrides: Partial<SupervisedTaskSnapshot> = {}): SupervisedTaskSnapshot {
  return {
    taskId: "gh-ndi-tx-enclosure-issue-1",
    repo: "ndi-tx-enclosure",
    title: "#1 feat(cad): Build parametric enclosure",
    builder: "builder-mac-ndi-tx-enclosure-gh-ndi-tx-enclosure-issue-1",
    family: "claude",
    model: "claude-opus-5-5",
    branch: "dispatch/gh-ndi-tx-enclosure-issue-1",
    worktree: "/tmp/wt/gh-ndi-tx-enclosure-issue-1",
    sessionId: "sess-1",
    status: "running",
    turnCount: 1,
    step: "Starting",
    pct: 5,
    result: "",
    prUrl: null,
    error: null,
    startedAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...overrides,
  }
}

function issuePayload(opts: {
  action?: string
  labels?: string[]
  addedLabel?: string
  issueNumber?: number
} = {}) {
  const num = opts.issueNumber ?? 1
  const labels = opts.labels ?? []
  return {
    action: opts.action ?? "opened",
    ...(opts.addedLabel ? { label: { name: opts.addedLabel } } : {}),
    sender: { login: "jaubut" },
    repository: { full_name: "jaubut/ndi-tx-enclosure", name: "ndi-tx-enclosure", owner: { login: "jaubut" } },
    issue: {
      number: num,
      state: "open",
      title: "feat(cad): Build parametric enclosure",
      body: "Implement CAD_SPEC.md",
      html_url: `https://github.com/jaubut/ndi-tx-enclosure/issues/${num}`,
      labels: labels.map((name) => ({ name })),
    },
  }
}

describe("github-webhook route & wiring", () => {
  test("rejects bad/missing auth and refuses Bearer over Funnel", async () => {
    const dispatcher = createGithubWebhookDispatcher({ log: () => {}, gh: async () => ({ code: 0, stdout: "", stderr: "" }) })
    const route = createGithubWebhookRoute({
      dispatcher,
      getSecret: () => SECRET,
      authorizeBearer: (req) => req.headers.get("authorization") === "Bearer valid-bearer",
      localHost: "m2-max-ji-dog",
    })
    const body = JSON.stringify({ zen: "keep it logically awesome" })

    const getRes = await route(new Request("http://127.0.0.1:4245/webhooks/github"), new URL("http://127.0.0.1:4245/webhooks/github"))
    expect(getRes?.status).toBe(200)
    expect(await getRes?.json()).toEqual({ ok: true, service: "github-webhook", host: "m2-max-ji-dog" })

    const badSig = await route(new Request("http://127.0.0.1:4245/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "ping", "x-hub-signature-256": "sha256=" + "f".repeat(64) },
      body,
    }), new URL("http://127.0.0.1:4245/webhooks/github"))
    expect(badSig?.status).toBe(401)

    const funnelBearer = await route(new Request("http://127.0.0.1:4245/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "ping",
        authorization: "Bearer valid-bearer",
        "tailscale-funnel-request": "?1",
      },
      body,
    }), new URL("http://127.0.0.1:4245/webhooks/github"))
    expect(funnelBearer?.status).toBe(401)

    const okSig = await route(new Request("http://127.0.0.1:4245/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "ping", "x-github-delivery": "deliv-ping-1", "x-hub-signature-256": sign(body) },
      body,
    }), new URL("http://127.0.0.1:4245/webhooks/github"))
    expect(okSig?.status).toBe(200)
    expect(await okSig?.json()).toEqual({ ok: true, status: "ping", hookId: null, repo: null })
  })

  test("dispatches issues.opened, falls back from offline zettlab to local, and deduplicates deliveries", async () => {
    const mcpCalls: Array<Record<string, unknown>> = []
    const localCalls: Array<Record<string, unknown>> = []
    const ghCalls: string[][] = []
    const tasks: SupervisedTaskSnapshot[] = []

    const dispatcher = createGithubWebhookDispatcher({
      localHost: "m2-max-ji-dog",
      log: () => {},
      listLocalTasks: () => tasks,
      gh: async (args) => { ghCalls.push(args); return { code: 0, stdout: "ok", stderr: "" } },
      callMcpDispatch: async (args) => {
        mcpCalls.push(args)
        if (args.host === "zettlab") return { ok: false, error: "peer_unreachable: timeout" }
        const snap = fakeSnapshot({ taskId: String(args.task_id), family: (args.family as "claude" | "codex") ?? "claude" })
        tasks.push(snap)
        return { ok: true, host: "m2-max-ji-dog", task: snap }
      },
      dispatchLocal: async (input) => {
        localCalls.push(input as unknown as Record<string, unknown>)
        const snap = fakeSnapshot({ taskId: input.taskId, family: (input.family as "claude" | "codex") ?? "claude" })
        tasks.push(snap)
        return { ok: true, task: snap }
      },
    })

    const route = createGithubWebhookRoute({ dispatcher, getSecret: () => SECRET, localHost: "m2-max-ji-dog" })

    // 1. Labeled for offline zettlab + agent:codex -> falls back to local Mac
    const body1 = JSON.stringify(issuePayload({ action: "labeled", addedLabel: "host:zettlab", labels: ["host:zettlab", "agent:codex"] }))
    const r1 = await route(new Request("http://127.0.0.1:4245/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "issues", "x-github-delivery": "d-1", "x-hub-signature-256": sign(body1) },
      body: body1,
    }), new URL("http://127.0.0.1:4245/webhooks/github"))
    const j1 = await r1?.json() as Record<string, unknown>
    expect(r1?.status).toBe(200)
    expect(j1.status).toBe("dispatched")
    expect(j1.fallbackFrom).toBe("zettlab")
    expect(j1.host).toBe("m2-max-ji-dog")
    expect(j1.family).toBe("codex")
    expect(mcpCalls[0]?.host).toBe("zettlab")
    expect(localCalls.length).toBe(1)

    // Allow fire-and-forget issue comment microtask to flush
    await Promise.resolve()
    expect(ghCalls.length).toBe(1)

    // 2. Same delivery ID is deduplicated
    const rDup = await route(new Request("http://127.0.0.1:4245/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "issues", "x-github-delivery": "d-1", "x-hub-signature-256": sign(body1) },
      body: body1,
    }), new URL("http://127.0.0.1:4245/webhooks/github"))
    expect(await rDup?.json()).toEqual({ ok: true, status: "duplicate_delivery", deliveryId: "d-1" })

    // 3. New delivery while running -> already_running
    const rRun = await route(new Request("http://127.0.0.1:4245/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "issues", "x-github-delivery": "d-2", "x-hub-signature-256": sign(body1) },
      body: body1,
    }), new URL("http://127.0.0.1:4245/webhooks/github"))
    expect((await rRun?.json() as Record<string, unknown>).status).toBe("already_running")

    // 4. Completed with PR skips non-dispatch label, but redispatches on `dispatch` label
    tasks[0] = fakeSnapshot({ status: "completed", prUrl: "https://github.com/jaubut/ndi-tx-enclosure/pull/2" })
    const nonDispatch = JSON.stringify(issuePayload({ action: "labeled", addedLabel: "enhancement", labels: ["enhancement"] }))
    const rDone = await route(new Request("http://127.0.0.1:4245/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "issues", "x-github-delivery": "d-3", "x-hub-signature-256": sign(nonDispatch) },
      body: nonDispatch,
    }), new URL("http://127.0.0.1:4245/webhooks/github"))
    expect((await rDone?.json() as Record<string, unknown>).status).toBe("already_completed")

    const forceBody = JSON.stringify(issuePayload({ action: "labeled", addedLabel: "dispatch", labels: ["dispatch"] }))
    const rForce = await route(new Request("http://127.0.0.1:4245/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "issues", "x-github-delivery": "d-4", "x-hub-signature-256": sign(forceBody) },
      body: forceBody,
    }), new URL("http://127.0.0.1:4245/webhooks/github"))
    expect((await rForce?.json() as Record<string, unknown>).status).toBe("dispatched")
  })
})
