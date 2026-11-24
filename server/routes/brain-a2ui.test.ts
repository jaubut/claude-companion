import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { type A2UICreateSurfaceMessage, createSurfaceTurn, getJsonPointer, getSurfaceDataModel } from "../lib/a2ui"
import { getAuthToken } from "../lib/auth"
import { classifyBrainEvent } from "../lib/brain-event-triage"
import { type OutboundPayload, type OutboundSender, type OutboundStore, createOutboundStore } from "../lib/outbound"
import type { Session } from "../lib/sessions"
import type { GhFn } from "../lib/triage-pr"
import { recordPeer } from "../lib/vault-guard"
import type { BrainWiring } from "../wiring/brain"
import type { BrainRouteDeps } from "./brain"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-brain-a2ui-")), "test.db")
process.env.COMPANION_AUTH_TOKEN = process.env.COMPANION_AUTH_TOKEN || "brain-a2ui-test-token-0123456789"

let routeMod: typeof import("./brain")
let chat: typeof import("../lib/orchestrator-chat")
let sqlite: typeof import("../lib/orchestrator-db")["db"]

const BRAIN_SESSION = {
  key: "herdr:p_brain",
  agent: "claude",
  label: "brain",
  title: "",
  sidConfirmed: true,
  agentStatus: "",
  waitingFor: "",
  cwd: "/srv/brain",
  sessionId: "sid-brain",
  termProgram: "",
  tty: "",
  iTermSessionId: "",
  tmuxPane: "",
  herdrPane: "p_brain",
  taskId: "brain",
  waitingSince: 0,
  waitingKind: "",
  waitingRef: "",
  waitingReasons: [],
  pid: "5150",
  firstSeenAt: 0,
  lastSeenAt: 0,
} as unknown as Session

const sessions: Session[] = [BRAIN_SESSION]
const AUTH = { "x-companion-task-id": "brain", "x-companion-pid": "5150" }

beforeAll(async () => {
  routeMod = await import("./brain")
  chat = await import("../lib/orchestrator-chat")
  sqlite = (await import("../lib/orchestrator-db")).db
  const channels = await import("../lib/orchestrator-channels")
  channels.ensureChannel("brain", "Brain")
})

beforeEach(() => {
  sqlite.exec("DELETE FROM orchestrator_turns")
})

function makeHarness(overrides: {
  gh?: GhFn
  prMerge?: BrainRouteDeps["prMerge"]
  deploy?: BrainRouteDeps["deploy"]
  outbound?: OutboundStore | (() => OutboundStore) | null
  emailSender?: OutboundSender
  enabled?: () => boolean
} = {}) {
  const broadcasts: Record<string, unknown>[] = []
  const emittedTurns: unknown[] = []
  const enqueuedTurns: Array<{ id: string; text: string; role: string }> = []

  const fakeWiring = {
    status: () => ({ state: "up", sessionKey: BRAIN_SESSION.key, since: 0, restarts: 0, host: "test", activity: null }),
    enqueue: (t: { id: string; text: string; role: string }) => {
      enqueuedTurns.push(t)
    },
  } as unknown as BrainWiring

  const handler = routeMod.createBrainRoute({
    wiring: fakeWiring,
    sessions: () => sessions,
    enabled: overrides.enabled ?? (() => true),
    gh: overrides.gh,
    prMerge: overrides.prMerge,
    deploy: overrides.deploy,
    outbound: "outbound" in overrides ? overrides.outbound : null,
    emailSender: overrides.emailSender,
    a2uiEngine: {
      broadcast: (f) => broadcasts.push(f),
      emitTurn: (t) => emittedTurns.push(t),
    },
  })

  async function call(
    method: string,
    path: string,
    body?: unknown,
    opts: { peer?: string; headers?: Record<string, string> } = {},
  ) {
    const req = new Request(`http://localhost:4245${path}`, {
      method,
      headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    recordPeer(req, opts.peer ?? "127.0.0.1")
    const res = (await handler(req, new URL(req.url)))!
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      /* 401 text */
    }
    return { status: res.status, json, headers: res.headers }
  }

  return { call, broadcasts, emittedTurns, enqueuedTurns }
}

describe("POST /hooks/brain/ui — auth & macro expansion", () => {
  test("enforces loopback + X-Companion-Task-Id: brain + brain session pid", async () => {
    const { call } = makeHarness()
    const payload = { macro: "email", to: "a@b.com", subject: "S", body: "B" }
    expect((await call("POST", "/hooks/brain/ui", payload, { peer: "100.64.0.9", headers: AUTH })).status).toBe(403)
    expect((await call("POST", "/hooks/brain/ui", payload, { headers: { ...AUTH, "x-forwarded-for": "100.64.0.9" } })).status).toBe(403)
    expect((await call("POST", "/hooks/brain/ui", payload, { headers: { ...AUTH, "x-companion-pid": "9999" } })).status).toBe(403)
    expect((await call("POST", "/hooks/brain/ui", payload, { headers: { "x-companion-pid": "5150" } })).status).toBe(403)
    expect((await call("GET", "/hooks/brain/ui", undefined, { headers: AUTH })).status).toBe(405)
    const disabled = makeHarness({ enabled: () => false })
    expect((await disabled.call("POST", "/hooks/brain/ui", payload, { headers: AUTH })).status).toBe(404)
  })

  test("macro: patch updates persisted TurnCard in-place and broadcasts live type:a2ui frame", async () => {
    const { call, broadcasts } = makeHarness()
    const created = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        surfaceId: "email-patch-01",
        to: "jeremie@example.com",
        cc: "a@example.com,b@example.com",
        subject: "Invoice",
        body: "Review attached.",
      },
      { headers: AUTH },
    )
    expect(created.status).toBe(200)

    const patched = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "patch",
        surfaceId: "email-patch-01",
        path: "/email/state",
        value: "sent",
      },
      { headers: AUTH },
    )
    expect(patched.status).toBe(200)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({
      type: "a2ui",
      threadId: "brain",
      surfaceId: "email-patch-01",
      messages: [{ version: "1.0", updateDataModel: { surfaceId: "email-patch-01", path: "/email/state", value: "sent" } }],
    })
    const turn = chat.findA2UITurn("email-patch-01")!
    expect(getJsonPointer(getSurfaceDataModel(turn.card!), "/email/state")).toBe("sent")
  })

  test("macro: custom validates against BasicCatalog schema, rejects HTML/unknown components, and fails atomically on bad trailing pointer", async () => {
    const { call } = makeHarness()
    const badHtml = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "custom",
        json: {
          version: "1.0",
          createSurface: {
            surfaceId: "custom-1",
            catalogId: "basic_catalog_1_0",
            components: [{ id: "root", component: "Text", text: "<script>alert(1)</script>" }],
            dataModel: {},
          },
        },
      },
      { headers: AUTH },
    )
    expect(badHtml.status).toBe(400)
    expect(badHtml.json.error).toBe("html_not_allowed")

    const badComp = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "custom",
        json: {
          version: "1.0",
          createSurface: {
            surfaceId: "custom-1",
            catalogId: "basic_catalog_1_0",
            components: [{ id: "root", component: "Iframe" }],
            dataModel: {},
          },
        },
      },
      { headers: AUTH },
    )
    expect(badComp.status).toBe(400)
    expect(String(badComp.json.error)).toContain("unregistered_component")

    // Atomic batch: trailing updateDataModel with invalid array index fails before persisting a turn
    const badBatch = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "custom",
        json: [
          {
            version: "1.0",
            createSurface: {
              surfaceId: "custom-atomic-fail",
              catalogId: "basic_catalog_1_0",
              components: [{ id: "root", component: "Text", text: "Hi" }],
              dataModel: { items: ["a"] },
            },
          },
          {
            version: "1.0",
            updateDataModel: {
              surfaceId: "custom-atomic-fail",
              path: "/items/99",
              value: "out-of-bounds",
            },
          },
        ],
      },
      { headers: AUTH },
    )
    expect(badBatch.status).toBe(400)
    expect(badBatch.json.error).toBe("invalid_json_pointer_target")
    expect(chat.findA2UITurn("custom-atomic-fail")).toBeNull()

    const valid = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "custom",
        text: "Custom status surface",
        json: {
          version: "1.0",
          createSurface: {
            surfaceId: "custom-ok",
            catalogId: "basic_catalog_1_0",
            components: [
              { id: "root", component: "Card", children: ["t1"] },
              { id: "t1", component: "Text", text: "All systems operational" },
            ],
            dataModel: { ok: true },
          },
        },
      },
      { headers: AUTH },
    )
    expect(valid.status).toBe(200)
    expect(chat.findA2UITurn("custom-ok")?.text).toBe("Custom status surface")
  })
})

describe("POST /api/brain/a2ui/action — bidirectional actions & actionKey idempotency", () => {
  const bearer = { authorization: `Bearer ${getAuthToken()}` }

  test("requires Bearer token", async () => {
    const { call } = makeHarness()
    const res = await call("POST", "/api/brain/a2ui/action", {
      surfaceId: "s1",
      turnId: "t1",
      action: { name: "email.cancel" },
      actionKey: "k1",
    })
    expect(res.status).toBe(401)
  })

  test("pr.refresh, pr.merge (head_moved check, pinned target, AbortSignal), and pr.deploy (not_merged guard + coalescing)", async () => {
    let ciPassed = false
    let currentHead = "abcdef1234567890"
    let mergeCalls = 0
    let deployCalls = 0
    const mergeGate = Promise.withResolvers<void>()

    const gh: GhFn = async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        state: "OPEN",
        isDraft: false,
        headRefName: "dispatch/68be1226",
        headRefOid: currentHead,
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: ciPassed ? "APPROVED" : "",
        url: "https://github.com/jaubut/claude-companion/pull/501",
        title: "feat(a2ui): server slice",
        author: { login: "jaubut" },
        labels: [],
        statusCheckRollup: [
          {
            status: ciPassed ? "COMPLETED" : "IN_PROGRESS",
            conclusion: ciPassed ? "SUCCESS" : "",
            name: "ci",
          },
        ],
        comments: ciPassed
          ? [
              {
                author: { login: "jaubut" },
                body: `🤖 **Auto-review**\n<!-- reviewed-sha: ${currentHead} -->\nVERDICT: APPROVE`,
              },
              {
                author: { login: "jaubut" },
                body: `♊️ **Gemini review** (agy)\n<!-- reviewed-sha: ${currentHead} -->\nVERDICT: APPROVE`,
              },
            ]
          : [],
        files: [],
      }),
    })

    const { call, enqueuedTurns } = makeHarness({
      gh,
      prMerge: async (p) => {
        mergeCalls++
        expect(p.repo).toBe("jaubut/claude-companion")
        expect(p.pr).toBe(501)
        expect(p.signal).toBeInstanceOf(AbortSignal)
        await mergeGate.promise
        return {
          status: 200,
          body: { ok: true, merged: true, url: "https://github.com/jaubut/claude-companion/pull/501", head: currentHead },
        }
      },
      deploy: async (repo) => {
        deployCalls++
        return { ok: true, repo: repo as "claude-companion", result: "no_restart", from: "111", to: "222", commits: 1 }
      },
    })

    const created = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "pr",
        repo: "jaubut/claude-companion",
        pr: 501,
        deployRepo: "claude-companion",
        surfaceId: "pr-501",
      },
      { headers: AUTH },
    )
    expect(created.status).toBe(200)
    const turnId = String(created.json.turnId)

    // pr.deploy before merge is rejected with 409 not_merged
    const earlyDeploy = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "pr-501",
        turnId,
        action: { name: "pr.deploy", context: { repo: "claude-companion" } },
        actionKey: "early-deploy-key",
      },
      { headers: bearer },
    )
    expect(earlyDeploy.status).toBe(409)
    expect(earlyDeploy.json.error).toBe("not_merged")

    // Head moves before refresh -> pr.merge refuses with 409 head_moved
    currentHead = "fedcba0987654321"
    const staleMerge = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "pr-501",
        turnId,
        action: { name: "pr.merge", context: { repo: "evil/other-repo", pr: 999 } },
        actionKey: "stale-merge-key",
      },
      { headers: bearer },
    )
    expect(staleMerge.status).toBe(409)
    expect(staleMerge.json).toEqual({
      ok: false,
      error: "head_moved",
      expected: "abcdef1234567890",
      actual: "fedcba0987654321",
    })
    expect(mergeCalls).toBe(0)

    // Refresh updates card to currentHead + green + approved
    ciPassed = true
    const refreshed = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "pr-501",
        turnId,
        action: { name: "pr.refresh" },
        actionKey: "refresh-key-1",
      },
      { headers: bearer },
    )
    expect(refreshed.status).toBe(200)
    expect((refreshed.json.pr as { ciState: string; reviewState: string; headSha: string })).toMatchObject({
      ciState: "green",
      reviewState: "approved",
      headSha: "fedcba0987654321",
    })

    // Fire two concurrent pr.merge requests with the same actionKey (also passing spoofed context.repo/pr to verify pinning)
    const p1 = call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "pr-501",
        turnId,
        action: { name: "pr.merge", context: { repo: "spoofed/repo", pr: 999 } },
        actionKey: "merge-key-1",
      },
      { headers: bearer },
    )
    const p2 = call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "pr-501",
        turnId,
        action: { name: "pr.merge", context: { repo: "spoofed/repo", pr: 999 } },
        actionKey: "merge-key-1",
      },
      { headers: bearer },
    )
    mergeGate.resolve()
    const [m1, m2] = await Promise.all([p1, p2])
    expect(m1.status).toBe(200)
    expect(m2.status).toBe(200)
    expect(m1.json.replay).toBe(false)
    expect(m2.json.replay).toBe(true)
    expect(mergeCalls).toBe(1)

    // Now that PR is merged, pr.deploy succeeds
    const deployed = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "pr-501",
        turnId,
        action: { name: "pr.deploy", context: { repo: "claude-companion" } },
        actionKey: "deploy-key-1",
      },
      { headers: bearer },
    )
    expect(deployed.status).toBe(200)
    expect(deployCalls).toBe(1)
    expect(enqueuedTurns).toHaveLength(0)
  })

  test("email.confirm enforces Cc allowlist (including empty cc: []), posts Brain user turn, and guards terminal state", async () => {
    const { call, broadcasts, enqueuedTurns } = makeHarness()

    const created = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        surfaceId: "email-confirm-cc",
        to: "partner@example.com",
        cc: ["alice@example.com", "bob@example.com", "charlie@example.com"],
        subject: "Contract Final",
        body: "Here is the signed agreement.",
        draftId: "draft-999",
        gmailThreadId: "thread-111",
      },
      { headers: AUTH },
    )
    const turnId = String(created.json.turnId)

    const confirmed = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-confirm-cc",
        turnId,
        action: {
          name: "email.confirm",
          context: {
            enabledCc: ["alice@example.com", "charlie@example.com", "injected@evil.example"],
          },
        },
        actionKey: "email-confirm-key-1",
      },
      { headers: bearer },
    )
    expect(confirmed.status).toBe(200)
    expect(confirmed.json.enabledCc).toEqual(["alice@example.com", "charlie@example.com"])
    expect(broadcasts).toHaveLength(2)
    expect(enqueuedTurns).toHaveLength(1)
    expect(enqueuedTurns[0]!.text).toContain("Cc: alice@example.com, charlie@example.com")
    expect(enqueuedTurns[0]!.text).not.toContain("injected@evil.example")

    // Attempting email.cancel or another email.confirm with a new actionKey after confirmed -> 409 already_decided
    const cancelAfterConfirm = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-confirm-cc",
        turnId,
        action: { name: "email.cancel" },
        actionKey: "new-cancel-key",
      },
      { headers: bearer },
    )
    expect(cancelAfterConfirm.status).toBe(409)
    expect(cancelAfterConfirm.json.error).toBe("already_decided")

    // Empty-CC email card strictly blocks injected context.enabledCc addresses
    const noCcCard = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        surfaceId: "email-no-cc",
        to: "solo@example.com",
        subject: "Private",
        body: "No CC allowed.",
      },
      { headers: AUTH },
    )
    const noCcConfirm = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-no-cc",
        turnId: String(noCcCard.json.turnId),
        action: {
          name: "email.confirm",
          context: { enabledCc: ["attacker@evil.example"] },
        },
        actionKey: "no-cc-confirm-1",
      },
      { headers: bearer },
    )
    expect(noCcConfirm.status).toBe(200)
    expect(noCcConfirm.json.enabledCc).toEqual([])
    expect(enqueuedTurns[1]!.text).toContain("Cc: none")
  })

  test("email.confirm resolves { '@path': '/email/enabledCc' } and email.cancel guards terminal state", async () => {
    const { call, enqueuedTurns } = makeHarness()

    const created = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        surfaceId: "email-path-bind",
        to: "team@example.com",
        cc: ["one@example.com", "two@example.com"],
        subject: "Update",
        body: "Weekly update.",
      },
      { headers: AUTH },
    )
    const turnId = String(created.json.turnId)

    await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "patch",
        surfaceId: "email-path-bind",
        path: "/email/enabledCc",
        value: ["two@example.com"],
      },
      { headers: AUTH },
    )

    const confirmed = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-path-bind",
        turnId,
        action: {
          name: "email.confirm",
          context: { enabledCc: { "@path": "/email/enabledCc" } },
        },
        actionKey: "path-bind-key-1",
      },
      { headers: bearer },
    )
    expect(confirmed.status).toBe(200)
    expect(confirmed.json.enabledCc).toEqual(["two@example.com"])
    expect(enqueuedTurns).toHaveLength(1)

    const second = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        surfaceId: "email-cancel-01",
        to: "nobody@example.com",
        subject: "Skip",
        body: "Draft",
      },
      { headers: AUTH },
    )
    const secondTurnId = String(second.json.turnId)
    const cancelled = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-cancel-01",
        turnId: secondTurnId,
        action: { name: "email.cancel" },
        actionKey: "cancel-key-1",
      },
      { headers: bearer },
    )
    expect(cancelled.status).toBe(200)
    expect(cancelled.json.state).toBe("cancelled")

    // Confirming after cancel returns 409 already_decided
    const confirmAfterCancel = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-cancel-01",
        turnId: secondTurnId,
        action: { name: "email.confirm" },
        actionKey: "confirm-after-cancel-key",
      },
      { headers: bearer },
    )
    expect(confirmAfterCancel.status).toBe(409)
    expect(confirmAfterCancel.json.error).toBe("already_decided")
  })

  test("real outboundStore + gmailSender: Cc subset updateCc, send error release + retry, sent receipt ($0 wake), idempotency/409, email.cancel -> reject, and dryRun:true fallback", async () => {
    const store = createOutboundStore(new Database(":memory:"))
    const sentPayloads: OutboundPayload[] = []
    let shouldFailSend = true

    const emailSender: OutboundSender = async (p) => {
      if (shouldFailSend) throw new Error("gmail.py exited 1: OAuth refresh failed")
      sentPayloads.push(p)
      return { messageId: "18f00aabbccdd123" }
    }

    const { call, emittedTurns, enqueuedTurns } = makeHarness({
      outbound: store,
      emailSender,
    })

    // 1. Propose real outbound email via /hooks/brain/ui (comma-separated --to, --account hello, --in-reply-to, --why)
    const created = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        to: "client1@example.com, client2@example.com",
        cc: ["ops@example.com", "accounting@example.com", "archive@example.com"],
        account: "hello",
        inReplyTo: "<orig-99@mail.example.com>",
        gmailThreadId: "th-hello-99",
        why: "Send revised Q4 statement",
        subject: "Q4 Statement",
        body: "Bonjour,\n\nVoici l'état de compte révisé.",
      },
      { headers: AUTH },
    )
    expect(created.status).toBe(200)
    const outboundId = String(created.json.outboundId)
    expect(outboundId).toHaveLength(32)
    const surfaceId = String(created.json.surfaceId)
    expect(surfaceId).toBe(`outbound-${outboundId}`)
    const turnId = String(created.json.turnId)

    const initialRec = store.get(outboundId)!
    expect(initialRec).not.toBeNull()
    expect(initialRec.status).toBe("proposed")
    expect(initialRec.account).toBe("hello")
    expect(initialRec.to).toEqual(["client1@example.com", "client2@example.com"])
    expect(initialRec.cc).toEqual(["ops@example.com", "accounting@example.com", "archive@example.com"])
    expect(initialRec.inReplyTo).toBe("<orig-99@mail.example.com>")
    expect(initialRec.why).toBe("Send revised Q4 statement")

    // 2. First confirm tap with subset Cc fails in gmailSender -> releases back to 'proposed', patches state='pending' & error, does NOT cache actionKey
    const failedConfirm = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId,
        turnId,
        action: {
          name: "email.confirm",
          context: {
            enabledCc: ["ops@example.com", "intruder@evil.example"],
          },
        },
        actionKey: "send-attempt-1",
      },
      { headers: bearer },
    )
    expect(failedConfirm.status).toBe(502)
    expect(failedConfirm.json).toEqual({
      ok: false,
      error: "send_failed",
      detail: "gmail.py exited 1: OAuth refresh failed",
    })

    const releasedRec = store.get(outboundId)!
    expect(releasedRec.status).toBe("proposed")
    expect(releasedRec.cc).toEqual(["ops@example.com"])
    expect(releasedRec.payloadHash).not.toBe(initialRec.payloadHash)
    expect(releasedRec.lastError).toContain("OAuth refresh failed")

    const afterFailTurn = chat.getTurn(turnId)!
    const afterFailModel = getSurfaceDataModel(afterFailTurn.card!)
    expect(getJsonPointer(afterFailModel, "/email/state")).toBe("pending")
    expect(getJsonPointer(afterFailModel, "/email/error")).toContain("OAuth refresh failed")
    expect(getJsonPointer(afterFailModel, "/email/payloadHash")).toBe(releasedRec.payloadHash)

    // 3. Retry with the SAME actionKey succeeds now that sender is healthy
    shouldFailSend = false
    const retryConfirm = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId,
        turnId,
        action: {
          name: "email.confirm",
          context: {
            enabledCc: ["ops@example.com"],
          },
        },
        actionKey: "send-attempt-1",
      },
      { headers: bearer },
    )
    expect(retryConfirm.status).toBe(200)
    expect(retryConfirm.json).toEqual({
      ok: true,
      surfaceId,
      turnId,
      action: "email.confirm",
      state: "sent",
      outboundId,
      messageId: "18f00aabbccdd123",
      to: "client1@example.com, client2@example.com",
      enabledCc: ["ops@example.com"],
      subject: "Q4 Statement",
      replay: false,
    })
    expect(sentPayloads).toEqual([
      {
        account: "hello",
        to: ["client1@example.com", "client2@example.com"],
        cc: ["ops@example.com"],
        subject: "Q4 Statement",
        body: "Bonjour,\n\nVoici l'état de compte révisé.",
        inReplyTo: "<orig-99@mail.example.com>",
      },
    ])
    expect(store.get(outboundId)!.status).toBe("sent")
    expect(store.get(outboundId)!.messageId).toBe("18f00aabbccdd123")
    expect(enqueuedTurns).toHaveLength(0)

    const receiptTurn = emittedTurns.at(-1) as { role: string; text: string; threadId: string }
    expect(receiptTurn.role).toBe("orchestrator")
    expect(receiptTurn.text).toBe(
      `Sent email [${surfaceId}] -> client1@example.com, client2@example.com (Cc: ops@example.com): "Q4 Statement"`,
    )
    expect(classifyBrainEvent(receiptTurn)).toBe("silent")

    // 4. Replaying same actionKey returns cached 200 with replay: true; new actionKey returns 409 already_decided
    const replayConfirm = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId,
        turnId,
        action: { name: "email.confirm" },
        actionKey: "send-attempt-1",
      },
      { headers: bearer },
    )
    expect(replayConfirm.status).toBe(200)
    expect(replayConfirm.json.replay).toBe(true)
    expect(sentPayloads).toHaveLength(1)

    const secondTap = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId,
        turnId,
        action: { name: "email.confirm" },
        actionKey: "send-attempt-2",
      },
      { headers: bearer },
    )
    expect(secondTap.status).toBe(409)
    expect(secondTap.json.error).toBe("already_decided")
    expect(sentPayloads).toHaveLength(1)

    // 5. email.cancel on a proposed outbound email marks the OutboundRecord as 'rejected'
    const toCancel = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        to: "cancel-me@example.com",
        subject: "Draft to reject",
        body: "Never mind.",
      },
      { headers: AUTH },
    )
    expect(toCancel.status).toBe(200)
    const cancelOutboundId = String(toCancel.json.outboundId)
    expect(store.get(cancelOutboundId)!.status).toBe("proposed")

    const cancelRes = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: String(toCancel.json.surfaceId),
        turnId: String(toCancel.json.turnId),
        action: { name: "email.cancel" },
        actionKey: "cancel-real-1",
      },
      { headers: bearer },
    )
    expect(cancelRes.status).toBe(200)
    expect(cancelRes.json.state).toBe("cancelled")
    expect(store.get(cancelOutboundId)!.status).toBe("rejected")

    // 6. dryRun: true skips outboundStore and falls back to #370 confirmed behavior
    const dryCard = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        to: "demo@example.com",
        subject: "Sandbox Demo",
        body: "Testing dry-run mode.",
        inReplyTo: "<msg-123>",
        dryRun: true,
      },
      { headers: AUTH },
    )
    expect(dryCard.status).toBe(200)
    expect(dryCard.json.outboundId).toBeUndefined()
    const dryTurn = chat.getTurn(String(dryCard.json.turnId))!
    expect(getJsonPointer(getSurfaceDataModel(dryTurn.card!), "/email/inReplyTo")).toBe("<msg-123>")
    const dryConfirm = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: String(dryCard.json.surfaceId),
        turnId: String(dryCard.json.turnId),
        action: { name: "email.confirm" },
        actionKey: "dry-confirm-1",
      },
      { headers: bearer },
    )
    expect(dryConfirm.status).toBe(200)
    expect(dryConfirm.json.state).toBe("confirmed")
    expect(sentPayloads).toHaveLength(1)
    expect(enqueuedTurns).toHaveLength(1)

    // 7. Outbound payloadHash staleness check: concurrent store.editBody invalidates stale card on both email.confirm and email.cancel
    // Also exercises angle-bracket RFC 5322 In-Reply-To ids ("<msg-123>" and "<msg-123@mail.gmail.com>")
    const staleCard = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        to: "stale@example.com",
        cc: ["cc1@example.com"],
        inReplyTo: "<msg-123>",
        subject: "Stale Test",
        body: "Original body shown on card.",
      },
      { headers: AUTH },
    )
    expect(staleCard.status).toBe(200)
    const staleOutboundId = String(staleCard.json.outboundId)
    const staleSurfaceId = String(staleCard.json.surfaceId)
    const staleTurnId = String(staleCard.json.turnId)
    expect(store.get(staleOutboundId)!.inReplyTo).toBe("<msg-123>")

    const edited = store.editBody(staleOutboundId, "Concurrently edited body via triage.", Date.now() + 10)
    expect(edited).not.toBeNull()
    expect(edited!.payloadHash).not.toBe(String(staleCard.json.payloadHash))

    const staleConfirm = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: staleSurfaceId,
        turnId: staleTurnId,
        action: { name: "email.confirm" },
        actionKey: "stale-confirm-1",
      },
      { headers: bearer },
    )
    expect(staleConfirm.status).toBe(409)
    expect(staleConfirm.json.error).toBe("stale_version")
    expect(sentPayloads).toHaveLength(1)
    expect(store.get(staleOutboundId)!.status).toBe("proposed")

    const staleCancel = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: staleSurfaceId,
        turnId: staleTurnId,
        action: { name: "email.cancel" },
        actionKey: "stale-cancel-1",
      },
      { headers: bearer },
    )
    expect(staleCancel.status).toBe(409)
    expect(staleCancel.json.error).toBe("stale_version")
    expect(store.get(staleOutboundId)!.status).toBe("proposed")

    const gmailReplyCard = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "email",
        to: "reply@example.com",
        inReplyTo: "<msg-123@mail.gmail.com>",
        subject: "Re: Hello",
        body: "Replying with standard Gmail Message-ID.",
      },
      { headers: AUTH },
    )
    expect(gmailReplyCard.status).toBe(200)
    expect(store.get(String(gmailReplyCard.json.outboundId))!.inReplyTo).toBe("<msg-123@mail.gmail.com>")

    // 8. The Brain cannot rewrite, restyle or forge an outbound card: patch/custom on it are refused
    const target = await call(
      "POST",
      "/hooks/brain/ui",
      { macro: "email", to: "victim@example.com", subject: "Real", body: "Real body that would send." },
      { headers: AUTH },
    )
    const targetId = String(target.json.outboundId)
    const targetSurface = String(target.json.surfaceId)
    const patchBody = await call(
      "POST",
      "/hooks/brain/ui",
      { macro: "patch", surfaceId: targetSurface, path: "/email/body", value: "Harmless text." },
      { headers: AUTH },
    )
    expect(patchBody.status).toBe(403)
    expect(patchBody.json.error).toBe("outbound_surface_readonly")

    const restyle = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "custom",
        json: [{ version: "1.0", updateComponents: { surfaceId: targetSurface, components: [{ id: "body_text", component: "Text", text: "Harmless." }] } }],
      },
      { headers: AUTH },
    )
    expect(restyle.status).toBe(403)

    const forged = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "custom",
        json: [{
          version: "1.0",
          createSurface: {
            surfaceId: "fake-card-1",
            catalogId: "basic_catalog_1_0",
            components: [{ id: "root", component: "Button", label: "OK", action: { name: "email.confirm" } }],
            dataModel: { email: { to: "x@example.com", outboundId: targetId, payloadHash: String(target.json.payloadHash), state: "pending", body: "Harmless." } },
          },
        }],
      },
      { headers: AUTH },
    )
    expect(forged.status).toBe(403)
    expect(store.get(targetId)!.status).toBe("proposed")

    // 9. A card whose displayed body differs from the record (even with the record's hash) never sends
    const turnRow = chat.getTurn(String(target.json.turnId))!
    const tampered = structuredClone(turnRow.card!)
    const cs = (tampered.messages![0] as A2UICreateSurfaceMessage).createSurface
    ;(cs.dataModel.email as Record<string, unknown>).body = "Harmless text."
    chat.setTurnCard(turnRow.id, { messages: tampered.messages })
    const tamperedConfirm = await call(
      "POST",
      "/api/brain/a2ui/action",
      { surfaceId: targetSurface, turnId: turnRow.id, action: { name: "email.confirm" }, actionKey: "tampered-1" },
      { headers: bearer },
    )
    expect(tamperedConfirm.status).toBe(409)
    expect(tamperedConfirm.json.error).toBe("stale_version")
    expect(sentPayloads).toHaveLength(1)

    // 10. Untrimmed bodies (triage-route proposals keep them as-is) still match the card
    const padded = store.propose(
      { kind: "email", account: "personal", to: ["pad@example.com"], cc: [], subject: "Pad", body: "Body with trailing newline\n", inReplyTo: null, threadId: null, why: "w", requestedBy: "t" },
      Date.now(),
    )
    const { buildEmailConfirmSurface } = await import("../lib/a2ui-macros")
    const built = buildEmailConfirmSurface({ to: padded.to, subject: padded.subject, body: padded.body, outboundId: padded.id, payloadHash: padded.payloadHash })
    if (!built.ok) throw new Error(built.error)
    const paddedTurn = createSurfaceTurn({ surfaceId: built.surfaceId, text: built.text, messages: built.messages }, { emitTurn: () => {} })
    const paddedConfirm = await call(
      "POST",
      "/api/brain/a2ui/action",
      { surfaceId: built.surfaceId, turnId: paddedTurn.id, action: { name: "email.confirm" }, actionKey: "padded-1" },
      { headers: bearer },
    )
    expect(paddedConfirm.status).toBe(200)
    expect(sentPayloads.at(-1)!.body).toBe("Body with trailing newline\n")
  })

  test("bin/ui pr --reason renders reason_text component above divider and preserves reason across pr.refresh", async () => {
    let headSha = "1111222233334444"
    const gh: GhFn = async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        state: "OPEN",
        isDraft: false,
        headRefName: "dispatch/abcd1234",
        headRefOid: headSha,
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: "APPROVED",
        url: "https://github.com/jaubut/claude-companion/pull/510",
        title: "feat(db): migration gate",
        author: { login: "jaubut" },
        labels: [],
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "test" }],
        comments: [],
        files: [],
      }),
    })

    const { call } = makeHarness({ gh })
    const created = await call(
      "POST",
      "/hooks/brain/ui",
      {
        macro: "pr",
        repo: "jaubut/claude-companion",
        pr: 510,
        deployRepo: "claude-companion",
        reason: "touches db/migrations/001.sql (prod schema) — human merge only",
      },
      { headers: AUTH },
    )
    expect(created.status).toBe(200)
    const turnId = String(created.json.turnId)
    const surfaceId = String(created.json.surfaceId)
    const turn = chat.getTurn(turnId)!
    const cs = (turn.card!.messages![0] as A2UICreateSurfaceMessage).createSurface
    const col = cs.components.find((c) => c.id === "col")!
    expect(col.children).toEqual(["header_row", "meta_row", "url_text", "reason_text", "divider", "actions_row"])
    expect(cs.components.find((c) => c.id === "reason_text")).toEqual({
      id: "reason_text",
      component: "Text",
      text: { "@path": "/pr/reason" },
      variant: "body",
    })
    expect(getJsonPointer(cs.dataModel, "/pr/reason")).toBe("touches db/migrations/001.sql (prod schema) — human merge only")

    // Refresh updates headSha and preserves pr.reason
    headSha = "9999888877776666"
    const refreshed = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId,
        turnId,
        action: { name: "pr.refresh" },
        actionKey: "refresh-preserve-reason-1",
      },
      { headers: bearer },
    )
    expect(refreshed.status).toBe(200)
    expect((refreshed.json.pr as Record<string, unknown>).headSha).toBe("9999888877776666")
    expect((refreshed.json.pr as Record<string, unknown>).reason).toBe(
      "touches db/migrations/001.sql (prod schema) — human merge only",
    )
    const modelAfter = getSurfaceDataModel(chat.getTurn(turnId)!.card!)
    expect(getJsonPointer(modelAfter, "/pr/reason")).toBe("touches db/migrations/001.sql (prod schema) — human merge only")
  })
})
