import { randomUUID } from "node:crypto"
import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_VERSION,
  type A2UIComponent,
  type A2UIEngineDeps,
  type A2UIMessage,
  SURFACE_ID_RE,
  containsHtmlOrScript,
  createSurfaceTurn,
  isValidJsonPointer,
  updateSurfaceComponents,
  updateSurfaceData,
  validateA2UIMessages,
} from "./a2ui"
import { type Turn, getTurn } from "./orchestrator-chat"
import { type GhFn, realGh } from "./triage-pr"
import type { DeployResult } from "../wiring/auto-deploy"
import type { mergeAgentPr } from "../wiring/brain-pr-merge"

export { handleA2UIAction } from "./a2ui-actions"

// Server-side A2UI v1.0 macro expansion (`EmailConfirmCard`, `PrGateCard`, `patch`, `custom`).

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const CLAUDE_HEADING = /^\s*🤖 \*\*Auto-review\*\*/u
const GEMINI_HEADING = /^♊️? \*\*Gemini review\*\* \(agy\b/u
const CODEX_HEADING = /^\s*🧠 \*\*Codex review\*\*/u
const PR_VIEW_FIELDS =
  "state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,url,title,author,labels,statusCheckRollup,comments,files"

export interface EmailMacroInput {
  to: string
  cc?: string | string[] | null
  subject: string
  body: string
  draftId?: string | null
  gmailThreadId?: string | null
  surfaceId?: string | null
}

export interface PrMacroInput {
  repo: string
  pr: number
  deployRepo?: string | null
  surfaceId?: string | null
}

export interface HydratedPrData {
  repo: string
  number: number
  title: string
  url: string
  headSha: string
  mergeable: string
  mergeStateStatus: string
  ciState: "green" | "pending" | "failed"
  reviewState: "approved" | "changes_requested" | "pending"
  state: "open" | "merged" | "closed"
  deployRepo: string | null
}

export interface MacroOutcome {
  status: number
  body: Record<string, unknown>
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): MacroOutcome => ({
  status,
  body: { ok: false, error, ...extra },
})

export function parseCcList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === "") return []
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (Array.isArray(raw)) {
    if (!raw.every((x) => typeof x === "string")) return null
    return (raw as string[]).map((s) => s.trim()).filter(Boolean)
  }
  return null
}

/** Build the canonical A2UI v1.0 EmailConfirmCard surface message and human-readable text summary. */
export function buildEmailConfirmSurface(input: EmailMacroInput): {
  ok: true
  surfaceId: string
  text: string
  messages: A2UIMessage[]
  dataModel: Record<string, unknown>
} | { ok: false; error: string } {
  const to = typeof input.to === "string" ? input.to.trim() : ""
  if (!to) return { ok: false, error: "to_required" }
  const subject = typeof input.subject === "string" ? input.subject.trim() : ""
  if (!subject) return { ok: false, error: "subject_required" }
  const body = typeof input.body === "string" ? input.body.trim() : ""
  if (!body) return { ok: false, error: "body_required" }
  const cc = parseCcList(input.cc)
  if (!cc) return { ok: false, error: "invalid_cc" }
  const draftId = typeof input.draftId === "string" && input.draftId.trim() ? input.draftId.trim() : null
  const gmailThreadId = typeof input.gmailThreadId === "string" && input.gmailThreadId.trim() ? input.gmailThreadId.trim() : null
  const surfaceId = typeof input.surfaceId === "string" && input.surfaceId.trim()
    ? input.surfaceId.trim()
    : `email-${randomUUID().slice(0, 8)}`
  if (!SURFACE_ID_RE.test(surfaceId)) return { ok: false, error: "invalid_surface_id" }

  if (containsHtmlOrScript({ to, cc, subject, body, draftId, gmailThreadId })) {
    return { ok: false, error: "html_not_allowed" }
  }

  const ccCheckIds = cc.map((_, i) => `cc_check_${i}`)
  const colChildren = [
    "header_row",
    "to_text",
    "cc_picker",
    ...ccCheckIds,
    "divider",
    "body_text",
    "actions_row",
  ]

  const components: A2UIComponent[] = [
    { id: "root", component: "Card", children: ["col"] },
    { id: "col", component: "Column", children: colChildren },
    { id: "header_row", component: "Row", children: ["subject_text", "state_badge"] },
    { id: "subject_text", component: "Text", text: { "@path": "/email/subject" }, variant: "title" },
    { id: "state_badge", component: "Badge", text: { "@path": "/email/state" } },
    { id: "to_text", component: "Text", text: `To: ${to}`, variant: "caption" },
    {
      id: "cc_picker",
      component: "ChoicePicker",
      label: "Cc",
      multiple: true,
      options: cc.map((addr) => ({ value: addr, label: addr })),
      value: { "@path": "/email/enabledCc" },
    },
    ...cc.map((addr, i): A2UIComponent => ({
      id: `cc_check_${i}`,
      component: "CheckBox",
      label: addr,
      value: addr,
      checked: true,
    })),
    { id: "divider", component: "Divider" },
    { id: "body_text", component: "Text", text: { "@path": "/email/body" }, variant: "body" },
    { id: "actions_row", component: "Row", children: ["confirm_btn", "cancel_btn"] },
    {
      id: "confirm_btn",
      component: "Button",
      label: "Send Email",
      variant: "primary",
      action: {
        name: "email.confirm",
        context: {
          enabledCc: { "@path": "/email/enabledCc" },
        },
      },
    },
    {
      id: "cancel_btn",
      component: "Button",
      label: "Cancel",
      variant: "secondary",
      action: { name: "email.cancel" },
    },
  ]

  const dataModel: Record<string, unknown> = {
    email: {
      to,
      cc,
      enabledCc: [...cc],
      subject,
      body,
      draftId,
      gmailThreadId,
      state: "pending",
    },
  }

  const messages: A2UIMessage[] = [
    {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId,
        catalogId: A2UI_BASIC_CATALOG_ID,
        components,
        dataModel,
      },
    },
  ]

  const text = `Email confirm: "${subject}" → ${to}${cc.length ? ` (Cc: ${cc.join(", ")})` : ""}\n${body}`
  return { ok: true, surfaceId, text, messages, dataModel }
}

interface GhCheck {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

interface GhComment {
  body?: string
  author?: { login?: string } | null
}

function checkPassed(c: GhCheck): boolean {
  if (c.__typename === "StatusContext" || (c.state !== undefined && c.conclusion === undefined)) {
    return c.state === "SUCCESS"
  }
  return c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(c.conclusion))
}

function checkFailed(c: GhCheck): boolean {
  if (c.__typename === "StatusContext" || (c.state !== undefined && c.conclusion === undefined)) {
    return ["FAILURE", "ERROR"].includes(String(c.state))
  }
  return (
    c.status === "COMPLETED" &&
    ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(String(c.conclusion))
  )
}

function computeCiState(checks: GhCheck[], mergeable: string, mergeStateStatus: string): "green" | "pending" | "failed" {
  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") return "failed"
  if (checks.some(checkFailed)) return "failed"
  if (checks.length === 0) return "pending"
  if (checks.every(checkPassed) && checks.some((c) => c.conclusion === "SUCCESS" || c.state === "SUCCESS")) {
    return "green"
  }
  return "pending"
}

function computeReviewState(
  comments: GhComment[],
  headSha: string,
  reviewDecision: string,
): "approved" | "changes_requested" | "pending" {
  if (reviewDecision === "CHANGES_REQUESTED") return "changes_requested"
  const stamp = headSha ? `<!-- reviewed-sha: ${headSha} -->` : ""
  const headBodies = stamp
    ? comments.map((c) => String(c.body ?? "")).filter((b) => b.includes(stamp))
    : []
  const reviewBodies = headBodies.filter((b) => CLAUDE_HEADING.test(b) || GEMINI_HEADING.test(b) || CODEX_HEADING.test(b))
  if (reviewBodies.some((b) => /VERDICT:\s*CHANGES/i.test(b))) return "changes_requested"
  if (reviewBodies.some((b) => /VERDICT:\s*APPROVE/i.test(b)) || reviewDecision === "APPROVED") return "approved"
  return "pending"
}

function stripAngleTags(s: string): string {
  return s.replace(/</g, "‹").replace(/>/g, "›")
}

/** Hydrate live PR status via read-only `gh pr view`. */
export async function hydratePrGateData(
  input: PrMacroInput,
  gh: GhFn = realGh,
): Promise<{ ok: true; pr: HydratedPrData } | { ok: false; status: number; body: Record<string, unknown> }> {
  const repo = typeof input.repo === "string" && REPO_RE.test(input.repo.trim()) ? input.repo.trim() : ""
  if (!repo) return { ok: false, status: 400, body: { ok: false, error: "repo must be owner/name" } }
  const prNum = typeof input.pr === "number" && Number.isInteger(input.pr) && input.pr > 0 ? input.pr : 0
  if (!prNum) return { ok: false, status: 400, body: { ok: false, error: "pr must be a PR number" } }
  const deployRepo = typeof input.deployRepo === "string" && input.deployRepo.trim() ? input.deployRepo.trim() : null
  if (deployRepo && containsHtmlOrScript(deployRepo)) {
    return { ok: false, status: 400, body: { ok: false, error: "html_not_allowed" } }
  }

  let res: Awaited<ReturnType<GhFn>>
  try {
    res = await gh(["pr", "view", String(prNum), "--repo", repo, "--json", PR_VIEW_FIELDS])
  } catch (err) {
    return {
      ok: false,
      status: 503,
      body: { ok: false, error: "gh_unreachable", detail: String((err as Error)?.message ?? "").slice(0, 200) },
    }
  }
  if (res.code !== 0) {
    return {
      ok: false,
      status: 404,
      body: { ok: false, error: "pr_not_found", detail: res.stderr.trim().slice(0, 200) },
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(res.stdout) as Record<string, unknown>
  } catch {
    return { ok: false, status: 502, body: { ok: false, error: "gh_bad_json" } }
  }

  const rawState = String(parsed.state ?? "OPEN").toUpperCase()
  const state: "open" | "merged" | "closed" =
    rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : "open"
  const title = stripAngleTags(String(parsed.title ?? `${repo}#${prNum}`).trim())
  const url = String(parsed.url ?? `https://github.com/${repo}/pull/${prNum}`)
  const headSha = String(parsed.headRefOid ?? "")
  const mergeable = String(parsed.mergeable ?? "UNKNOWN")
  const mergeStateStatus = String(parsed.mergeStateStatus ?? "UNKNOWN")
  const reviewDecision = String(parsed.reviewDecision ?? "")
  const checks = Array.isArray(parsed.statusCheckRollup) ? (parsed.statusCheckRollup as GhCheck[]) : []
  const comments = Array.isArray(parsed.comments) ? (parsed.comments as GhComment[]) : []

  const ciState = computeCiState(checks, mergeable, mergeStateStatus)
  const reviewState = computeReviewState(comments, headSha, reviewDecision)

  return {
    ok: true,
    pr: {
      repo,
      number: prNum,
      title,
      url,
      headSha,
      mergeable,
      mergeStateStatus,
      ciState,
      reviewState,
      state,
      deployRepo,
    },
  }
}

/** Build the canonical A2UI v1.0 PrGateCard surface message from hydrated PR data. */
export function buildPrGateSurface(
  pr: HydratedPrData,
  customSurfaceId?: string | null,
): { ok: true; surfaceId: string; text: string; messages: A2UIMessage[]; dataModel: Record<string, unknown> } | { ok: false; error: string } {
  const defaultId = `pr-${pr.repo.replace(/[^A-Za-z0-9_.-]/g, "-")}-${pr.number}`
  const surfaceId = typeof customSurfaceId === "string" && customSurfaceId.trim() ? customSurfaceId.trim() : defaultId
  if (!SURFACE_ID_RE.test(surfaceId)) return { ok: false, error: "invalid_surface_id" }

  const actionIds = ["refresh_btn", "merge_btn", ...(pr.deployRepo ? ["deploy_btn"] : [])]
  const components: A2UIComponent[] = [
    { id: "root", component: "Card", children: ["col"] },
    { id: "col", component: "Column", children: ["header_row", "meta_row", "url_text", "divider", "actions_row"] },
    { id: "header_row", component: "Row", children: ["title_text", "state_badge"] },
    { id: "title_text", component: "Text", text: { "@path": "/pr/title" }, variant: "title" },
    { id: "state_badge", component: "Badge", text: { "@path": "/pr/state" } },
    { id: "meta_row", component: "Row", children: ["ci_badge", "review_badge", "sha_text"] },
    { id: "ci_badge", component: "Badge", text: { "@path": "/pr/ciState" } },
    { id: "review_badge", component: "Badge", text: { "@path": "/pr/reviewState" } },
    { id: "sha_text", component: "Text", text: { "@path": "/pr/headSha" }, variant: "caption" },
    { id: "url_text", component: "Text", text: { "@path": "/pr/url" }, variant: "caption" },
    { id: "divider", component: "Divider" },
    { id: "actions_row", component: "Row", children: actionIds },
    {
      id: "refresh_btn",
      component: "Button",
      label: "Refresh",
      variant: "secondary",
      action: { name: "pr.refresh", context: { repo: pr.repo, pr: pr.number } },
    },
    {
      id: "merge_btn",
      component: "Button",
      label: "Merge PR",
      variant: "primary",
      action: { name: "pr.merge", context: { repo: pr.repo, pr: pr.number } },
    },
    ...(pr.deployRepo
      ? [
          {
            id: "deploy_btn",
            component: "Button" as const,
            label: `Deploy ${pr.deployRepo}`,
            variant: "secondary",
            action: { name: "pr.deploy", context: { repo: pr.deployRepo } },
          },
        ]
      : []),
  ]

  const dataModel: Record<string, unknown> = {
    pr: {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headSha: pr.headSha,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      ciState: pr.ciState,
      reviewState: pr.reviewState,
      state: pr.state,
      deployRepo: pr.deployRepo,
    },
  }

  const messages: A2UIMessage[] = [
    {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId,
        catalogId: A2UI_BASIC_CATALOG_ID,
        components,
        dataModel,
      },
    },
  ]

  const text = `PR Gate: ${pr.repo}#${pr.number} — ${pr.title} [CI: ${pr.ciState}, Review: ${pr.reviewState}, State: ${pr.state}]\n${pr.url}`
  return { ok: true, surfaceId, text, messages, dataModel }
}

export interface A2UIRouteDeps {
  gh?: GhFn
  prMerge?: typeof mergeAgentPr
  deploy?: ((repo: string) => Promise<DeployResult>) | null
  onUserTurn?: (turn: Turn) => void
  engine?: A2UIEngineDeps
}

/** Execute `POST /hooks/brain/ui` macro expansion (`email`, `pr`, `patch`, `custom`). */
export async function executeA2UIMacro(
  body: Record<string, unknown>,
  deps: A2UIRouteDeps = {},
): Promise<MacroOutcome> {
  const macro = typeof body.macro === "string" ? body.macro.trim() : ""
  if (!macro) return fail(400, "macro_required")

  if (macro === "email") {
    const built = buildEmailConfirmSurface({
      to: typeof body.to === "string" ? body.to : "",
      cc: (body.cc as string | string[] | null | undefined) ?? null,
      subject: typeof body.subject === "string" ? body.subject : "",
      body: typeof body.body === "string" ? body.body : "",
      draftId: typeof body.draftId === "string" ? body.draftId : null,
      gmailThreadId: typeof body.gmailThreadId === "string" ? body.gmailThreadId : null,
      surfaceId: typeof body.surfaceId === "string" ? body.surfaceId : null,
    })
    if (!built.ok) return fail(400, built.error)
    const turn = createSurfaceTurn(
      { surfaceId: built.surfaceId, text: built.text, messages: built.messages },
      deps.engine,
    )
    return {
      status: 200,
      body: { ok: true, macro: "email", turnId: turn.id, surfaceId: built.surfaceId, turn },
    }
  }

  if (macro === "pr") {
    const prNum = typeof body.pr === "number" ? body.pr : typeof body.pr === "string" && /^\d+$/.test(body.pr.trim()) ? Number(body.pr.trim()) : 0
    const hydrated = await hydratePrGateData(
      {
        repo: typeof body.repo === "string" ? body.repo : "",
        pr: prNum,
        deployRepo: typeof body.deployRepo === "string" ? body.deployRepo : null,
        surfaceId: typeof body.surfaceId === "string" ? body.surfaceId : null,
      },
      deps.gh ?? realGh,
    )
    if (!hydrated.ok) return { status: hydrated.status, body: hydrated.body }
    const built = buildPrGateSurface(
      hydrated.pr,
      typeof body.surfaceId === "string" ? body.surfaceId : null,
    )
    if (!built.ok) return fail(400, built.error)
    const turn = createSurfaceTurn(
      { surfaceId: built.surfaceId, text: built.text, messages: built.messages },
      deps.engine,
    )
    return {
      status: 200,
      body: { ok: true, macro: "pr", turnId: turn.id, surfaceId: built.surfaceId, pr: hydrated.pr, turn },
    }
  }

  if (macro === "patch") {
    const surfaceId = typeof body.surfaceId === "string" ? body.surfaceId.trim() : ""
    if (!surfaceId || !SURFACE_ID_RE.test(surfaceId)) return fail(400, "invalid_surface_id")
    const path = typeof body.path === "string" ? body.path : ""
    if (!isValidJsonPointer(path)) return fail(400, "invalid_json_pointer")
    if (!("value" in body)) return fail(400, "value_required")
    const res = updateSurfaceData(surfaceId, path, body.value, deps.engine)
    if (!res.ok) return fail(res.status, res.error)
    return {
      status: 200,
      body: { ok: true, macro: "patch", turnId: res.turn.id, surfaceId, frame: res.frame },
    }
  }

  if (macro === "custom") {
    let rawPayload: unknown = body.json ?? body.messages ?? body.message
    if (typeof rawPayload === "string") {
      try {
        rawPayload = JSON.parse(rawPayload) as unknown
      } catch {
        return fail(400, "bad_custom_json")
      }
    }
    if (
      rawPayload &&
      typeof rawPayload === "object" &&
      !Array.isArray(rawPayload) &&
      Array.isArray((rawPayload as Record<string, unknown>).messages)
    ) {
      rawPayload = (rawPayload as Record<string, unknown>).messages
    }
    const validated = validateA2UIMessages(rawPayload)
    if (!validated.ok) return fail(400, validated.error)
    const { messages, surfaceId } = validated
    const first = messages[0]!
    if ("createSurface" in first) {
      const summary = typeof body.text === "string" && body.text.trim()
        ? body.text.trim()
        : `A2UI surface [${surfaceId}]`
      if (containsHtmlOrScript(summary)) return fail(400, "html_not_allowed")
      const turn = createSurfaceTurn(
        { surfaceId, text: summary, messages: [first] },
        deps.engine,
      )
      for (const msg of messages.slice(1)) {
        if ("updateDataModel" in msg) {
          updateSurfaceData(surfaceId, msg.updateDataModel.path, msg.updateDataModel.value, deps.engine)
        } else if ("updateComponents" in msg) {
          updateSurfaceComponents(surfaceId, msg.updateComponents.components, deps.engine)
        }
      }
      const latest = (deps.engine?.getTurn ?? getTurn)(turn.id) ?? turn
      return {
        status: 200,
        body: { ok: true, macro: "custom", turnId: latest.id, surfaceId, turn: latest },
      }
    }

    let lastTurn: Turn | null = null
    for (const msg of messages) {
      if ("updateDataModel" in msg) {
        const u = updateSurfaceData(surfaceId, msg.updateDataModel.path, msg.updateDataModel.value, deps.engine)
        if (!u.ok) return fail(u.status, u.error)
        lastTurn = u.turn
      } else if ("updateComponents" in msg) {
        const u = updateSurfaceComponents(surfaceId, msg.updateComponents.components, deps.engine)
        if (!u.ok) return fail(u.status, u.error)
        lastTurn = u.turn
      }
    }
    return {
      status: 200,
      body: { ok: true, macro: "custom", turnId: lastTurn?.id ?? null, surfaceId, turn: lastTurn },
    }
  }

  return fail(400, "unknown_macro")
}
