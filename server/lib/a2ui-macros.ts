import { randomUUID } from "node:crypto"
import {
  A2UI_BASIC_CATALOG_ID,
  A2UI_VERSION,
  type A2UIComponent,
  type A2UICreateSurfaceMessage,
  type A2UIEngineDeps,
  type A2UIMessage,
  SURFACE_ID_RE,
  containsHtmlOrScript,
  createSurfaceTurn,
  getSurfaceDataModel,
  isValidJsonPointer,
  setJsonPointer,
  updateSurfaceComponents,
  updateSurfaceData,
  validateA2UIMessages,
} from "./a2ui"
import { type Turn, findA2UITurn } from "./orchestrator-chat"
import {
  type OutboundAccount,
  type OutboundSender,
  type OutboundStore,
  parseProposal,
  policyRefusal,
} from "./outbound"
import {
  type GhCheck,
  type GhComment,
  backsOutbound,
  backsPrGate,
  checkComponentActionsGuard,
  checkDataModelGuard,
  checkSurfaceWriteGuard,
  computeCiState,
  computeReviewState,
  isOutboundSurface,
  isPrGateSurface,
  prSurfaceId,
} from "./a2ui-pr-state"
import { type GhFn, realGh } from "./triage-pr"
import type { DeployResult } from "../wiring/auto-deploy"
import type { mergeAgentPr } from "../wiring/brain-pr-merge"
import { outboundStore } from "../wiring/outbound"

export { handleA2UIAction } from "./a2ui-actions"
export { backsOutbound, backsPrGate, isOutboundSurface, isPrGateSurface, prSurfaceId } from "./a2ui-pr-state"

// Server-side A2UI v1.0 macro expansion (`EmailConfirmCard`, `PrGateCard`, `patch`, `custom`).

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const EMAIL_ADDRESS_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/
const PR_VIEW_FIELDS =
  "state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,url,title,author,labels,statusCheckRollup,comments,files"

export interface EmailMacroInput {
  to: string | string[]
  cc?: string | string[] | null
  subject: string
  body: string
  account?: OutboundAccount | string | null
  inReplyTo?: string | null
  why?: string | null
  dryRun?: boolean
  outboundId?: string | null
  payloadHash?: string | null
  draftId?: string | null
  gmailThreadId?: string | null
  surfaceId?: string | null
}

export interface PrMacroInput {
  repo: string
  pr: number
  deployRepo?: string | null
  reason?: string | null
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
  reason?: string | null
}

export interface MacroOutcome {
  status: number
  body: Record<string, unknown>
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): MacroOutcome => ({
  status,
  body: { ok: false, error, ...extra },
})

export function resolveOutboundStore(
  outbound: OutboundStore | (() => OutboundStore) | null | undefined,
): OutboundStore | null {
  if (outbound === null) return null
  if (typeof outbound === "function") return outbound()
  return outbound ?? outboundStore()
}

export function parseToList(raw: unknown): string[] | null {
  if (typeof raw === "string") {
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean)
    return list.length > 0 && list.every((a) => EMAIL_ADDRESS_RE.test(a)) ? list : null
  }
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
    const list = (raw as string[]).map((s) => s.trim()).filter(Boolean)
    return list.length > 0 && list.every((a) => EMAIL_ADDRESS_RE.test(a)) ? list : null
  }
  return null
}

export function parseCcList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null || raw === "") return []
  if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean)
  if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
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
  const hasTo = typeof input.to === "string"
    ? input.to.trim().length > 0
    : Array.isArray(input.to) && input.to.some((s) => typeof s === "string" && s.trim().length > 0)
  if (!hasTo) return { ok: false, error: "to_required" }
  const toList = parseToList(input.to)
  if (!toList) return { ok: false, error: "to: invalid address" }
  const to = toList.join(", ")
  const subject = typeof input.subject === "string" ? input.subject.trim() : ""
  if (!subject) return { ok: false, error: "subject_required" }
  // Untrimmed: the card body must equal the stored outbound record (parseProposal keeps it as-is).
  const body = typeof input.body === "string" ? input.body : ""
  if (!body.trim()) return { ok: false, error: "body_required" }
  const cc = parseCcList(input.cc)
  if (!cc) return { ok: false, error: "invalid_cc" }
  const rawAccount = input.account === undefined || input.account === null || input.account === "" ? "personal" : input.account
  if (rawAccount !== "personal" && rawAccount !== "hello") {
    return { ok: false, error: 'account must be "personal" or "hello"' }
  }
  const account: OutboundAccount = rawAccount
  const inReplyTo = typeof input.inReplyTo === "string" && input.inReplyTo.trim() ? input.inReplyTo.trim() : null
  if (inReplyTo && (/[\r\n]/.test(inReplyTo) || inReplyTo.length > 1000)) {
    return { ok: false, error: "inReplyTo must be a one-line string" }
  }
  const why = typeof input.why === "string" && input.why.trim() ? input.why.trim() : "Outbound email confirmation"
  const outboundId = typeof input.outboundId === "string" && input.outboundId.trim() ? input.outboundId.trim() : null
  const payloadHash = typeof input.payloadHash === "string" && input.payloadHash.trim() ? input.payloadHash.trim() : null
  const dryRun = input.dryRun === true
  const draftId = typeof input.draftId === "string" && input.draftId.trim() ? input.draftId.trim() : null
  const gmailThreadId = typeof input.gmailThreadId === "string" && input.gmailThreadId.trim() ? input.gmailThreadId.trim() : null
  const defaultSurfaceId = outboundId ? `outbound-${outboundId}` : `email-${randomUUID().slice(0, 8)}`
  const surfaceId = typeof input.surfaceId === "string" && input.surfaceId.trim() ? input.surfaceId.trim() : defaultSurfaceId
  if (!SURFACE_ID_RE.test(surfaceId)) return { ok: false, error: "invalid_surface_id" }
  if (containsHtmlOrScript({ to, toList, cc, subject, body, account, why, draftId, gmailThreadId })) {
    return { ok: false, error: "html_not_allowed" }
  }

  const ccCheckIds = cc.map((_, i) => `cc_check_${i}`)
  const colChildren = ["header_row", "to_text", "cc_picker", ...ccCheckIds, "divider", "body_text", "actions_row"]
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
    ...cc.map((addr, i): A2UIComponent => ({ id: `cc_check_${i}`, component: "CheckBox", label: addr, value: addr, checked: true })),
    { id: "divider", component: "Divider" },
    { id: "body_text", component: "Text", text: { "@path": "/email/body" }, variant: "body" },
    { id: "actions_row", component: "Row", children: ["confirm_btn", "cancel_btn"] },
    {
      id: "confirm_btn",
      component: "Button",
      label: "Send Email",
      variant: "primary",
      action: { name: "email.confirm", context: { enabledCc: { "@path": "/email/enabledCc" } } },
    },
    { id: "cancel_btn", component: "Button", label: "Cancel", variant: "secondary", action: { name: "email.cancel" } },
  ]

  const dataModel: Record<string, unknown> = {
    email: {
      to, toList, cc, enabledCc: [...cc], subject, body, account, inReplyTo, why,
      outboundId, payloadHash, dryRun, draftId, gmailThreadId, state: "pending",
    },
  }
  const messages: A2UIMessage[] = [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG_ID, components, dataModel } },
  ]
  const text = `Email confirm: "${subject}" → ${to}${cc.length ? ` (Cc: ${cc.join(", ")})` : ""}\n${body}`
  return { ok: true, surfaceId, text, messages, dataModel }
}

export function stripAngleTags(s: string): string {
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
  const rawReason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null
  if (rawReason && containsHtmlOrScript(rawReason)) {
    return { ok: false, status: 400, body: { ok: false, error: "html_not_allowed" } }
  }
  const reason = rawReason ? stripAngleTags(rawReason) : null

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
    return { ok: false, status: 404, body: { ok: false, error: "pr_not_found", detail: res.stderr.trim().slice(0, 200) } }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(res.stdout) as Record<string, unknown>
  } catch {
    return { ok: false, status: 502, body: { ok: false, error: "gh_bad_json" } }
  }

  const rawState = String(parsed.state ?? "OPEN").toUpperCase()
  const state: "open" | "merged" | "closed" = rawState === "MERGED" ? "merged" : rawState === "CLOSED" ? "closed" : "open"
  const title = stripAngleTags(String(parsed.title ?? `${repo}#${prNum}`).trim())
  const url = String(parsed.url ?? `https://github.com/${repo}/pull/${prNum}`)
  const headSha = String(parsed.headRefOid ?? "")
  const mergeable = String(parsed.mergeable ?? "UNKNOWN")
  const mergeStateStatus = String(parsed.mergeStateStatus ?? "UNKNOWN")
  const reviewDecision = String(parsed.reviewDecision ?? "")
  const authorObj = parsed.author && typeof parsed.author === "object" ? (parsed.author as { login?: unknown }) : null
  const authorLogin = typeof authorObj?.login === "string" ? authorObj.login : ""
  const checks = Array.isArray(parsed.statusCheckRollup) ? (parsed.statusCheckRollup as GhCheck[]) : []
  const comments = Array.isArray(parsed.comments) ? (parsed.comments as GhComment[]) : []
  const files = Array.isArray(parsed.files) ? (parsed.files as Array<{ path?: string }>) : []

  const ciState = computeCiState(checks, mergeable, mergeStateStatus)
  const reviewState = computeReviewState(comments, headSha, reviewDecision, authorLogin, files)

  return {
    ok: true,
    pr: {
      repo, number: prNum, title, url, headSha, mergeable, mergeStateStatus, ciState, reviewState, state, deployRepo,
      ...(reason ? { reason } : input.reason !== undefined ? { reason: null } : {}),
    },
  }
}

/** Build the canonical A2UI v1.0 PrGateCard surface message from hydrated PR data. */
export function buildPrGateSurface(
  pr: HydratedPrData,
  customSurfaceId?: string | null,
): { ok: true; surfaceId: string; text: string; messages: A2UIMessage[]; dataModel: Record<string, unknown> } | { ok: false; error: string } {
  const expectedId = prSurfaceId(pr.repo, pr.number)
  const surfaceId = typeof customSurfaceId === "string" && customSurfaceId.trim() ? customSurfaceId.trim() : expectedId
  if (!SURFACE_ID_RE.test(surfaceId) || surfaceId !== expectedId) return { ok: false, error: "invalid_surface_id" }

  const rawReason = typeof pr.reason === "string" && pr.reason.trim() ? pr.reason.trim() : null
  if (rawReason && containsHtmlOrScript(rawReason)) return { ok: false, error: "html_not_allowed" }
  const reason = rawReason ? stripAngleTags(rawReason) : null

  const colChildren = ["header_row", "meta_row", "url_text", ...(reason ? ["reason_text"] : []), "divider", "actions_row"]
  const actionIds = ["refresh_btn", "merge_btn", ...(pr.deployRepo ? ["deploy_btn"] : [])]
  const components: A2UIComponent[] = [
    { id: "root", component: "Card", children: ["col"] },
    { id: "col", component: "Column", children: colChildren },
    { id: "header_row", component: "Row", children: ["title_text", "state_badge"] },
    { id: "title_text", component: "Text", text: { "@path": "/pr/title" }, variant: "title" },
    { id: "state_badge", component: "Badge", text: { "@path": "/pr/state" } },
    { id: "meta_row", component: "Row", children: ["ci_badge", "review_badge", "sha_text"] },
    { id: "ci_badge", component: "Badge", text: { "@path": "/pr/ciState" } },
    { id: "review_badge", component: "Badge", text: { "@path": "/pr/reviewState" } },
    { id: "sha_text", component: "Text", text: { "@path": "/pr/headSha" }, variant: "caption" },
    { id: "url_text", component: "Text", text: { "@path": "/pr/url" }, variant: "caption" },
    ...(reason ? [{ id: "reason_text", component: "Text" as const, text: { "@path": "/pr/reason" }, variant: "body" }] : []),
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
      ? [{
          id: "deploy_btn",
          component: "Button" as const,
          label: `Deploy ${pr.deployRepo}`,
          variant: "secondary",
          action: { name: "pr.deploy", context: { repo: pr.deployRepo } },
        }]
      : []),
  ]

  const dataModel: Record<string, unknown> = {
    pr: {
      repo: pr.repo, number: pr.number, title: pr.title, url: pr.url, headSha: pr.headSha,
      mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus, ciState: pr.ciState,
      reviewState: pr.reviewState, state: pr.state, deployRepo: pr.deployRepo, reason,
    },
  }
  const messages: A2UIMessage[] = [
    { version: A2UI_VERSION, createSurface: { surfaceId, catalogId: A2UI_BASIC_CATALOG_ID, components, dataModel } },
  ]
  const text = `PR Gate: ${pr.repo}#${pr.number} — ${pr.title} [CI: ${pr.ciState}, Review: ${pr.reviewState}, State: ${pr.state}]${reason ? ` — ${reason}` : ""}\n${pr.url}`
  return { ok: true, surfaceId, text, messages, dataModel }
}

export interface A2UIRouteDeps {
  gh?: GhFn
  prMerge?: typeof mergeAgentPr
  deploy?: ((repo: string) => Promise<DeployResult>) | null
  outbound?: OutboundStore | (() => OutboundStore) | null
  emailSender?: OutboundSender
  onUserTurn?: (turn: Turn) => void
  engine?: A2UIEngineDeps
  signal?: AbortSignal
}

/** Execute `POST /hooks/brain/ui` macro expansion (`email`, `pr`, `patch`, `custom`). */
export async function executeA2UIMacro(
  body: Record<string, unknown>,
  deps: A2UIRouteDeps = {},
): Promise<MacroOutcome> {
  const macro = typeof body.macro === "string" ? body.macro.trim() : ""
  if (!macro) return fail(400, "macro_required")

  if (macro === "email") {
    const rawTo = body.to
    const hasTo = typeof rawTo === "string"
      ? rawTo.trim().length > 0
      : Array.isArray(rawTo) && rawTo.some((s) => typeof s === "string" && s.trim().length > 0)
    if (!hasTo) return fail(400, "to_required")
    const toList = parseToList(rawTo)
    if (!toList) return fail(400, "to: invalid address")
    const cc = parseCcList(body.cc)
    if (!cc) return fail(400, "invalid_cc")
    const subject = typeof body.subject === "string" ? body.subject.trim() : ""
    if (!subject) return fail(400, "subject_required")
    const emailBody = typeof body.body === "string" ? body.body.trim() : ""
    if (!emailBody) return fail(400, "body_required")
    const account = body.account === undefined || body.account === null || body.account === "" ? "personal" : body.account
    if (account !== "personal" && account !== "hello") return fail(400, 'account must be "personal" or "hello"')
    const inReplyTo = typeof body.inReplyTo === "string" && body.inReplyTo.trim() ? body.inReplyTo.trim() : null
    if (inReplyTo && (/[\r\n]/.test(inReplyTo) || inReplyTo.length > 1000)) {
      return fail(400, "inReplyTo must be a one-line string")
    }
    const why = typeof body.why === "string" && body.why.trim() ? body.why.trim() : "Outbound email confirmation"
    const draftId = typeof body.draftId === "string" && body.draftId.trim() ? body.draftId.trim() : null
    const gmailThreadId = typeof body.gmailThreadId === "string" && body.gmailThreadId.trim() ? body.gmailThreadId.trim() : null
    const customSurfaceId = typeof body.surfaceId === "string" && body.surfaceId.trim() ? body.surfaceId.trim() : null
    if (customSurfaceId && !SURFACE_ID_RE.test(customSurfaceId)) return fail(400, "invalid_surface_id")
    if (containsHtmlOrScript({ toList, cc, subject, emailBody, account, why, draftId, gmailThreadId })) {
      return fail(400, "html_not_allowed")
    }

    const store = body.dryRun === true ? null : resolveOutboundStore(deps.outbound)
    const isDryRun = store === null
    let outboundId: string | null = null
    let recHash: string | null = null

    if (!isDryRun && store) {
      if (customSurfaceId) return fail(403, "outbound_surface_readonly")
      const parsed = parseProposal({
        kind: "email", account, to: toList, cc, subject, body: emailBody,
        inReplyTo, threadId: gmailThreadId, why, requestedBy: "brain",
      })
      if (!parsed.ok) return fail(400, parsed.error)
      const refusal = policyRefusal(parsed.proposal)
      if (refusal) return fail(422, "refused", { reason: refusal })
      const rec = store.propose(parsed.proposal, Date.now())
      outboundId = rec.id
      recHash = rec.payloadHash
    } else if (customSurfaceId) {
      const guardErr = checkSurfaceWriteGuard(customSurfaceId, deps.engine)
      if (guardErr) return fail(403, guardErr)
    }

    const built = buildEmailConfirmSurface({
      to: toList, cc, subject, body: emailBody, account, inReplyTo, why, dryRun: isDryRun,
      outboundId, payloadHash: recHash, draftId, gmailThreadId,
      surfaceId: outboundId ? `outbound-${outboundId}` : customSurfaceId,
    })
    if (!built.ok) return fail(400, built.error)
    const turn = createSurfaceTurn({ surfaceId: built.surfaceId, text: built.text, messages: built.messages }, deps.engine)
    return {
      status: 200,
      body: {
        ok: true, macro: "email", turnId: turn.id, surfaceId: built.surfaceId,
        ...(outboundId ? { outboundId, payloadHash: recHash } : {}), turn,
      },
    }
  }

  if (macro === "pr") {
    const customSurfaceId = typeof body.surfaceId === "string" && body.surfaceId.trim() ? body.surfaceId.trim() : null
    if (customSurfaceId) {
      if (isOutboundSurface(customSurfaceId, deps.engine)) return fail(403, "outbound_surface_readonly")
      if (!SURFACE_ID_RE.test(customSurfaceId)) return fail(400, "invalid_surface_id")
    }
    const prNum = typeof body.pr === "number" ? body.pr : typeof body.pr === "string" && /^\d+$/.test(body.pr.trim()) ? Number(body.pr.trim()) : 0
    const hydrated = await hydratePrGateData(
      {
        repo: typeof body.repo === "string" ? body.repo : "",
        pr: prNum,
        deployRepo: typeof body.deployRepo === "string" ? body.deployRepo : null,
        ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
        surfaceId: customSurfaceId,
      },
      deps.gh ?? realGh,
    )
    if (!hydrated.ok) return { status: hydrated.status, body: hydrated.body }
    const expectedId = prSurfaceId(hydrated.pr.repo, hydrated.pr.number)
    if (customSurfaceId && customSurfaceId !== expectedId) {
      if (/^pr-/.test(customSurfaceId) || isPrGateSurface(customSurfaceId, deps.engine)) {
        return fail(403, "pr_surface_readonly")
      }
      return fail(400, "invalid_surface_id")
    }
    const existingPrTurn = (deps.engine?.findTurn ?? findA2UITurn)(expectedId)
    if (existingPrTurn?.card?.kind === "a2ui") {
      const existingPr = getSurfaceDataModel(existingPrTurn.card).pr as Record<string, unknown> | undefined
      if (existingPr && (existingPr.repo !== hydrated.pr.repo || existingPr.number !== hydrated.pr.number)) {
        return fail(403, "pr_surface_readonly")
      }
    }
    const built = buildPrGateSurface(hydrated.pr, expectedId)
    if (!built.ok) return fail(400, built.error)
    const turn = createSurfaceTurn({ surfaceId: built.surfaceId, text: built.text, messages: built.messages }, deps.engine)
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
    const preGuard = checkSurfaceWriteGuard(surfaceId, deps.engine)
    if (preGuard) return fail(403, preGuard)
    const existing = (deps.engine?.findTurn ?? findA2UITurn)(surfaceId)
    const baseModel = existing?.card?.kind === "a2ui" ? getSurfaceDataModel(existing.card) : {}
    try {
      const postGuard = checkDataModelGuard(setJsonPointer(baseModel, path, body.value))
      if (postGuard) return fail(403, postGuard)
    } catch { /* invalid pointer target handled by updateSurfaceData */ }
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
    if (rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) && Array.isArray((rawPayload as Record<string, unknown>).messages)) {
      rawPayload = (rawPayload as Record<string, unknown>).messages
    }
    const validated = validateA2UIMessages(rawPayload)
    if (!validated.ok) return fail(400, validated.error)
    const { messages, surfaceId } = validated
    const preGuard = checkSurfaceWriteGuard(surfaceId, deps.engine)
    if (preGuard) return fail(403, preGuard)
    for (const msg of messages) {
      const comps = "createSurface" in msg ? msg.createSurface.components : "updateComponents" in msg ? msg.updateComponents.components : null
      if (comps) {
        const actGuard = checkComponentActionsGuard(comps)
        if (actGuard) return fail(403, actGuard)
      }
    }
    const first = messages[0]!
    if ("createSurface" in first) {
      const summary = typeof body.text === "string" && body.text.trim() ? body.text.trim() : `A2UI surface [${surfaceId}]`
      if (containsHtmlOrScript(summary)) return fail(400, "html_not_allowed")
      const foldedCreate: A2UICreateSurfaceMessage = structuredClone(first)
      for (const msg of messages.slice(1)) {
        if ("createSurface" in msg) return fail(400, "duplicate_create_surface")
        if ("updateDataModel" in msg) {
          try {
            foldedCreate.createSurface.dataModel = setJsonPointer(
              foldedCreate.createSurface.dataModel,
              msg.updateDataModel.path,
              msg.updateDataModel.value,
            )
          } catch {
            return fail(400, "invalid_json_pointer_target")
          }
        } else if ("updateComponents" in msg) {
          for (const comp of msg.updateComponents.components) {
            const idx = foldedCreate.createSurface.components.findIndex((c) => c.id === comp.id)
            if (idx >= 0) foldedCreate.createSurface.components[idx] = comp
            else foldedCreate.createSurface.components.push(comp)
          }
        }
      }
      const modelGuard = checkDataModelGuard(foldedCreate.createSurface.dataModel)
      if (modelGuard) return fail(403, modelGuard)
      const turn = createSurfaceTurn({ surfaceId, text: summary, messages: [foldedCreate] }, deps.engine)
      return { status: 200, body: { ok: true, macro: "custom", turnId: turn.id, surfaceId, turn } }
    }

    const existing = (deps.engine?.findTurn ?? findA2UITurn)(surfaceId)
    let simModel = existing?.card?.kind === "a2ui" ? getSurfaceDataModel(existing.card) : {}
    for (const msg of messages) {
      if ("updateDataModel" in msg) {
        try {
          simModel = setJsonPointer(simModel, msg.updateDataModel.path, msg.updateDataModel.value)
        } catch {
          return fail(400, "invalid_json_pointer_target")
        }
        const postGuard = checkDataModelGuard(simModel)
        if (postGuard) return fail(403, postGuard)
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
