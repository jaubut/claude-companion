import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { REPO_NAME_RE, SAFE_IDENTIFIER_RE, TASK_ID_RE, type WorkerFamily } from "./worker-invocation"

export type TargetHost = "zettlab" | "mac" | "auto"

export interface GithubIssueDispatch {
  repoFull: string
  owner: string
  repo: string
  issueNumber: number
  title: string
  body: string
  url: string
  action: "opened" | "reopened" | "labeled"
  labels: string[]
  addedLabel: string | null
  sender: string | null
  taskId: string
  targetHost: TargetHost
  family: WorkerFamily
  model: string | null
  forceRedispatch: boolean
}

export type GithubWebhookAction =
  | { kind: "ping"; hookId: number | null; repo: string | null }
  | { kind: "ignored"; reason: string; repo?: string; issueNumber?: number }
  | { kind: "dispatch"; req: GithubIssueDispatch }

const TRIGGER_ACTIONS = new Set(["opened", "reopened", "labeled"])
const SKIP_LABELS = new Set(["no-dispatch", "wontfix", "invalid", "duplicate"])
const REDISPATCH_LABELS = new Set(["dispatch", "re-dispatch", "redispatch", "retry"])
const SHA256_SIG_RE = /^sha256=([0-9a-f]{64})$/i
const BODY_MAX = 40_000

export function githubWebhookSecretPath(home: string = homedir()): string {
  return join(home, ".claude-companion", "github-webhook.secret")
}

/** Load `GITHUB_WEBHOOK_SECRET` or read/create `~/.claude-companion/github-webhook.secret` (0600). */
export function getGithubWebhookSecret(opts: { env?: NodeJS.ProcessEnv; secretFile?: string } = {}): string {
  const env = opts.env ?? process.env
  const fromEnv = env.GITHUB_WEBHOOK_SECRET?.trim()
  if (fromEnv && fromEnv.length >= 16) return fromEnv
  const file = opts.secretFile ?? githubWebhookSecretPath()
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim()
    if (raw.length >= 16) return raw
  }
  const generated = randomBytes(32).toString("hex")
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(file, `${generated}\n`, { mode: 0o600, flag: "wx" })
    chmodSync(file, 0o600)
    return generated
  } catch {
    try {
      const existing = readFileSync(file, "utf8").trim()
      if (existing.length >= 16) return existing
    } catch { /* fall through */ }
    return generated
  }
}

/** Constant-time verification of GitHub's `X-Hub-Signature-256: sha256=<hex>` header. */
export function verifyGithubSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!secret || !signatureHeader) return false
  const m = SHA256_SIG_RE.exec(signatureHeader.trim())
  if (!m) return false
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest()
  const presented = Buffer.from(m[1]!, "hex")
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

export function buildGithubIssueTaskId(repo: string, issueNumber: number): string {
  const suffix = `-issue-${Math.max(1, Math.floor(issueNumber))}`
  const maxRepo = Math.max(1, 64 - 3 - suffix.length)
  const slug = (repo.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo").slice(0, maxRepo).replace(/-+$/, "") || "repo"
  const candidate = `gh-${slug}${suffix}`
  return TASK_ID_RE.test(candidate) ? candidate : `gh-issue-${issueNumber}`.slice(0, 64)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function extractLabels(issue: Record<string, unknown>, payloadLabel: Record<string, unknown> | null): string[] {
  const seen = new Set<string>()
  const rawList = Array.isArray(issue.labels) ? issue.labels : []
  for (const item of rawList) {
    const name = typeof item === "string" ? item : str(asRecord(item)?.name)
    const clean = name.trim().toLowerCase()
    if (clean) seen.add(clean)
  }
  const added = str(payloadLabel?.name).trim().toLowerCase()
  if (added) seen.add(added)
  return [...seen]
}

function resolveTargetHost(labels: readonly string[], title: string, body: string): TargetHost {
  const set = new Set(labels)
  if (set.has("host:zettlab") || set.has("zettlab")) return "zettlab"
  if (set.has("host:mac") || set.has("mac")) return "mac"
  const tag = /\[host:(zettlab|mac)\]/i.exec(`${title}\n${body.slice(0, 1000)}`)
  if (tag) return tag[1]!.toLowerCase() as "zettlab" | "mac"
  return "auto"
}

function resolveFamily(labels: readonly string[], title: string, body: string): WorkerFamily {
  const set = new Set(labels)
  if (set.has("agent:codex") || set.has("codex")) return "codex"
  if (set.has("agent:gemini") || set.has("gemini")) return "gemini"
  if (set.has("agent:claude") || set.has("claude")) return "claude"
  const tag = /\[agent:(claude|codex|gemini)\]/i.exec(`${title}\n${body.slice(0, 1000)}`)
  if (tag) return tag[1]!.toLowerCase() as WorkerFamily
  return "claude"
}

function resolveModel(labels: readonly string[], family: WorkerFamily): string | null {
  for (const label of labels) {
    if (label.startsWith("model:")) {
      const raw = label.slice("model:".length).trim()
      if (raw === "opus" && family === "claude") return "claude-opus-5-5"
      if (raw === "sonnet" && family === "claude") return "claude-sonnet-5-5"
      if (SAFE_IDENTIFIER_RE.test(raw)) return raw
    }
  }
  if (family === "claude") {
    if (labels.includes("opus")) return "claude-opus-5-5"
    if (labels.includes("sonnet")) return "claude-sonnet-5-5"
  }
  return null
}

export function allowedWebhookOwners(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = env.GITHUB_WEBHOOK_ALLOWED_OWNERS?.trim()
  if (!raw) return new Set(["jaubut"])
  const set = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
  return set.size ? set : new Set(["jaubut"])
}

/** Parse a verified GitHub webhook event into a dispatch or no-op action. */
export function parseGithubWebhookEvent(
  eventName: string | null,
  payload: unknown,
  opts: { allowedOwners?: ReadonlySet<string> } = {},
): GithubWebhookAction {
  const root = asRecord(payload)
  if (!root) return { kind: "ignored", reason: "invalid_payload" }
  const ev = (eventName ?? "").trim().toLowerCase()
  const repoObj = asRecord(root.repository)
  const repoFull = str(repoObj?.full_name).trim() || null

  if (ev === "ping") {
    const hookId = typeof root.hook_id === "number" ? root.hook_id : null
    return { kind: "ping", hookId, repo: repoFull }
  }
  if (ev !== "issues") {
    return { kind: "ignored", reason: `unsupported_event:${ev || "missing"}`, ...(repoFull ? { repo: repoFull } : {}) }
  }

  const issue = asRecord(root.issue)
  const issueNumber = typeof issue?.number === "number" && Number.isInteger(issue.number) && issue.number > 0 ? issue.number : 0
  if (!repoObj || !repoFull || !issue || !issueNumber) {
    return { kind: "ignored", reason: "missing_issue_or_repo" }
  }

  const owner = (str(asRecord(repoObj.owner)?.login) || repoFull.split("/")[0] || "").trim().toLowerCase()
  const repo = (str(repoObj.name) || repoFull.split("/")[1] || "").trim()
  if (!owner || !REPO_NAME_RE.test(repo)) {
    return { kind: "ignored", reason: "invalid_repo", repo: repoFull, issueNumber }
  }
  const allowedOwners = opts.allowedOwners ?? allowedWebhookOwners()
  if (!allowedOwners.has(owner)) {
    return { kind: "ignored", reason: `owner_not_allowed:${owner}`, repo: repoFull, issueNumber }
  }

  const action = str(root.action).trim().toLowerCase()
  if (!TRIGGER_ACTIONS.has(action)) {
    return { kind: "ignored", reason: `ignored_action:${action || "none"}`, repo: repoFull, issueNumber }
  }
  if (issue.pull_request != null) {
    return { kind: "ignored", reason: "is_pull_request", repo: repoFull, issueNumber }
  }
  if (str(issue.state).trim().toLowerCase() !== "open") {
    return { kind: "ignored", reason: "issue_not_open", repo: repoFull, issueNumber }
  }

  const payloadLabel = asRecord(root.label)
  const addedLabel = str(payloadLabel?.name).trim() || null
  const labels = extractLabels(issue, payloadLabel)
  const skip = labels.find((l) => SKIP_LABELS.has(l))
  if (skip) {
    return { kind: "ignored", reason: `skip_label:${skip}`, repo: repoFull, issueNumber }
  }

  const title = str(issue.title).trim() || `Issue #${issueNumber}`
  const body = str(issue.body).trim()
  const url = str(issue.html_url).trim() || `https://github.com/${repoFull}/issues/${issueNumber}`
  const sender = str(asRecord(root.sender)?.login).trim() || null
  const targetHost = resolveTargetHost(labels, title, body)
  const family = resolveFamily(labels, title, body)
  const model = resolveModel(labels, family)
  const forceRedispatch = action === "labeled" && addedLabel !== null && REDISPATCH_LABELS.has(addedLabel.toLowerCase())

  return {
    kind: "dispatch",
    req: {
      repoFull,
      owner,
      repo,
      issueNumber,
      title,
      body,
      url,
      action: action as "opened" | "reopened" | "labeled",
      labels,
      addedLabel,
      sender,
      taskId: buildGithubIssueTaskId(repo, issueNumber),
      targetHost,
      family,
      model,
      forceRedispatch,
    },
  }
}

/** Build a self-contained headless builder prompt from a GitHub issue event. */
export function buildGithubIssuePrompt(d: GithubIssueDispatch): string {
  const labelsText = d.labels.length ? d.labels.join(", ") : "(none)"
  const bodyText = d.body ? d.body.slice(0, BODY_MAX) : "(No issue description provided.)"
  return [
    `GitHub Issue Dispatched Automatically via Companion Webhook`,
    `- Repository: ${d.repoFull}`,
    `- Issue: #${d.issueNumber} — ${d.title}`,
    `- URL: ${d.url}`,
    `- Trigger: issues.${d.action}${d.addedLabel ? ` (label: ${d.addedLabel})` : ""}${d.sender ? ` by @${d.sender}` : ""}`,
    `- Labels: ${labelsText}`,
    `- Target branch: dispatch/${d.taskId}`,
    "",
    "## Issue Specification",
    bodyText,
    "",
    "## Execution Requirements",
    "1. Inspect the repository first (`README.md`, `CAD_SPEC.md`, `CLAUDE.md`, `pyproject.toml`, `package.json`, existing tests/files) so your implementation matches every specification detail.",
    "2. Work inside this isolated git worktree (`dispatch/" + d.taskId + "`). Implement all requested deliverables cleanly.",
    "3. Python / CAD environment note: if this repository uses `build123d` or `cadquery-ocp`, create and use a Python 3.12 virtualenv via `uv venv --python 3.12` and `uv pip install` / `uv run --python 3.12` (do not use system Python 3.14, as binary CAD wheels target Python 3.11/3.12).",
    "4. Run all automated verification (`pytest`, `bun test`, typechecks, generators/exports) after your final edits and confirm every check passes and every requested artifact is generated.",
    `5. Stage and commit all code, tests, and required generated artifacts cleanly on \`dispatch/${d.taskId}\`, push to \`origin\`, and open a Pull Request against \`${d.repoFull}\` whose body includes \`Closes #${d.issueNumber}\` and a concise verification summary.`,
    `6. In your final message, print the full GitHub Pull Request URL (\`https://github.com/${d.repoFull}/pull/<number>\`) and exact test/command results.`,
  ].join("\n")
}
