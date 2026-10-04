import { join } from "node:path"
import type { ApnsPayload } from "./apns"
import { BODY_CHANNEL, type BodyComponentDetail, isHealthIntent } from "./body"
import { clampChars, collapseIdFor } from "./body-alert"
import {
  localBodyHost,
  type BodyHost, type InvestigationRecord, type InvestigationReport, type InvestigationStore, FORWARD_STALE_MS, MAX_ATTEMPTS,
  gate, hostFromId, investigationDigest, isProblemState, routeFor,
} from "./body-investigate"
import {
  type InvestigatorRunner, type KnownPaths, buildInvestigationPrompt, failureTurnText, proposalPrompt, reportTurnText,
} from "./body-investigator"
import { getAuthToken } from "./auth"
import type { FixCard } from "./body-fix"
import { toTaskDto } from "./dispatch-tasks"
import { companionLog } from "./log"
import type { Task } from "./orchestrator-chat"
import type { ExecFn } from "./turso"

// Body auto-investigation engine (living-system nervous system), seams only —
// no sqlite, no server state, so it is testable anywhere (the live instance is
// wiring/body-investigate.ts). Triggered by the alert path (routes/body.ts)
// and a sweep on boot + every 10 min. Runs the read-only investigator on the
// owning host, forwards Mac components from Zettlab to the Mac Companion, and
// turns each finished investigation into a #Body turn, an optional proposal
// card, a Turso body_events row and (rarely) a push. Policy lives in
// lib/body-investigate.ts. Contract: docs/body-api.md.

export const PEER_TIMEOUT_MS = 10_000
export const HOP_HEADER = "x-companion-body-hop"
export const DEFAULT_NOTE_ID = "projects/2026-06-22-companion-orchestrator"

export type RequestStatus = "started" | "forwarded" | "pending_host" | "duplicate" | "skipped" | "not_owner" | "disabled"
export interface RequestOutcome { status: RequestStatus; id?: string; reason?: string }
export type ForwardResult = { kind: "accepted"; status: string } | { kind: "skipped"; reason: string } | { kind: "unreachable"; reason: string }

export interface ConsiderInput {
  componentId: string
  state?: string | null
  fromState?: string | null
  trigger: "alert" | "sweep" | "forward" | "manual"
  /** Arrived over the peer hop: never forwarded again. */
  hop?: boolean
  /** A human asked again (triage requeue): skip the failed-twice cooldown. */
  force?: boolean
}

export interface InvestigatorDeps {
  store: InvestigationStore
  localHost: () => BodyHost
  enabled: () => boolean
  now?: () => number
  /** Component + vitals + events (Turso). null = no such component. */
  fetchDetail: (id: string) => Promise<BodyComponentDetail | null>
  /** Non-retired components currently dead / crash_loop / failing. */
  listProblems: () => Promise<{ id: string; host: string | null; state: string; criticality: string | null }[]>
  paths: (detail: BodyComponentDetail) => KnownPaths
  run: InvestigatorRunner
  /** Zettlab → Mac. null = no peer configured. */
  forward: ((input: ConsiderInput & { state: string }) => Promise<ForwardResult>) | null
  /** Mac → Zettlab (the #Body owner). null = apply locally. Resolves true when the owner accepted it. */
  sendReport: ((report: InvestigationReport) => Promise<boolean>) | null
  /** Turn, proposal, Turso row, push. Returns the proposal id (if any). */
  apply: (report: InvestigationReport, record: InvestigationRecord) => Promise<string | null>
  log?: (msg: string) => void
}

export interface BodyInvestigator {
  consider(input: ConsiderInput): Promise<RequestOutcome>
  sweep(): Promise<void>
  receiveReport(report: InvestigationReport): Promise<"applied" | "duplicate">
  latestFor(componentId: string): InvestigationRecord | null
  /** Boot: close rows a restart orphaned. */
  recover(): string[]
  /** Test seam: every run started so far has finished. */
  idle(): Promise<void>
}

const CRIT_RANK: Record<string, number> = { critical: 0, high: 1, med: 2, medium: 2, normal: 2, low: 3 }

export function createBodyInvestigator(deps: InvestigatorDeps): BodyInvestigator {
  const now = deps.now ?? Date.now
  const log = deps.log ?? companionLog
  const inflight = new Set<Promise<void>>()

  async function hostOf(componentId: string): Promise<string | null> {
    const fromId = hostFromId(componentId)
    if (fromId) return fromId
    const d = await deps.fetchDetail(componentId).catch(() => null)
    return d ? String(d.component.host ?? "") || null : null
  }

  async function stateOf(input: ConsiderInput): Promise<string | null> {
    if (input.state) return input.state
    const d = await deps.fetchDetail(input.componentId).catch(() => null)
    return d?.vitals?.state ?? null
  }

  function startRun(rec: InvestigationRecord): void {
    const p = runOne(rec).catch((err) => log(`[body-investigate] ${rec.id} crashed: ${(err as Error)?.message ?? err}`))
    const tracked = p.finally(() => inflight.delete(tracked))
    inflight.add(tracked)
  }

  async function runOne(rec: InvestigationRecord): Promise<void> {
    log(`[body-investigate] ${rec.id} start ${rec.componentId} (${rec.state}, attempt ${rec.attempt})`)
    let detail: BodyComponentDetail | null = null
    try { detail = await deps.fetchDetail(rec.componentId) } catch { /* below */ }
    let paths: KnownPaths = { files: [], commands: [], cwd: null, repo: null }
    let outcome: Awaited<ReturnType<InvestigatorRunner>>
    if (!detail) outcome = { ok: false, error: "component record unavailable (Turso)" }
    else {
      paths = deps.paths(detail)
      outcome = await deps.run(buildInvestigationPrompt({ detail, paths }))
    }
    const finishedAt = now()
    const done = deps.store.update(rec.id, outcome.ok
      ? { status: "done", finishedAt, result: outcome.result, error: null }
      : { status: "failed", finishedAt, error: outcome.error })!
    log(`[body-investigate] ${rec.id} ${done.status}${outcome.ok ? "" : ` — ${outcome.error}`}`)
    await report(done, paths)
  }

  function toReport(rec: InvestigationRecord, paths: KnownPaths): InvestigationReport {
    return {
      id: rec.id, componentId: rec.componentId, host: rec.host, state: rec.state, status: rec.status === "done" ? "done" : "failed",
      attempt: rec.attempt, startedAt: rec.startedAt, finishedAt: rec.finishedAt ?? now(), runOn: deps.localHost(),
      result: rec.result, error: rec.error, cwd: paths.repo ?? paths.cwd, repo: !!paths.repo,
    }
  }

  async function report(rec: InvestigationRecord, paths: KnownPaths): Promise<void> {
    const r = toReport(rec, paths)
    if (deps.sendReport) {
      const sent = await deps.sendReport(r).catch(() => false)
      if (sent) { deps.store.update(rec.id, { reported: true }); return }
      log(`[body-investigate] ${rec.id} report to peer failed — posting in this host's #Body`)
    }
    const proposalId = await deps.apply(r, rec).catch((err) => { log(`[body-investigate] ${rec.id} report failed: ${(err as Error)?.message ?? err}`); return null })
    deps.store.update(rec.id, { reported: true, proposalId: proposalId ?? undefined })
  }

  async function forwardOne(input: ConsiderInput, state: string, host: string, attempt: number, retry: InvestigationRecord | null): Promise<RequestOutcome> {
    const result: ForwardResult = deps.forward
      ? await deps.forward({ ...input, state }).catch((e) => ({ kind: "unreachable" as const, reason: (e as Error)?.message ?? "error" }))
      : { kind: "unreachable", reason: "no peer configured (COMPANION_BODY_PEER)" }
    if (result.kind === "skipped") {
      if (retry) deps.store.update(retry.id, { status: "dropped", finishedAt: now(), error: `peer skipped: ${result.reason}` })
      return { status: "skipped", reason: `peer: ${result.reason}` }
    }
    const status = result.kind === "accepted" ? "forwarded" : "pending_host"
    const error = result.kind === "unreachable" ? result.reason : null
    const rec = retry
      ? deps.store.update(retry.id, { status, error, startedAt: now() })!
      : deps.store.insert({ componentId: input.componentId, host, state, fromState: input.fromState, trigger: input.trigger, status, runOn: "peer", attempt, startedAt: now() }, now())
    return { status, id: rec.id, reason: error ?? undefined }
  }

  const api: BodyInvestigator = {
    async consider(input) {
      if (!deps.enabled()) return { status: "disabled" }
      const host = await hostOf(input.componentId)
      const route = routeFor(host, deps.localHost())
      if (route === "not_owner" || (route === "forward" && input.hop)) return { status: "not_owner" }
      const state = await stateOf(input)
      if (!state || !isProblemState(state)) return { status: "skipped", reason: "not a problem state" }
      // gate + insert run with no await in between: two triggers can't both pass.
      const verdict = gate(deps.store, { componentId: input.componentId, state, fromState: input.fromState }, now(), { budget: route === "local", force: input.force === true })
      if (!verdict.ok) return verdict.open ? { status: "duplicate", id: verdict.open.id, reason: verdict.reason } : { status: "skipped", reason: verdict.reason }
      if (route === "forward") return forwardOne(input, state, host!, verdict.attempt, verdict.retry)
      const rec = deps.store.insert({
        componentId: input.componentId, host: host!, state, fromState: input.fromState, trigger: input.trigger,
        status: "running", runOn: "local", attempt: verdict.attempt, startedAt: now(),
      }, now())
      startRun(rec)
      return { status: "started", id: rec.id }
    },

    async sweep() {
      if (!deps.enabled()) return
      for (const r of deps.store.listOpen()) {
        if (r.status === "forwarded" && now() - (r.startedAt ?? r.createdAt) > FORWARD_STALE_MS) {
          deps.store.update(r.id, { status: "failed", finishedAt: now(), error: "no report from the mac within 30 min" })
        }
      }
      let problems: Awaited<ReturnType<InvestigatorDeps["listProblems"]>>
      try { problems = await deps.listProblems() } catch (err) {
        log(`[body-investigate] sweep skipped: ${(err as Error)?.message ?? "Turso unreachable"}`)
        return
      }
      const ids = new Set(problems.map((p) => p.id))
      // A host that stayed unreachable while its component recovered: nothing left to investigate.
      for (const r of deps.store.listOpen()) {
        if (r.status === "pending_host" && !ids.has(r.componentId)) deps.store.update(r.id, { status: "dropped", finishedAt: now(), error: "recovered before its host was reachable" })
      }
      const ordered = [...problems].sort((a, b) => (CRIT_RANK[a.criticality ?? ""] ?? 2) - (CRIT_RANK[b.criticality ?? ""] ?? 2) || a.id.localeCompare(b.id))
      for (const p of ordered) {
        const out = await api.consider({ componentId: p.id, state: p.state, trigger: "sweep" })
        if (out.status === "started" || out.status === "forwarded") log(`[body-investigate] sweep → ${p.id} ${out.status}`)
      }
    },

    async receiveReport(r) {
      const existing = deps.store.byPeerId(r.id)
      if (existing?.reported) return "duplicate"
      const open = existing ?? deps.store.open(r.componentId)
      const patch = { status: r.status, finishedAt: r.finishedAt, result: r.result, error: r.error, peerId: r.id, attempt: r.attempt } as const
      const rec = open && open.status !== "running"
        ? deps.store.update(open.id, patch)!
        : deps.store.update(deps.store.insert({
            componentId: r.componentId, host: r.host, state: r.state, trigger: "forward", status: r.status, runOn: "peer", attempt: r.attempt, startedAt: r.startedAt, peerId: r.id,
          }, now()).id, patch)!
      const proposalId = await deps.apply(r, rec)
      deps.store.update(rec.id, { reported: true, proposalId: proposalId ?? undefined })
      return "applied"
    },

    latestFor: (id) => deps.store.latest(id),
    recover: () => deps.store.closeInterrupted(now()),
    async idle() {
      while (inflight.size) await Promise.all([...inflight])
    },
  }
  return api
}

// ── Report effects (the #Body owner) ─────────────────────────────────────────

export interface ApplyDeps {
  appendTurn: (text: string, taskId?: string | null) => { id: string }
  ensureChannel: () => { created: boolean; channel: unknown }
  createProposal: (prompt: string, cwd: string, reasoning: string, target: { noteId: string; agent: string; title: string }) => Task
  broadcast: (frame: Record<string, unknown>) => void
  push: (payload: ApnsPayload) => void
  pushEnabled: () => boolean
  writeEvent: (componentId: string, at: string, state: string, detail: string) => Promise<void>
  noteId: () => string
  /** A Mac component's card: remember host + cwd so approval runs live on the Mac (lib/body-fix.ts). */
  recordFixCard?: (card: FixCard) => void
  home: string
  /** This host (defaults to the platform): a card for another host gets a host-neutral `~/.claude`. */
  localHost?: () => BodyHost
  now?: () => number
  log?: (msg: string) => void
}

const PUSH_SEVERITIES = new Set(["high", "critical"])

export function createReportApplier(deps: ApplyDeps): (r: InvestigationReport, rec: InvestigationRecord) => Promise<string | null> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? companionLog
  const say = (text: string, taskId: string | null = null) => {
    const turn = deps.appendTurn(text, taskId)
    deps.broadcast({ type: "orchestrator", turn })
  }
  return async (r, rec) => {
    const { created, channel } = deps.ensureChannel()
    if (created) deps.broadcast({ type: "orchestrator_channel", channel })
    let proposalId: string | null = null
    let detail: string
    if (r.status === "done" && r.result) {
      const res = r.result
      say(reportTurnText(r.componentId, res))
      if (res.recommendedFix) {
        // A Mac fix runs on the Mac: write a host-neutral path; the Mac localizes it (lib/body-fix.ts localizeCwd).
        const cwd = r.cwd || (r.host !== (deps.localHost?.() ?? localBodyHost()) ? "~/.claude" : join(deps.home, ".claude"))
        const agent = r.repo ? "builder" : "claude"
        const title = clampChars(`${res.retire ? "Retire" : "Fix"} ${r.componentId}: ${res.recommendedFix.summary}`, 120)
        const reasoning = `Body investigation ${rec.id}: ${res.rootCause} (confidence ${Math.round(res.confidence * 100)}%, ${res.recommendedFix.risk} risk)`
        const noteId = deps.noteId()
        const task = deps.createProposal(proposalPrompt({ componentId: r.componentId, host: r.host, state: r.state, investigationId: rec.id, cwd }, res), cwd, reasoning, { noteId, agent, title })
        proposalId = task.taskId
        const onMac = r.host === "mac"
        if (onMac) deps.recordFixCard?.({ taskId: task.taskId, host: r.host, componentId: r.componentId, cwd, noteId, agent, title, investigationId: rec.id })
        const how = onMac ? `Approve to run it live on the mac (in ${cwd}).` : "Approve to file it."
        say(`Proposal [${task.taskId}] — ${agent} · ${r.componentId} · host ${r.host}\nWhy: ${reasoning}\nTask: ${res.recommendedFix.summary}\n${how}`, task.taskId)
        deps.broadcast({ type: "orchestrator_task", task: toTaskDto(task) })
      }
      detail = `investigation ${rec.id}: ${res.rootCause} (${Math.round(res.confidence * 100)}%, ${res.severity})${proposalId ? ` · fix proposed [${proposalId}]` : " · no fix"}`
      if (PUSH_SEVERITIES.has(res.severity) && deps.pushEnabled()) {
        deps.push(investigationPush(r.componentId, `🔍 ${r.componentId}`, `${res.rootCause}${proposalId ? " — fix proposed" : ""}`))
      }
    } else {
      const error = r.error ?? "unknown error"
      say(failureTurnText(r.componentId, error, r.attempt))
      detail = `investigation ${rec.id} failed: ${error}`
      if (r.attempt >= MAX_ATTEMPTS && deps.pushEnabled()) deps.push(investigationPush(r.componentId, `Investigation failed twice: ${r.componentId}`, error))
    }
    await deps.writeEvent(r.componentId, new Date(now()).toISOString(), r.state, clampChars(detail, 500)).catch((err) => {
      log(`[body-investigate] body_events write failed (${(err as Error)?.message ?? "error"})`)
    })
    return proposalId
  }
}

export function investigationPush(componentId: string, title: string, body: string): ApnsPayload {
  return {
    title: clampChars(title, 120), body: clampChars(body, 180), category: "body_alert", threadId: "body",
    collapseId: collapseIdFor(`inv-${componentId}`), interruptionLevel: "active",
    userInfo: { kind: "body_alert", component_id: componentId },
  }
}

/** The one Turso write this feature makes: an `investigation` row in body_events. */
export async function writeInvestigationEvent(exec: ExecFn, componentId: string, at: string, state: string, detail: string): Promise<void> {
  await exec("INSERT INTO body_events (component_id, at, kind, from_state, to_state, detail) VALUES (?, ?, 'investigation', NULL, ?, ?)", [componentId, at, state, detail])
}

// ── Peer (Mac ↔ Zettlab) ─────────────────────────────────────────────────────

export interface PeerConfig { base: string; token: string }

/** COMPANION_BODY_PEER: https://…, or http:// to loopback / a tailnet (100.64/10, *.ts.net) host. */
export function bodyPeer(env: Record<string, string | undefined> = process.env, ownToken: () => string = getAuthToken): PeerConfig | null {
  const raw = env.COMPANION_BODY_PEER?.trim()
  if (!raw) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  const h = u.hostname
  const tailnet = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(h) || h.endsWith(".ts.net") || h === "127.0.0.1" || h === "localhost"
  if (u.username || u.password || u.search || !(u.protocol === "https:" || (u.protocol === "http:" && tailnet))) return null
  return { base: `${u.origin}${u.pathname.replace(/\/+$/, "")}`, token: env.COMPANION_BODY_PEER_TOKEN?.trim() || ownToken() }
}

async function peerPost(cfg: PeerConfig, body: unknown, fetchFn: typeof fetch = fetch): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetchFn(`${cfg.base}/api/body/investigate`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", [HOP_HEADER]: "1" },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, json }
}

export function peerForwarder(cfg: PeerConfig, fetchFn: typeof fetch = fetch): NonNullable<InvestigatorDeps["forward"]> {
  return async (input) => {
    try {
      const { status, json } = await peerPost(cfg, { component_id: input.componentId, state: input.state, from_state: input.fromState ?? null, trigger: input.trigger, ...(input.force ? { force: true } : {}) }, fetchFn)
      if (status !== 200 || !json?.ok) return { kind: "unreachable", reason: `peer http ${status}` }
      const s = String(json.status ?? "")
      if (s === "started" || s === "duplicate") return { kind: "accepted", status: s }
      return { kind: "skipped", reason: `${s}${json.reason ? ` (${String(json.reason)})` : ""}` }
    } catch (e) {
      return { kind: "unreachable", reason: `peer unreachable (${(e as Error)?.name ?? "error"})` }
    }
  }
}

export function peerReporter(cfg: PeerConfig, fetchFn: typeof fetch = fetch): NonNullable<InvestigatorDeps["sendReport"]> {
  return async (report) => {
    try {
      const { status, json } = await peerPost(cfg, { report }, fetchFn)
      return status === 200 && json?.ok === true
    } catch {
      return false
    }
  }
}

// ── Brain digest gate ────────────────────────────────────────────────────────

/** #Body / health questions: open + recent investigations for the brain. */
export function investigationDigestFor(channelId: string, text: string, store: InvestigationStore, now: number = Date.now()): string | null {
  if (channelId !== BODY_CHANNEL && !isHealthIntent(text)) return null
  return investigationDigest(store, now)
}
