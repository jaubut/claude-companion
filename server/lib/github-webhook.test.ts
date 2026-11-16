import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildGithubIssuePrompt,
  buildGithubIssueTaskId,
  getGithubWebhookSecret,
  parseGithubWebhookEvent,
  verifyGithubSignature,
} from "./github-webhook"
import { TASK_ID_RE } from "./worker-invocation"

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`
}

describe("github-webhook lib", () => {
  test("verifyGithubSignature checks HMAC-SHA256 in constant time", () => {
    const secret = "0123456789abcdef0123456789abcdef"
    const body = JSON.stringify({ action: "opened", issue: { number: 1 } })
    const sig = sign(secret, body)

    expect(verifyGithubSignature(body, sig, secret)).toBe(true)
    expect(verifyGithubSignature(body, sig.toUpperCase(), secret)).toBe(true)
    expect(verifyGithubSignature(`${body} `, sig, secret)).toBe(false)
    expect(verifyGithubSignature(body, `sha256=${"0".repeat(64)}`, secret)).toBe(false)
    expect(verifyGithubSignature(body, "sha256=short", secret)).toBe(false)
    expect(verifyGithubSignature(body, null, secret)).toBe(false)
    expect(verifyGithubSignature(body, sig, "")).toBe(false)
  })

  test("getGithubWebhookSecret creates private secret file and honors env override", () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-secret-"))
    try {
      const secretFile = join(dir, "github-webhook.secret")
      const created = getGithubWebhookSecret({ env: {}, secretFile })
      expect(created.length).toBeGreaterThanOrEqual(32)
      expect(statSync(secretFile).mode & 0o777).toBe(0o600)
      expect(getGithubWebhookSecret({ env: {}, secretFile })).toBe(created)
      expect(getGithubWebhookSecret({ env: { GITHUB_WEBHOOK_SECRET: "env-override-secret-12345" }, secretFile })).toBe("env-override-secret-12345")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("parseGithubWebhookEvent handles ping and issue routing labels", () => {
    const ping = parseGithubWebhookEvent("ping", { hook_id: 42, repository: { full_name: "jaubut/ndi-tx-enclosure" } })
    expect(ping).toEqual({ kind: "ping", hookId: 42, repo: "jaubut/ndi-tx-enclosure" })

    const labeled = parseGithubWebhookEvent("issues", {
      action: "labeled",
      label: { name: "dispatch" },
      sender: { login: "jaubut" },
      repository: { full_name: "jaubut/ndi-tx-enclosure", name: "ndi-tx-enclosure", owner: { login: "jaubut" } },
      issue: {
        number: 1,
        state: "open",
        title: "feat(cad): Build parametric enclosure",
        body: "Implement CAD_SPEC.md",
        html_url: "https://github.com/jaubut/ndi-tx-enclosure/issues/1",
        labels: [{ name: "host:zettlab" }, { name: "agent:codex" }, { name: "dispatch" }],
      },
    })

    expect(labeled.kind).toBe("dispatch")
    if (labeled.kind === "dispatch") {
      expect(labeled.req.taskId).toBe("gh-ndi-tx-enclosure-issue-1")
      expect(labeled.req.targetHost).toBe("zettlab")
      expect(labeled.req.family).toBe("codex")
      expect(labeled.req.forceRedispatch).toBe(true)
      const prompt = buildGithubIssuePrompt(labeled.req)
      expect(prompt).toContain("jaubut/ndi-tx-enclosure")
      expect(prompt).toContain("Closes #1")
      expect(prompt).toContain("uv venv --python 3.12")
    }
  })

  test("parseGithubWebhookEvent ignores skip labels, closed issues, PRs, and foreign owners", () => {
    const baseRepo = { full_name: "jaubut/ndi-tx-enclosure", name: "ndi-tx-enclosure", owner: { login: "jaubut" } }
    expect(parseGithubWebhookEvent("issues", {
      action: "opened",
      repository: baseRepo,
      issue: { number: 2, state: "open", title: "Skip", labels: [{ name: "no-dispatch" }] },
    }).kind).toBe("ignored")

    expect(parseGithubWebhookEvent("issues", {
      action: "labeled",
      label: { name: "dispatch" },
      repository: baseRepo,
      issue: { number: 3, state: "closed", title: "Closed", labels: [] },
    }).kind).toBe("ignored")

    expect(parseGithubWebhookEvent("issues", {
      action: "opened",
      repository: baseRepo,
      issue: { number: 4, state: "open", title: "PR", pull_request: { url: "..." }, labels: [] },
    }).kind).toBe("ignored")

    expect(parseGithubWebhookEvent("issues", {
      action: "opened",
      repository: { full_name: "other/repo", name: "repo", owner: { login: "other" } },
      issue: { number: 5, state: "open", title: "Foreign", labels: [] },
    }).kind).toBe("ignored")
  })

  test("buildGithubIssueTaskId always fits TASK_ID_RE", () => {
    const longId = buildGithubIssueTaskId("a".repeat(80), 999999)
    expect(longId.length).toBeLessThanOrEqual(64)
    expect(TASK_ID_RE.test(longId)).toBe(true)
    expect(longId.endsWith("-issue-999999")).toBe(true)
  })
})
