import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getJsonPointer, getSurfaceDataModel } from "../lib/a2ui"
import { getAuthToken } from "../lib/auth"
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

  test("macro: custom validates against BasicCatalog schema and rejects HTML/script or unknown components", async () => {
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

  test("pr.refresh, pr.merge, and pr.deploy execute with zero LLM call, fold state into SQLite, broadcast WS patches, and enforce actionKey idempotency", async () => {
    let ciPassed = false
    let mergeCalls = 0
    let deployCalls = 0

    const gh: GhFn = async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        state: "OPEN",
        isDraft: false,
        headRefName: "dispatch/68be1226",
        headRefOid: "abcdef1234567890",
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
                body: "🤖 **Auto-review**\n<!-- reviewed-sha: abcdef1234567890 -->\nVERDICT: APPROVE",
              },
            ]
          : [],
        files: [],
      }),
    })

    const { call, broadcasts, enqueuedTurns } = makeHarness({
      gh,
      prMerge: async (p) => {
        mergeCalls++
        expect(p.repo).toBe("jaubut/claude-companion")
        expect(p.pr).toBe(501)
        return {
          status: 200,
          body: { ok: true, merged: true, url: "https://github.com/jaubut/claude-companion/pull/501", head: "abcdef1234567890" },
        }
      },
      deploy: async (repo) => {
        deployCalls++
        return { ok: true, repo: repo as "claude-companion", result: "no_restart", from: "111", to: "222", commits: 1 }
      },
    })

    // 1. Brain creates PR gate card while CI is pending
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
    expect((created.json.pr as { ciState: string }).ciState).toBe("pending")

    // 2. CI finishes; user taps pr.refresh -> 0 LLM call, dataModel updates to green + approved
    ciPassed = true
    const refreshed = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "pr-501",
        turnId,
        action: { name: "pr.refresh", context: { repo: "jaubut/claude-companion", pr: 501 } },
        actionKey: "refresh-key-1",
      },
      { headers: bearer },
    )
    expect(refreshed.status).toBe(200)
    expect((refreshed.json.pr as { ciState: string; reviewState: string }).ciState).toBe("green")
    expect((refreshed.json.pr as { ciState: string; reviewState: string }).reviewState).toBe("approved")
    expect(enqueuedTurns).toHaveLength(0)

    // 3. User taps pr.merge -> calls mergeAgentPr, patches /pr/state to "merged"
    const merged = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "pr-501",
        turnId,
        action: { name: "pr.merge", context: { repo: "jaubut/claude-companion", pr: 501 } },
        actionKey: "merge-key-1",
      },
      { headers: bearer },
    )
    expect(merged.status).toBe(200)
    expect(merged.json).toMatchObject({ ok: true, state: "merged", merged: true, replay: false })
    expect(mergeCalls).toBe(1)

    // Duplicate tap with same actionKey -> replays without calling prMerge again
    const dupMerge = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "pr-501",
        turnId,
        action: { name: "pr.merge", context: { repo: "jaubut/claude-companion", pr: 501 } },
        actionKey: "merge-key-1",
      },
      { headers: bearer },
    )
    expect(dupMerge.status).toBe(200)
    expect(dupMerge.json.replay).toBe(true)
    expect(dupMerge.headers.get("Idempotent-Replayed")).toBe("true")
    expect(mergeCalls).toBe(1)

    // Verify persisted SQLite state has /pr/state = "merged"
    const afterMergeTurn = chat.getTurn(turnId)!
    expect(getJsonPointer(getSurfaceDataModel(afterMergeTurn.card!), "/pr/state")).toBe("merged")
    expect(broadcasts.some((b) => JSON.stringify(b).includes('"/pr/state"') && JSON.stringify(b).includes('"merged"'))).toBe(true)

    // 4. User taps pr.deploy -> runs deploy once
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

  test("email.confirm with filtered enabledCc updates /email/state to confirmed, posts concise Brain user turn, and deduplicates actionKey", async () => {
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
    expect(created.status).toBe(200)
    const turnId = String(created.json.turnId)

    // User deselects bob@example.com and confirms with ["alice@example.com", "charlie@example.com"]
    const confirmed = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-confirm-cc",
        turnId,
        action: {
          name: "email.confirm",
          context: {
            enabledCc: ["alice@example.com", "charlie@example.com"],
          },
        },
        actionKey: "email-confirm-key-1",
      },
      { headers: bearer },
    )
    expect(confirmed.status).toBe(200)
    expect(confirmed.json).toMatchObject({
      ok: true,
      surfaceId: "email-confirm-cc",
      action: "email.confirm",
      state: "confirmed",
      to: "partner@example.com",
      enabledCc: ["alice@example.com", "charlie@example.com"],
      subject: "Contract Final",
      draftId: "draft-999",
      replay: false,
    })

    // Persisted TurnCard has updated enabledCc and state = "confirmed"
    const persisted = chat.getTurn(turnId)!
    const model = getSurfaceDataModel(persisted.card!)
    expect(getJsonPointer(model, "/email/state")).toBe("confirmed")
    expect(getJsonPointer(model, "/email/enabledCc")).toEqual(["alice@example.com", "charlie@example.com"])

    // Broadcasted WS frames for enabledCc and state
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts[1]).toEqual({
      type: "a2ui",
      threadId: "brain",
      turnId,
      surfaceId: "email-confirm-cc",
      messages: [
        {
          version: "1.0",
          updateDataModel: {
            surfaceId: "email-confirm-cc",
            path: "/email/state",
            value: "confirmed",
          },
        },
      ],
    })

    // Enqueued a concise user confirmation turn in the Brain thread
    expect(enqueuedTurns).toHaveLength(1)
    expect(enqueuedTurns[0]!.role).toBe("user")
    expect(enqueuedTurns[0]!.text).toContain("To: partner@example.com")
    expect(enqueuedTurns[0]!.text).toContain("Cc: alice@example.com, charlie@example.com")
    expect(enqueuedTurns[0]!.text).not.toContain("bob@example.com")
    expect(enqueuedTurns[0]!.text).toContain('Subject: "Contract Final"')
    expect(enqueuedTurns[0]!.text).toContain("draftId: draft-999")

    // Duplicate tap with same actionKey never posts a second turn
    const replay = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-confirm-cc",
        turnId,
        action: {
          name: "email.confirm",
          context: {
            enabledCc: ["alice@example.com", "charlie@example.com"],
          },
        },
        actionKey: "email-confirm-key-1",
      },
      { headers: bearer },
    )
    expect(replay.status).toBe(200)
    expect(replay.json.replay).toBe(true)
    expect(enqueuedTurns).toHaveLength(1)
  })

  test("email.confirm also resolves { '@path': '/email/enabledCc' } when Cc was patched beforehand, and email.cancel cancels with zero LLM call", async () => {
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

    // Patch /email/enabledCc first
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

    // Confirm using canonical A2UI @path binding in action.context
    const confirmed = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-path-bind",
        turnId,
        action: {
          name: "email.confirm",
          context: {
            enabledCc: { "@path": "/email/enabledCc" },
          },
        },
        actionKey: "path-bind-key-1",
      },
      { headers: bearer },
    )
    expect(confirmed.status).toBe(200)
    expect(confirmed.json.enabledCc).toEqual(["two@example.com"])
    expect(enqueuedTurns).toHaveLength(1)
    expect(enqueuedTurns[0]!.text).toContain("Cc: two@example.com")

    // Test email.cancel on another card -> 0 LLM turns
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
    const cancelled = await call(
      "POST",
      "/api/brain/a2ui/action",
      {
        surfaceId: "email-cancel-01",
        turnId: String(second.json.turnId),
        action: { name: "email.cancel" },
        actionKey: "cancel-key-1",
      },
      { headers: bearer },
    )
    expect(cancelled.status).toBe(200)
    expect(cancelled.json.state).toBe("cancelled")
    expect(enqueuedTurns).toHaveLength(1)
  })
})
