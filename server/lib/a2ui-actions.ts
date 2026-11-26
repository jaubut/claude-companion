import {
  type A2UIActionRequest,
  type A2UIEngineDeps,
  getSurfaceDataModel,
  resolveA2UIContext,
  updateSurfaceData,
  validateA2UIActionRequest,
} from "./a2ui"
import {
  type A2UIRouteDeps,
  type MacroOutcome,
  REPO_RE,
  hydratePrGateData,
  parseCcList,
  prSurfaceId,
  resolveOutboundStore,
  stripAngleTags,
  syncPrGateButtons,
} from "./a2ui-macros"
import { isReservedAction } from "./a2ui-pr-state"
import { BRAIN_THREAD } from "./brain"
import { type Turn, appendTurn, findA2UITurn, getTurn, setTurnCard } from "./orchestrator-chat"
import { type OutboundPayload, type OutboundRecord, payloadHash, policyRefusal, sendable } from "./outbound"
import { realGh } from "./triage-pr"
import { autoDeploy, isDeployRepo } from "../wiring/auto-deploy"
import { closeDeadPr } from "../wiring/brain-pr-close"
import { mergeAgentPr } from "../wiring/brain-pr-merge"
import { orchEmit } from "../wiring/orchestrator"
import { gmailSender } from "../wiring/outbound"

// Deterministic bidirectional A2UI v1.0 action router (`POST /api/brain/a2ui/action`).
// Enforces surface-persisted `actionKey` idempotency, in-flight request coalescing,
// terminal state guards, and head-SHA pinning on `pr.merge`.

const fail = (status: number, error: string, extra: Record<string, unknown> = {}): MacroOutcome => ({
  status,
  body: { ok: false, error, ...extra },
})

const inFlightActions = new Map<string, Promise<MacroOutcome>>()

/**
 * What the card displays (with the record's current Cc, a subset of the card's Cc options) hashes to
 * the stored record: the hash is recomputed, never read from card data, so what Jeremie saw is what sends.
 */
function cardShowsRecord(email: Record<string, unknown>, rec: OutboundRecord): boolean {
  const shown = {
    account: email.account,
    to: Array.isArray(email.toList) ? email.toList : [],
    cc: rec.cc,
    subject: email.subject,
    body: email.body,
    inReplyTo: email.inReplyTo ?? null,
  } as OutboundPayload
  return payloadHash(shown) === rec.payloadHash
}

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

async function runActionForTurn(
  req: A2UIActionRequest,
  turn: Turn,
  deps: A2UIRouteDeps,
): Promise<MacroOutcome> {
  const scopedEngine: A2UIEngineDeps = { ...(deps.engine ?? {}), turnId: turn.id }
  const dataModel = getSurfaceDataModel(turn.card!)
  const context = resolveA2UIContext(req.action.context, dataModel)
  const name = req.action.name

  if (name === "pr.refresh") {
    if (!/^pr-/.test(req.surfaceId)) return fail(403, "pr_surface_mismatch")
    const prModel = (dataModel.pr && typeof dataModel.pr === "object" ? dataModel.pr : {}) as Record<string, unknown>
    const repo = typeof prModel.repo === "string" && REPO_RE.test(prModel.repo.trim()) ? prModel.repo.trim() : ""
    const prNum = typeof prModel.number === "number" && Number.isInteger(prModel.number) && prModel.number > 0 ? prModel.number : 0
    if (!repo || !prNum || req.surfaceId !== prSurfaceId(repo, prNum)) return fail(403, "pr_surface_mismatch")
    const deployRepo = typeof prModel.deployRepo === "string" ? prModel.deployRepo : null
    const existingReason = typeof prModel.reason === "string" && prModel.reason.trim() ? prModel.reason.trim() : null
    const hydrated = await hydratePrGateData(
      { repo, pr: prNum, deployRepo, ...(existingReason ? { reason: existingReason } : {}) },
      deps.gh ?? realGh,
    )
    if (!hydrated.ok) return { status: hydrated.status, body: hydrated.body }
    const nextPr = {
      ...hydrated.pr,
      ...(existingReason ? { reason: existingReason } : prModel.reason !== undefined ? { reason: null } : {}),
    }
    const patched = updateSurfaceData(req.surfaceId, "/pr", nextPr, scopedEngine)
    if (!patched.ok) return fail(patched.status, patched.error)
    syncPrGateButtons(req.surfaceId, nextPr.state, deployRepo, scopedEngine)
    const outBody: Record<string, unknown> = {
      ok: true,
      surfaceId: req.surfaceId,
      turnId: turn.id,
      action: "pr.refresh",
      pr: nextPr,
      replay: false,
    }
    rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
    return { status: 200, body: outBody }
  }

  if (name === "pr.merge") {
    if (!/^pr-/.test(req.surfaceId)) return fail(403, "pr_surface_mismatch")
    const prModel = (dataModel.pr && typeof dataModel.pr === "object" ? dataModel.pr : {}) as Record<string, unknown>
    // Pin repo and prNum strictly to the surface's hydrated prModel so context cannot redirect a merge.
    const repo = typeof prModel.repo === "string" && REPO_RE.test(prModel.repo.trim()) ? prModel.repo.trim() : ""
    const prNum = typeof prModel.number === "number" && Number.isInteger(prModel.number) && prModel.number > 0 ? prModel.number : 0
    const expectedSha = typeof prModel.headSha === "string" ? prModel.headSha.trim() : ""
    if (!repo || !prNum || !expectedSha) return fail(400, "pr_target_missing")
    if (req.surfaceId !== prSurfaceId(repo, prNum)) return fail(403, "pr_surface_mismatch")
    const deployRepo = typeof prModel.deployRepo === "string" ? prModel.deployRepo : null
    if (prModel.state === "merged") {
      syncPrGateButtons(req.surfaceId, "merged", deployRepo, scopedEngine)
      const outBody: Record<string, unknown> = {
        ok: true,
        surfaceId: req.surfaceId,
        turnId: turn.id,
        action: "pr.merge",
        state: "merged",
        merged: true,
        url: prModel.url ?? null,
        head: prModel.headSha ?? null,
        replay: true,
      }
      rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
      return { status: 200, body: outBody }
    }

    const expectedTitle = typeof prModel.title === "string" ? prModel.title : null
    const expectedUrl = typeof prModel.url === "string" ? prModel.url : null
    const mergeFn = deps.prMerge ?? mergeAgentPr
    const mergeOut = await mergeFn(
      {
        repo,
        pr: prNum,
        reason: "Approved via A2UI PR Gate card",
        humanApproved: true,
        expectedHeadSha: expectedSha,
        expectedTitle,
        expectedUrl,
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
      deps.gh ? { gh: deps.gh } : undefined,
    )
    if (mergeOut.status !== 200 || mergeOut.body.ok !== true) {
      if (mergeOut.body.error === "not_open") {
        const liveState = String(mergeOut.body.state ?? "").toUpperCase()
        if (liveState === "MERGED") {
          updateSurfaceData(req.surfaceId, "/pr/state", "merged", scopedEngine)
          syncPrGateButtons(req.surfaceId, "merged", deployRepo, scopedEngine)
          const outBody: Record<string, unknown> = {
            ok: true,
            surfaceId: req.surfaceId,
            turnId: turn.id,
            action: "pr.merge",
            state: "merged",
            merged: true,
            url: prModel.url ?? null,
            head: prModel.headSha ?? null,
            replay: true,
          }
          rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
          return { status: 200, body: outBody }
        }
        if (liveState === "CLOSED") {
          updateSurfaceData(req.surfaceId, "/pr/state", "closed", scopedEngine)
          syncPrGateButtons(req.surfaceId, "closed", deployRepo, scopedEngine)
        }
      }
      return { status: mergeOut.status, body: mergeOut.body }
    }
    const patched = updateSurfaceData(req.surfaceId, "/pr/state", "merged", scopedEngine)
    if (!patched.ok) return fail(patched.status, patched.error)
    syncPrGateButtons(req.surfaceId, "merged", deployRepo, scopedEngine)
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
    rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
    return { status: 200, body: outBody }
  }

  if (name === "pr.close") {
    if (!/^pr-/.test(req.surfaceId)) return fail(403, "pr_surface_mismatch")
    const prModel = (dataModel.pr && typeof dataModel.pr === "object" ? dataModel.pr : {}) as Record<string, unknown>
    // Pin repo and prNum strictly to the surface's hydrated prModel so context cannot redirect a close.
    const repo = typeof prModel.repo === "string" && REPO_RE.test(prModel.repo.trim()) ? prModel.repo.trim() : ""
    const prNum = typeof prModel.number === "number" && Number.isInteger(prModel.number) && prModel.number > 0 ? prModel.number : 0
    if (!repo || !prNum || req.surfaceId !== prSurfaceId(repo, prNum)) return fail(403, "pr_surface_mismatch")
    const deployRepo = typeof prModel.deployRepo === "string" ? prModel.deployRepo : null
    if (prModel.state === "closed") {
      syncPrGateButtons(req.surfaceId, "closed", deployRepo, scopedEngine)
      const outBody: Record<string, unknown> = {
        ok: true,
        surfaceId: req.surfaceId,
        turnId: turn.id,
        action: "pr.close",
        state: "closed",
        closed: true,
        url: prModel.url ?? null,
        replay: true,
      }
      rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
      return { status: 200, body: outBody }
    }
    if (prModel.state === "merged") {
      syncPrGateButtons(req.surfaceId, "merged", deployRepo, scopedEngine)
      return fail(409, "not_open", { state: prModel.state })
    }

    const expectedTitle = typeof prModel.title === "string" ? prModel.title : null
    const expectedUrl = typeof prModel.url === "string" ? prModel.url : null
    const closeFn = deps.prClose ?? closeDeadPr
    const closeOut = await closeFn(
      {
        repo,
        pr: prNum,
        reason: "Closed via A2UI PR Gate card",
        humanApproved: true,
        expectedTitle,
        expectedUrl,
      },
      deps.gh ? { gh: deps.gh } : undefined,
    )
    if (closeOut.status !== 200 || closeOut.body.ok !== true) {
      if (closeOut.body.error === "not_open") {
        const liveState = String(closeOut.body.state ?? "").toUpperCase()
        if (liveState === "CLOSED") {
          updateSurfaceData(req.surfaceId, "/pr/state", "closed", scopedEngine)
          syncPrGateButtons(req.surfaceId, "closed", deployRepo, scopedEngine)
          const outBody: Record<string, unknown> = {
            ok: true,
            surfaceId: req.surfaceId,
            turnId: turn.id,
            action: "pr.close",
            state: "closed",
            closed: true,
            url: prModel.url ?? null,
            replay: true,
          }
          rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
          return { status: 200, body: outBody }
        }
        if (liveState === "MERGED") {
          updateSurfaceData(req.surfaceId, "/pr/state", "merged", scopedEngine)
          syncPrGateButtons(req.surfaceId, "merged", deployRepo, scopedEngine)
          return { status: 409, body: { ok: false, error: "already_merged", state: "merged" } }
        }
      }
      return { status: closeOut.status, body: closeOut.body }
    }
    const patched = updateSurfaceData(req.surfaceId, "/pr/state", "closed", scopedEngine)
    if (!patched.ok) return fail(patched.status, patched.error)
    syncPrGateButtons(req.surfaceId, "closed", deployRepo, scopedEngine)
    const outBody: Record<string, unknown> = {
      ok: true,
      surfaceId: req.surfaceId,
      turnId: turn.id,
      action: "pr.close",
      state: "closed",
      closed: true,
      url: closeOut.body.url,
      replay: false,
    }
    rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
    return { status: 200, body: outBody }
  }

  if (name === "pr.deploy") {
    if (!/^pr-/.test(req.surfaceId)) return fail(403, "pr_surface_mismatch")
    const prModel = (dataModel.pr && typeof dataModel.pr === "object" ? dataModel.pr : {}) as Record<string, unknown>
    const repo = typeof prModel.repo === "string" && REPO_RE.test(prModel.repo.trim()) ? prModel.repo.trim() : ""
    const prNum = typeof prModel.number === "number" && Number.isInteger(prModel.number) && prModel.number > 0 ? prModel.number : 0
    if (!repo || !prNum || req.surfaceId !== prSurfaceId(repo, prNum)) return fail(403, "pr_surface_mismatch")
    if (prModel.state !== "merged") {
      return fail(409, "not_merged", { state: prModel.state ?? null })
    }
    const deployRepo = typeof prModel.deployRepo === "string" && prModel.deployRepo.trim() ? prModel.deployRepo.trim() : ""
    if (!deployRepo) return fail(400, "deploy_repo_missing")
    const run = deps.deploy !== undefined ? deps.deploy : autoDeploy()?.deployNow ?? null
    if (isDeployRepo(deployRepo) && run) {
      const deployOut = await run(deployRepo)
      if (!deployOut.ok) {
        return { status: 409, body: { ...deployOut } }
      }
      updateSurfaceData(req.surfaceId, "/pr/state", "deployed", scopedEngine)
      syncPrGateButtons(req.surfaceId, "deployed", deployRepo, scopedEngine)
      const outBody: Record<string, unknown> = {
        ok: true,
        surfaceId: req.surfaceId,
        turnId: turn.id,
        action: "pr.deploy",
        deploy: deployOut,
        replay: false,
      }
      rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
      return { status: 200, body: outBody }
    }
    const append = scopedEngine.appendTurn ?? appendTurn
    const emit = scopedEngine.emitTurn ?? orchEmit
    const deployTurn = append("user", `Confirmed deploy [${req.surfaceId}]: deploy ${deployRepo} now.`, null, BRAIN_THREAD)
    emit(deployTurn)
    deps.onUserTurn?.(deployTurn)
    updateSurfaceData(req.surfaceId, "/pr/state", "deploy_requested", scopedEngine)
    const outBody: Record<string, unknown> = {
      ok: true,
      surfaceId: req.surfaceId,
      turnId: turn.id,
      action: "pr.deploy",
      deployTurnId: deployTurn.id,
      replay: false,
    }
    rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
    return { status: 200, body: outBody }
  }

  if (name === "email.cancel") {
    const emailModel = (dataModel.email && typeof dataModel.email === "object" ? dataModel.email : {}) as Record<string, unknown>
    const to = typeof emailModel.to === "string" ? emailModel.to.trim() : ""
    if (!to) return fail(400, "to_required")
    if (emailModel.state !== "pending") {
      return fail(409, "already_decided", { state: emailModel.state ?? null })
    }
    const outboundId = typeof emailModel.outboundId === "string" && emailModel.outboundId.trim() ? emailModel.outboundId.trim() : null
    if (outboundId && emailModel.dryRun !== true) {
      if (req.surfaceId !== `outbound-${outboundId}`) return fail(403, "outbound_surface_mismatch")
      const store = resolveOutboundStore(deps.outbound)
      if (store) {
        const rec = store.get(outboundId)
        if (rec && rec.status === "sent") {
          updateSurfaceData(req.surfaceId, "/email/state", "sent", scopedEngine)
          return fail(409, "already_decided", { state: "sent" })
        }
        if (rec && rec.status === "proposed") {
          if (!cardShowsRecord(emailModel, rec) || !store.reject(rec.id, rec.payloadHash, Date.now())) {
            return fail(409, "stale_version")
          }
        }
      }
    }
    const patched = updateSurfaceData(req.surfaceId, "/email/state", "cancelled", scopedEngine)
    if (!patched.ok) return fail(patched.status, patched.error)
    const outBody: Record<string, unknown> = {
      ok: true,
      surfaceId: req.surfaceId,
      turnId: turn.id,
      action: "email.cancel",
      state: "cancelled",
      ...(outboundId && emailModel.dryRun !== true ? { outboundId } : {}),
      replay: false,
    }
    rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
    return { status: 200, body: outBody }
  }

  if (name === "email.confirm") {
    const emailModel = (dataModel.email && typeof dataModel.email === "object" ? dataModel.email : {}) as Record<string, unknown>
    const to = typeof emailModel.to === "string" ? emailModel.to.trim() : ""
    if (!to) return fail(400, "to_required")
    const rawCc = context.enabledCc !== undefined ? context.enabledCc : emailModel.enabledCc ?? emailModel.cc ?? []
    const parsedCc = parseCcList(rawCc)
    if (!parsedCc) return fail(400, "invalid_enabled_cc")
    const allowedCc = Array.isArray(emailModel.cc)
      ? new Set((emailModel.cc as unknown[]).filter((x): x is string => typeof x === "string"))
      : null
    const enabledCc = allowedCc !== null
      ? parsedCc.filter((addr) => allowedCc.has(addr))
      : []

    const outboundId = typeof emailModel.outboundId === "string" && emailModel.outboundId.trim() ? emailModel.outboundId.trim() : null
    if (outboundId && emailModel.dryRun !== true) {
      if (req.surfaceId !== `outbound-${outboundId}`) return fail(403, "outbound_surface_mismatch")
      const store = resolveOutboundStore(deps.outbound)
      if (!store) return fail(503, "outbound_unavailable")
      const rec = store.get(outboundId)
      if (!rec) return fail(404, "outbound_not_found")
      if (rec.status === "sent") {
        updateSurfaceData(req.surfaceId, "/email/state", "sent", scopedEngine)
        return fail(409, "already_decided", { state: "sent" })
      }
      if (rec.status !== "proposed" || emailModel.state !== "pending") {
        return fail(409, "already_decided", { state: rec.status !== "proposed" ? rec.status : (emailModel.state ?? null) })
      }
      if (!cardShowsRecord(emailModel, rec)) {
        return fail(409, "stale_version")
      }

      let activeRec = rec
      let activeHash = rec.payloadHash
      if (JSON.stringify(enabledCc) !== JSON.stringify(rec.cc)) {
        const updated = store.updateCc(rec.id, enabledCc, rec.payloadHash, Date.now())
        if (!updated) return fail(409, "stale_version")
        activeRec = updated
        activeHash = updated.payloadHash
        updateSurfaceData(req.surfaceId, "/email/payloadHash", activeHash, scopedEngine)
      }

      const refusal = policyRefusal(activeRec)
      if (refusal) return fail(422, "refused", { reason: refusal })
      if (!store.claim(activeRec.id, activeHash, Date.now())) {
        return fail(409, "already_decided")
      }

      updateSurfaceData(req.surfaceId, "/email/enabledCc", enabledCc, scopedEngine)
      updateSurfaceData(req.surfaceId, "/email/state", "sending", scopedEngine)

      const sender = deps.emailSender ?? gmailSender
      let messageId: string | null = null
      try {
        const sendRes = await sender(sendable(activeRec))
        messageId = sendRes.messageId
      } catch (err) {
        const rawErr = (err as Error)?.message ?? String(err)
        const errMsg = stripAngleTags(rawErr).slice(0, 300)
        store.release(activeRec.id, errMsg, Date.now())
        updateSurfaceData(req.surfaceId, "/email/state", "pending", scopedEngine)
        updateSurfaceData(req.surfaceId, "/email/error", errMsg, scopedEngine)
        return fail(502, "send_failed", { detail: errMsg })
      }

      store.markSent(activeRec.id, messageId, Date.now())
      updateSurfaceData(req.surfaceId, "/email/state", "sent", scopedEngine)
      updateSurfaceData(req.surfaceId, "/email/messageId", messageId, scopedEngine)

      const append = scopedEngine.appendTurn ?? appendTurn
      const emit = scopedEngine.emitTurn ?? orchEmit
      const toDisplay = activeRec.to.join(", ")
      const receiptText = `Sent email [${req.surfaceId}] -> ${toDisplay}${enabledCc.length ? ` (Cc: ${enabledCc.join(", ")})` : ""}: "${activeRec.subject}"`
      const receiptTurn = append("orchestrator", receiptText, null, BRAIN_THREAD)
      emit(receiptTurn)

      const outBody: Record<string, unknown> = {
        ok: true,
        surfaceId: req.surfaceId,
        turnId: turn.id,
        action: "email.confirm",
        state: "sent",
        outboundId: activeRec.id,
        messageId,
        to: toDisplay,
        enabledCc,
        subject: activeRec.subject,
        replay: false,
      }
      rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
      return { status: 200, body: outBody }
    }

    if (emailModel.state !== "pending") {
      return fail(409, "already_decided", { state: emailModel.state ?? null })
    }

    updateSurfaceData(req.surfaceId, "/email/enabledCc", enabledCc, scopedEngine)
    const patched = updateSurfaceData(req.surfaceId, "/email/state", "confirmed", scopedEngine)
    if (!patched.ok) return fail(patched.status, patched.error)

    const subject = typeof emailModel.subject === "string" ? emailModel.subject : ""
    const draftId = typeof emailModel.draftId === "string" && emailModel.draftId ? emailModel.draftId : null
    const gmailThreadId = typeof emailModel.gmailThreadId === "string" && emailModel.gmailThreadId ? emailModel.gmailThreadId : null
    const ccSummary = enabledCc.length > 0 ? enabledCc.join(", ") : "none"
    const confirmText =
      `Email confirmed [${req.surfaceId}] — To: ${to} | Cc: ${ccSummary} | Subject: "${subject}"` +
      (draftId ? ` | draftId: ${draftId}` : "") +
      (gmailThreadId ? ` | gmailThreadId: ${gmailThreadId}` : "")

    const append = scopedEngine.appendTurn ?? appendTurn
    const emit = scopedEngine.emitTurn ?? orchEmit
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
    rememberActionKey(turn.id, req.actionKey, outBody, scopedEngine)
    return { status: 200, body: outBody }
  }

  return fail(400, "unknown_action")
}

/** Execute `POST /api/brain/a2ui/action` with in-flight coalescing, `actionKey` idempotency, and deterministic actions. */
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
  const strictTurnPin = isReservedAction(req.action.name) || /^(?:outbound|pr)-/.test(req.surfaceId)
  const turn = byId && byId.card?.kind === "a2ui" && byId.card.surfaceId === req.surfaceId
    ? byId
    : strictTurnPin
      ? null
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

  const flightKey = `${turn.id}:${req.actionKey}`
  const existingFlight = inFlightActions.get(flightKey)
  if (existingFlight) {
    const first = await existingFlight
    if (first.status === 200 && first.body.ok === true) {
      return { status: 200, body: { ...first.body, replay: true } }
    }
    return first
  }

  const task = runActionForTurn(req, turn, deps)
  inFlightActions.set(flightKey, task)
  try {
    return await task
  } finally {
    inFlightActions.delete(flightKey)
  }
}
