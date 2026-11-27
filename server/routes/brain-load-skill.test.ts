import { describe, expect, test } from "bun:test"
import { BRAIN_AGENT } from "../lib/brain"
import type { Session } from "../lib/sessions"
import { DynamicSkillRegistry } from "../lib/skill-retrieval"
import { executeLoadSkill } from "../lib/skill-tools"
import { SkillManifestSchema } from "../lib/skill-types"
import { recordPeer } from "../lib/vault-guard"
import type { BrainWiring } from "../wiring/brain"
import { createBrainRoute } from "./brain"

describe("POST /hooks/brain/load-skill", () => {
  const registry = new DynamicSkillRegistry([
    SkillManifestSchema.parse({
      id: "cso",
      name: "Chief Security Officer",
      description: "OWASP + STRIDE security review.",
      triggers: ["/cso", "security audit"],
      category: "ops",
      alwaysInclude: false,
      estimatedTokens: 120,
      content: "# CSO Skill\nRun full OWASP + STRIDE review.",
    }),
  ])

  const brainSession = {
    key: "headless:brain",
    sessionId: "sid-brain-1",
    taskId: BRAIN_AGENT,
    pid: "5150",
    cwd: "/srv/brain",
    label: "brain",
  } as unknown as Session

  const route = createBrainRoute({
    wiring: {
      status: () => ({ state: "up", sessionKey: "headless:brain", since: 1, restarts: 0, host: "test", activity: null }),
    } as unknown as BrainWiring,
    enabled: () => true,
    sessions: () => [brainSession],
    loadSkill: (args) => executeLoadSkill(registry, args),
  })

  function makeReq(body: unknown, opts: { peer?: string; taskId?: string; pid?: string } = {}): Request {
    const req = new Request("http://127.0.0.1:4245/hooks/brain/load-skill", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Companion-Task-Id": opts.taskId ?? "brain",
        "X-Companion-Pid": opts.pid ?? "5150",
      },
      body: JSON.stringify(body),
    })
    recordPeer(req, opts.peer ?? "127.0.0.1")
    return req
  }

  test("enforces loopback Brain PID auth and returns 200 with full SKILL.md on valid skillId", async () => {
    const nonLoopback = makeReq({ skillId: "cso" }, { peer: "100.64.1.9" })
    expect((await route(nonLoopback, new URL(nonLoopback.url)))?.status).toBe(403)

    const wrongPid = makeReq({ skillId: "cso" }, { pid: "9999" })
    expect((await route(wrongPid, new URL(wrongPid.url)))?.status).toBe(403)

    const badInput = makeReq({ skillId: "" })
    const badRes = await route(badInput, new URL(badInput.url))
    expect(badRes?.status).toBe(400)

    const missing = makeReq({ skillId: "nonexistent-skill" })
    const missingRes = await route(missing, new URL(missing.url))
    expect(missingRes?.status).toBe(404)

    const valid = makeReq({ skillId: "cso" })
    const validRes = await route(valid, new URL(valid.url))
    expect(validRes?.status).toBe(200)
    const json = (await validRes!.json()) as { ok: boolean; skillId: string; content: string }
    expect(json).toMatchObject({
      ok: true,
      skillId: "cso",
      content: "# CSO Skill\nRun full OWASP + STRIDE review.",
    })
  })
})

describe("POST /api/brain/stream", () => {
  test("streams Spec §4 OrchestratorEvent SSE frames behind Bearer auth", async () => {
    const { getAuthToken } = await import("../lib/auth")
    const { parseOrchestratorSseChunk } = await import("../lib/gemini4-orchestrator-client")
    const token = getAuthToken()

    const sseRoute = createBrainRoute({
      wiring: {
        status: () => ({ state: "up", sessionKey: "headless:brain", since: 1, restarts: 0, host: "test", activity: null }),
      } as unknown as BrainWiring,
      enabled: () => true,
      sessions: () => [],
      streamTransport: async function* () {
        yield {
          parts: [
            { thought: true, text: "Evaluating query..." },
            { text: "System is healthy." },
          ],
          usage: { promptTokens: 512, cachedPromptTokens: 0, outputTokens: 12 },
        }
      },
    })

    const unauthReq = new Request("http://127.0.0.1:4245/api/brain/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Health check?" }),
    })
    expect((await sseRoute(unauthReq, new URL(unauthReq.url)))?.status).toBe(401)

    const authReq = new Request("http://127.0.0.1:4245/api/brain/stream", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ prompt: "Health check?", sessionId: "sse_route_test" }),
    })
    const res = await sseRoute(authReq, new URL(authReq.url))
    expect(res?.status).toBe(200)
    expect(res?.headers.get("Content-Type")).toContain("text/event-stream")

    const bodyText = await res!.text()
    const events = parseOrchestratorSseChunk(bodyText)
    expect(events.map((e) => e.event)).toEqual(["thinking_delta", "text_delta", "done"])
  })
})

