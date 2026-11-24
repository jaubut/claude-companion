import {
  type A2UIEngineDeps,
  getSurfaceDataModel,
  resolveA2UIContext,
  updateSurfaceData,
  validateA2UIActionRequest,
} from "./a2ui"
import {
  type A2UIRouteDeps,
  type MacroOutcome,
  hydratePrGateData,
  parseCcList,
} from "./a2ui-macros"
import { BRAIN_THREAD } from "./brain"
import { appendTurn, findA2UITurn, getTurn, setTurnCard } from "./orchestrator-chat"
import { realGh } from "./triage-pr"
import { autoDeploy, isDeployRepo } from "../wiring/auto-deploy"
import { mergeAgentPr } from "../wiring/brain-pr-merge"
import { orchEmit } from "../wiring/orchestrator"

// Deterministic bidirectional A2UI v1.0 action router (`POST /api/brain/a2ui/action`).
// Enforces surface-persisted `actionKey` idempotency and executes `pr.refresh`, `pr.merge`,
// `pr.deploy`, `email.cancel`, and `email.confirm`.

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): MacroOutcome => ({
  status,
  body: { ok: false, error, ...extra },
})

/** Record an idempotent action result on the surface's TurnCard in SQLite. */
function rememberActionKey(
  turnId: string,
  actionKey: string,
  resultBody: Record<string, unknown>,
  deps: A2UIEngineDeps = {},
): void {
  const get = deps.getTurn ?? getTurn
  const set = deps.setCard ?? setTurnCard
  const latest = get(turnId)
  if (!latest?.card) return
  const actionKeys: Record<string, Record<string, unknown>> = {
    ...(latest.card.actionKeys ?? {}),
    [actionKey]: resultBody,
  }
  set(turnId, { actionKeys })
}

/** Execute `POST /api/brain/a2ui/action` with `actionKey` idempotency and deterministic actions. */
export async function handleA2UIAction(
  rawBody: unknown,
  deps: A2UIRouteDeps = {},
): Promise<MacroOutcome> {
  const parsed = validateA2UIActionRequest(rawBody)
  if (!parsed.ok) return fail(400, parsed.error)
  const req = parsed.request

  const get = deps.engine?.getTurn ?? getTurn
  const find = deps.engine?.findTurn ?? findA2UITurn
  const byId = get(req.turnId)
  const turn = byId && byId.card?.kind === "a2ui" && byId.card.surfaceId === req.surfaceId
    ? byId
    : find(req.surfaceId)

  if (!turn || turn.card?.kind !== "a2ui" || turn.card.surfaceId !== req.surfaceId) {
    return fail(404, "surface_not_found")
  }

  const cached = turn.card.actionKeys?.[req.actionKey]
  if (cached) {
    return {
      status: 200,
      body: { ...cached, replay: true },
    }
  }

  const dataModel = getSurfaceDataModel(turn.card)
  const context = resolveA2UIContext(req.action.context, dataModel)
  const name = req.action.name

  if (name === "pr.refresh") {
    const prModel = (dataModel.pr && typeof dataModel.pr === "object" ? dataModel.pr : {}) as Record<string, unknown>
    const repo = typeof context.repo === "string" ? context.repo : typeof prModel.repo === "string" ? prModel.repo : ""
    const prNum = typeof context.pr === "number" ? context.pr : typeof prModel.number === "number" ? prModel.number : 0
    const deployRepo = typeof prModel.deployRepo === "string" ? prModel.deployRepo : null
    const hydrated = await hydratePrGateData({ repo, pr: prNum, deployRepo }, deps.gh ?? realGh)
    if (!hydrated.ok) return { status: hydrated.status, body: hydrated.body }
    const patched = updateSurfaceData(req.surfaceId, "/pr", hydrated.pr, deps.engine)
    if (!patched.ok) return fail(patched.status, patched.error)
    const outBody: Record<string, unknown> = {
      ok: true,
      surfaceId: req.surfaceId,
      turnId: turn.id,
      action: "pr.refresh",
      pr: hydrated.pr,
      replay: false,
    }
    rememberActionKey(turn.id, req.actionKey, outBody, deps.engine)
    return { status: 200, body: outBody }
  }

  if (name === "pr.merge") {
    const prModel = (dataModel.pr && typeof dataModel.pr === "object" ? dataModel.pr : {}) as Record<string, unknown>
    const repo = typeof context.repo === "string" ? context.repo : typeof prModel.repo === "string" ? prModel.repo : ""
    const prNum = typeof context.pr === "number" ? context.pr : typeof prModel.number === "number" ? prModel.number : 0
    if (!repo || !prNum) return fail(400, "pr_target_missing")
    const mergeFn = deps.prMerge ?? mergeAgentPr
    const mergeOut = await mergeFn({
      repo,
      pr: prNum,
      reason: "Approved via A2UI PR Gate card",
      humanApproved: true,
    })
    if (mergeOut.status !== 200 || mergeOut.body.ok !== true) {
      return { status: mergeOut.status, body: mergeOut.body }
    }
    const patched = updateSurfaceData(req.surfaceId, "/pr/state", "merged", deps.engine)
    if (!patched.ok) return fail(patched.status, patched.error)
    const outBody: Record<string, unknown> = {
      ok: true,
      surfaceId: req.surfaceId,
      turnId: turn.id,
      action: "pr.merge",
      state: "merged",
      merged: true,
      url: mergeOut.body.url,
      head: mergeOut.body.head,
      replay: false,
    }
    rememberActionKey(turn.id, req.actionKey, outBody, deps.engine)
    return { status: 200, body: outBody }
  }

  if (name === "pr.deploy") {
    const prModel = (dataModel.pr && typeof dataModel.pr === "object" ? dataModel.pr : {}) as Record<string, unknown>
    const deployRepo = typeof context.repo === "string"
      ? context.repo
      : typeof prModel.deployRepo === "string"
        ? prModel.deployRepo
        : ""
    if (!deployRepo) return fail(400, "deploy_repo_missing")
    const run = deps.deploy !== undefined ? deps.deploy : autoDeploy()?.deployNow ?? null
    if (isDeployRepo(deployRepo) && run) {
      const deployOut = await run(deployRepo)
      if (!deployOut.ok) {
        return { status: 409, body: { ...deployOut } }
      }
      updateSurfaceData(req.surfaceId, "/pr/state", "deployed", deps.engine)
      const outBody: Record<string, unknown> = {
        ok: true,
        surfaceId: req.surfaceId,
        turnId: turn.id,
        action: "pr.deploy",
        deploy: deployOut,
        replay: false,
      }
      rememberActionKey(turn.id, req.actionKey, outBody, deps.engine)
      return { status: 200, body: outBody }
    }
    const append = deps.engine?.appendTurn ?? appendTurn
    const emit = deps.engine?.emitTurn ?? orchEmit
    const deployTurn = append("user", `Confirmed deploy [${req.surfaceId}]: deploy ${deployRepo} now.`, null, BRAIN_THREAD)
    emit(deployTurn)
    deps.onUserTurn?.(deployTurn)
    updateSurfaceData(req.surfaceId, "/pr/state", "deploy_requested", deps.engine)
    const outBody: Record<string, unknown> = {
      ok: true,
      surfaceId: req.surfaceId,
      turnId: turn.id,
      action: "pr.deploy",
      deployTurnId: deployTurn.id,
      replay: false,
    }
    rememberActionKey(turn.id, req.actionKey, outBody, deps.engine)
    return { status: 200, body: outBody }
  }

  if (name === "email.cancel") {
    const patched = updateSurfaceData(req.surfaceId, "/email/state", "cancelled", deps.engine)
    if (!patched.ok) return fail(patched.status, patched.error)
    const outBody: Record<string, unknown> = {
      ok: true,
      surfaceId: req.surfaceId,
      turnId: turn.id,
      action: "email.cancel",
      state: "cancelled",
      replay: false,
    }
    rememberActionKey(turn.id, req.actionKey, outBody, deps.engine)
    return { status: 200, body: outBody }
  }

  if (name === "email.confirm") {
    const emailModel = (dataModel.email && typeof dataModel.email === "object" ? dataModel.email : {}) as Record<string, unknown>
    const rawCc = context.enabledCc !== undefined ? context.enabledCc : emailModel.enabledCc ?? emailModel.cc ?? []
    const parsedCc = parseCcList(rawCc)
    if (!parsedCc) return fail(400, "invalid_enabled_cc")
    const allowedCc = Array.isArray(emailModel.cc)
      ? new Set((emailModel.cc as unknown[]).filter((x): x is string => typeof x === "string"))
      : null
    const enabledCc = allowedCc && allowedCc.size > 0
      ? parsedCc.filter((addr) => allowedCc.has(addr))
      : parsedCc

    updateSurfaceData(req.surfaceId, "/email/enabledCc", enabledCc, deps.engine)
    const patched = updateSurfaceData(req.surfaceId, "/email/state", "confirmed", deps.engine)
    if (!patched.ok) return fail(patched.status, patched.error)

    const to = typeof emailModel.to === "string" ? emailModel.to : ""
    const subject = typeof emailModel.subject === "string" ? emailModel.subject : ""
    const draftId = typeof emailModel.draftId === "string" && emailModel.draftId ? emailModel.draftId : null
    const gmailThreadId = typeof emailModel.gmailThreadId === "string" && emailModel.gmailThreadId ? emailModel.gmailThreadId : null
    const ccSummary = enabledCc.length > 0 ? enabledCc.join(", ") : "none"
    const confirmText =
      `Email confirmed [${req.surfaceId}] — To: ${to} | Cc: ${ccSummary} | Subject: "${subject}"` +
      (draftId ? ` | draftId: ${draftId}` : "") +
      (gmailThreadId ? ` | gmailThreadId: ${gmailThreadId}` : "")

    const append = deps.engine?.appendTurn ?? appendTurn
    const emit = deps.engine?.emitTurn ?? orchEmit
    const confirmTurn = append("user", confirmText, null, BRAIN_THREAD)
    emit(confirmTurn)
    deps.onUserTurn?.(confirmTurn)

    const outBody: Record<string, unknown> = {
      ok: true,
      surfaceId: req.surfaceId,
      turnId: turn.id,
      action: "email.confirm",
      state: "confirmed",
      to,
      enabledCc,
      subject,
      draftId,
      gmailThreadId,
      confirmTurnId: confirmTurn.id,
      replay: false,
    }
    rememberActionKey(turn.id, req.actionKey, outBody, deps.engine)
    return { status: 200, body: outBody }
  }

  return fail(400, "unknown_action")
}
