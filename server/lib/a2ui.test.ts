import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  A2UI_BASIC_COMPONENTS,
  type A2UIFrame,
  containsHtmlOrScript,
  createSurfaceTurn,
  getJsonPointer,
  getSurfaceDataModel,
  setJsonPointer,
  updateSurfaceComponents,
  updateSurfaceData,
  validateA2UIActionRequest,
  validateA2UIComponent,
  validateA2UIMessage,
  validateA2UIMessages,
} from "./a2ui"
import {
  buildEmailConfirmSurface,
  buildPrGateSurface,
  hydratePrGateData,
} from "./a2ui-macros"
import { computeReviewState } from "./a2ui-pr-state"
import { isBrainInternalEvent } from "./brain"
import { classifyBrainEvent } from "./brain-event-triage"

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-a2ui-test-")), "test.db")

let chat: typeof import("./orchestrator-chat")
let sqlite: typeof import("./orchestrator-db")["db"]

beforeAll(async () => {
  chat = await import("./orchestrator-chat")
  sqlite = (await import("./orchestrator-db")).db
})

beforeEach(() => {
  sqlite.exec("DELETE FROM orchestrator_turns")
})

describe("A2UI v1.0 wire contract fixtures", () => {
  const contractsDir = join(import.meta.dir, "..", "..", "contracts")

  test("contracts/brain/orchestrator.card.a2ui.json has exact keys and valid A2UI v1.0 messages", () => {
    const raw = JSON.parse(readFileSync(join(contractsDir, "brain", "orchestrator.card.a2ui.json"), "utf8")) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(["turn", "type"])
    expect(raw.type).toBe("orchestrator")
    const turn = raw.turn as Record<string, unknown>
    expect(Object.keys(turn).sort()).toEqual(["card", "createdAt", "id", "role", "taskId", "text", "threadId"])
    expect(typeof turn.text).toBe("string")
    expect((turn.text as string).length).toBeGreaterThan(10)
    const card = turn.card as Record<string, unknown>
    expect(Object.keys(card).sort()).toEqual(["kind", "messages", "source", "surfaceId"])
    expect(card.kind).toBe("a2ui")
    expect(card.source).toBe("app")
    const validated = validateA2UIMessages(card.messages)
    expect(validated.ok).toBe(true)
    if (validated.ok) {
      expect(validated.surfaceId).toBe(String(card.surfaceId))
    }
  })

  test("contracts/a2ui/frame.patch.json has exact keys and valid updateDataModel envelope", () => {
    const raw = JSON.parse(readFileSync(join(contractsDir, "a2ui", "frame.patch.json"), "utf8")) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(["messages", "surfaceId", "threadId", "turnId", "type"])
    expect(raw.type).toBe("a2ui")
    expect(raw.threadId).toBe("brain")
    const validated = validateA2UIMessages(raw.messages)
    expect(validated.ok).toBe(true)
  })

  test("contracts/a2ui/action.request.json has exact keys and passes action validation", () => {
    const raw = JSON.parse(readFileSync(join(contractsDir, "a2ui", "action.request.json"), "utf8")) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(["action", "actionKey", "surfaceId", "turnId"])
    const action = raw.action as Record<string, unknown>
    expect(Object.keys(action).sort()).toEqual(["context", "name"])
    const validated = validateA2UIActionRequest(raw)
    expect(validated.ok).toBe(true)
  })
})

describe("BasicCatalog allowlist and HTML/script rejection", () => {
  test("accepts all 10 allowlisted A2UI 1.0 BasicCatalog components", () => {
    for (const comp of A2UI_BASIC_COMPONENTS) {
      const res = validateA2UIComponent({ id: `node_${comp}`, component: comp })
      expect(res.ok).toBe(true)
    }
  })

  test("rejects unregistered component types", () => {
    for (const bad of ["WebView", "Script", "Iframe", "HtmlView", "MarkdownRaw", ""]) {
      const res = validateA2UIComponent({ id: "x", component: bad })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.error).toContain("unregistered_component")
    }
  })

  test("strictly rejects HTML tags, script tags, event handlers, and javascript: URIs", () => {
    const payloads = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "<div>injected</div>",
      "Hello <br/> world",
      "javascript:alert(1)",
      "<!-- hidden comment -->",
    ]
    for (const p of payloads) {
      expect(containsHtmlOrScript(p)).toBe(true)
      expect(validateA2UIComponent({ id: "t1", component: "Text", text: p })).toEqual({
        ok: false,
        error: "html_not_allowed",
      })
      expect(
        validateA2UIMessage({
          version: "1.0",
          updateDataModel: { surfaceId: "s1", path: "/text", value: p },
        }),
      ).toEqual({ ok: false, error: "html_not_allowed" })
    }
    // Angle-bracket email address is allowed
    expect(containsHtmlOrScript("Jeremie <jeremie@example.com>")).toBe(false)
  })

  test("rejects prototype-pollution JSON pointers", () => {
    const base = { pr: { state: "open" } }
    expect(() => setJsonPointer(base, "/__proto__/polluted", true)).toThrow()
    expect(() => setJsonPointer(base, "/constructor/prototype/polluted", true)).toThrow()
    expect(getJsonPointer(base, "/pr/state")).toBe("open")
  })
})

describe("SQLite TurnCard persistence, JSON-pointer folding, and WS broadcast", () => {
  test("createSurfaceTurn persists readable turn.text + card, and updateSurfaceData folds JSON pointer into SQLite and broadcasts type:a2ui frame", () => {
    const built = buildEmailConfirmSurface({
      to: "client@example.com",
      cc: ["ops@example.com", "finance@example.com"],
      subject: "March Retainer",
      body: "Attached is the March invoice.",
      draftId: "draft-123",
      gmailThreadId: "th-456",
      surfaceId: "email-march",
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return

    const frames: Record<string, unknown>[] = []
    const emitted: unknown[] = []
    const turn = createSurfaceTurn(
      { surfaceId: built.surfaceId, text: built.text, messages: built.messages },
      { emitTurn: (t) => emitted.push(t) },
    )
    expect(emitted).toHaveLength(1)
    expect(turn.text).toContain("March Retainer")
    expect(turn.text).toContain("client@example.com")
    expect(isBrainInternalEvent(turn)).toBe(false)
    expect(classifyBrainEvent(turn)).toBe("silent")
    expect(chat.searchThread("brain", "March Retainer").map((t) => t.id)).toEqual([turn.id])

    // Toggle Cc and patch state via updateSurfaceData
    const ccPatch = updateSurfaceData("email-march", "/email/enabledCc", ["ops@example.com"], {
      broadcast: (f) => frames.push(f),
    })
    expect(ccPatch.ok).toBe(true)

    const statePatch = updateSurfaceData("email-march", "/email/state", "confirmed", {
      broadcast: (f) => frames.push(f),
    })
    expect(statePatch.ok).toBe(true)
    if (!statePatch.ok) return

    // Verify WS frame matches contracts/a2ui/frame.patch.json keys
    expect(Object.keys(statePatch.frame).sort()).toEqual(["messages", "surfaceId", "threadId", "turnId", "type"])
    expect(statePatch.frame).toEqual({
      type: "a2ui",
      threadId: "brain",
      turnId: turn.id,
      surfaceId: "email-march",
      messages: [
        {
          version: "1.0",
          updateDataModel: {
            surfaceId: "email-march",
            path: "/email/state",
            value: "confirmed",
          },
        },
      ],
    })
    expect(frames).toHaveLength(2)

    // Verify reconnecting /api/orchestrator/thread client reads folded state from SQLite immediately
    const persisted = chat.getTurn(turn.id)!
    expect(persisted.card?.kind).toBe("a2ui")
    const model = getSurfaceDataModel(persisted.card!)
    expect(getJsonPointer(model, "/email/enabledCc")).toEqual(["ops@example.com"])
    expect(getJsonPointer(model, "/email/state")).toBe("confirmed")
  })

  test("updateSurfaceComponents folds updated component into persisted createSurface and broadcasts WS frame", () => {
    const built = buildEmailConfirmSurface({
      to: "a@b.com",
      subject: "Hello",
      body: "World",
      surfaceId: "email-comp",
    })
    if (!built.ok) throw new Error("failed")
    const turn = createSurfaceTurn({ surfaceId: built.surfaceId, text: built.text, messages: built.messages }, { emitTurn: () => {} })

    const frames: A2UIFrame[] = []
    const res = updateSurfaceComponents(
      "email-comp",
      [{ id: "confirm_btn", component: "Button", label: "Sent!", disabled: true }],
      { broadcast: (f) => frames.push(f as unknown as A2UIFrame) },
    )
    expect(res.ok).toBe(true)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.messages[0]).toEqual({
      version: "1.0",
      updateComponents: {
        surfaceId: "email-comp",
        components: [{ id: "confirm_btn", component: "Button", label: "Sent!", disabled: true }],
      },
    })
    const persisted = chat.getTurn(turn.id)!
    const createMsg = persisted.card!.messages![0]!
    if (!("createSurface" in createMsg)) throw new Error("expected createSurface")
    const btn = createMsg.createSurface.components.find((c) => c.id === "confirm_btn")
    expect(btn?.label).toBe("Sent!")
    expect(btn?.disabled).toBe(true)
  })

  test("turnId-scoped updateSurfaceData and updateSurfaceComponents mutate the exact turn even when two turns share surfaceId", () => {
    const first = buildEmailConfirmSurface({ to: "one@example.com", subject: "First", body: "1", surfaceId: "dup-surf" })
    const second = buildEmailConfirmSurface({ to: "two@example.com", subject: "Second", body: "2", surfaceId: "dup-surf" })
    if (!first.ok || !second.ok) throw new Error("failed")
    const turn1 = createSurfaceTurn({ surfaceId: "dup-surf", text: first.text, messages: first.messages }, { emitTurn: () => {} })
    const turn2 = createSurfaceTurn({ surfaceId: "dup-surf", text: second.text, messages: second.messages }, { emitTurn: () => {} })

    const patched = updateSurfaceData("dup-surf", "/email/state", "cancelled", {
      turnId: turn1.id,
      broadcast: () => {},
    })
    expect(patched.ok).toBe(true)
    if (patched.ok) expect(patched.frame.turnId).toBe(turn1.id)

    const compPatched = updateSurfaceComponents(
      "dup-surf",
      [{ id: "cancel_btn", component: "Button", label: "Cancelled 1", disabled: true }],
      { turnId: turn1.id, broadcast: () => {} },
    )
    expect(compPatched.ok).toBe(true)

    // turn1 was mutated; turn2 remains untouched ("pending")
    expect(getJsonPointer(getSurfaceDataModel(chat.getTurn(turn1.id)!.card!), "/email/state")).toBe("cancelled")
    expect(getJsonPointer(getSurfaceDataModel(chat.getTurn(turn2.id)!.card!), "/email/state")).toBe("pending")
  })
})

describe("PrGateCard hydration & computeReviewState tier rules", () => {
  test("computeReviewState enforces author match and high/normal/low review tier cascade rules", () => {
    const sha = "deadbeef1234567"
    const claudeApprove = {
      author: { login: "jaubut" },
      body: `🤖 **Auto-review**\n<!-- reviewed-sha: ${sha} -->\nVERDICT: APPROVE`,
    }
    const geminiApprove = {
      author: { login: "jaubut" },
      body: `♊️ **Gemini review** (agy)\n<!-- reviewed-sha: ${sha} -->\nVERDICT: APPROVE`,
    }
    const normalMarker = { author: { login: "jaubut" }, body: "<!-- review-tier: normal -->" }
    const lowMarker = { author: { login: "jaubut" }, body: "<!-- review-tier: low -->" }

    // Unmarked / high tier requires BOTH Claude and Gemini/Codex from the PR author
    expect(computeReviewState([claudeApprove], sha, "", "jaubut", [{ path: "server/a.ts" }])).toBe("pending")
    expect(computeReviewState([geminiApprove], sha, "", "jaubut", [{ path: "server/a.ts" }])).toBe("pending")
    expect(computeReviewState([claudeApprove, geminiApprove], sha, "", "jaubut", [{ path: "server/a.ts" }])).toBe("approved")

    // Foreign author comments are ignored
    expect(
      computeReviewState(
        [
          { ...claudeApprove, author: { login: "impostor" } },
          { ...geminiApprove, author: { login: "impostor" } },
        ],
        sha,
        "APPROVED",
        "jaubut",
        [{ path: "server/a.ts" }],
      ),
    ).toBe("pending")

    // Normal tier non-client requires Gemini (or Claude when claudeNormal is true)
    expect(
      computeReviewState([normalMarker, geminiApprove], sha, "", "jaubut", [{ path: "server/a.ts" }], {
        claudeNormal: false,
      }),
    ).toBe("approved")
    expect(
      computeReviewState([normalMarker, claudeApprove], sha, "", "jaubut", [{ path: "server/a.ts" }], {
        claudeNormal: true,
      }),
    ).toBe("approved")

    // Low tier on allowlisted files approves with 0 reviews, unless CHANGES on head
    expect(computeReviewState([lowMarker], sha, "", "jaubut", [{ path: "docs/plan.md" }, { path: "server/a.test.ts" }])).toBe("approved")
    expect(
      computeReviewState(
        [
          lowMarker,
          { author: { login: "jaubut" }, body: `🤖 **Auto-review**\n<!-- reviewed-sha: ${sha} -->\nVERDICT: CHANGES` },
        ],
        sha,
        "",
        "jaubut",
        [{ path: "docs/plan.md" }],
      ),
    ).toBe("changes_requested")
  })
  test("hydrates green + approved PR with deploy button when deployRepo is provided", async () => {
    const hydrated = await hydratePrGateData(
      { repo: "jaubut/claude-companion", pr: 412, deployRepo: "claude-companion" },
      async () => ({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: false,
          headRefName: "dispatch/01234567",
          headRefOid: "deadbeef1234567",
          baseRefName: "main",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          url: "https://github.com/jaubut/claude-companion/pull/412",
          title: "feat(a2ui): vertical slice",
          author: { login: "jaubut" },
          labels: [],
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS", name: "test" }],
          comments: [
            {
              author: { login: "jaubut" },
              body: "🤖 **Auto-review**\n<!-- reviewed-sha: deadbeef1234567 -->\nVERDICT: APPROVE",
            },
            {
              author: { login: "jaubut" },
              body: "♊️ **Gemini review** (agy)\n<!-- reviewed-sha: deadbeef1234567 -->\nVERDICT: APPROVE",
            },
          ],
          files: [],
        }),
      }),
    )
    expect(hydrated.ok).toBe(true)
    if (!hydrated.ok) return
    expect(hydrated.pr).toEqual({
      repo: "jaubut/claude-companion",
      number: 412,
      title: "feat(a2ui): vertical slice",
      url: "https://github.com/jaubut/claude-companion/pull/412",
      headSha: "deadbeef1234567",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      ciState: "green",
      reviewState: "approved",
      state: "open",
      deployRepo: "claude-companion",
    })
    const surface = buildPrGateSurface(hydrated.pr)
    expect(surface.ok).toBe(true)
    if (!surface.ok) return
    const cs = (surface.messages[0] as { createSurface: { components: Array<{ id: string; action?: { name: string } }> } }).createSurface
    expect(cs.components.map((c) => c.action?.name).filter(Boolean)).toEqual(["pr.refresh", "pr.merge", "pr.close", "pr.deploy"])
  })
})
