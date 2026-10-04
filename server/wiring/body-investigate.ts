import { homedir } from "node:os"
import { apnsConfigured } from "../lib/apns"
import { BODY_CHANNEL, BODY_CHANNEL_NAME, buildComponentDetail } from "../lib/body"
import { bodyPushEnabled } from "../lib/body-alert"
import { createBodyFixStore } from "../lib/body-fix"
import { type InvestigationStore, createInvestigationStore, investigateEnabled, isProblemState, localBodyHost } from "../lib/body-investigate"
import {
  type BodyInvestigator, DEFAULT_NOTE_ID, bodyPeer, createBodyInvestigator, createReportApplier, investigationDigestFor as engineDigestFor,
  peerForwarder, peerReporter, writeInvestigationEvent,
} from "../lib/body-investigate-engine"
import { knownPaths, runInvestigatorCli } from "../lib/body-investigator"
import { companionLog } from "../lib/log"
import { appendTurn, createProposal } from "../lib/orchestrator-chat"
import { ensureChannel } from "../lib/orchestrator-channels"
import { db } from "../lib/orchestrator-db"
import { pushToAll } from "../lib/push"
import { tursoExec, tursoQuery } from "../lib/turso"
import { broadcast } from "../state"
import { bodySnapshot } from "./body"

// Body auto-investigation, live instance: the engine (lib/body-investigate-engine.ts)
// wired to the Companion sqlite, Turso, the #Body channel, push and the peer host.
// Built on first use; `startBodyInvestigate()` (cli.ts) starts the sweeps.

export { HOP_HEADER, type BodyInvestigator } from "../lib/body-investigate-engine"

export const SWEEP_MS = 10 * 60_000
export const BOOT_SWEEP_DELAY_MS = 60_000

const store = createInvestigationStore(db)
/** Mac fix cards (Zettlab) and forwarded fix runs (Mac) — wiring/body-fix.ts reads it. */
export const bodyFixStore = createBodyFixStore(db)

async function listProblems() {
  const body = await bodySnapshot.get({ fresh: true })
  return body.components
    .filter((c) => isProblemState(c.state))
    .map((c) => ({ id: c.id, host: c.host == null ? null : String(c.host), state: c.state, criticality: c.criticality == null ? null : String(c.criticality) }))
}

let applier: ReturnType<typeof createReportApplier> | null = null
/** The #Body report effects (turn, proposal, Turso event, push) — shared by the investigator and the Opus resolver. */
export function bodyReportApplier(): ReturnType<typeof createReportApplier> {
  applier ??= createReportApplier({
    appendTurn: (text, taskId = null) => appendTurn("orchestrator", text, taskId, BODY_CHANNEL),
    ensureChannel: () => ensureChannel(BODY_CHANNEL, BODY_CHANNEL_NAME),
    createProposal: (prompt, cwd, reasoning, target) => createProposal(prompt, cwd, reasoning, BODY_CHANNEL, target),
    broadcast,
    push: (p) => void pushToAll(p).catch(() => {}),
    pushEnabled: () => bodyPushEnabled(apnsConfigured()),
    writeEvent: (id, at, state, detail) => writeInvestigationEvent(tursoExec, id, at, state, detail),
    noteId: () => process.env.COMPANION_BODY_NOTE_ID?.trim() || DEFAULT_NOTE_ID,
    home: process.env.HOME || homedir(),
    recordFixCard: (card) => bodyFixStore.recordCard(card, Date.now()),
  })
  return applier
}

function makeLive(): BodyInvestigator {
  const peer = bodyPeer()
  const local = localBodyHost()
  return createBodyInvestigator({
    store,
    localHost: () => local,
    // Never under `bun test`: a test that reaches the live instance must not spawn a real claude.
    enabled: () => process.env.NODE_ENV !== "test" && investigateEnabled(),
    fetchDetail: (id) => buildComponentDetail(tursoQuery, id),
    listProblems,
    paths: (d) => knownPaths(d.component),
    run: (prompt) => runInvestigatorCli(prompt),
    forward: local === "zettlab" && peer ? peerForwarder(peer) : null,
    sendReport: local === "mac" && peer ? peerReporter(peer) : null,
    apply: bodyReportApplier(),
  })
}

let live: BodyInvestigator | null = null
/** The wired instance (built on first use so tests that never touch it pay nothing). */
export function bodyInvestigator(): BodyInvestigator {
  live ??= makeLive()
  return live
}

/** The investigation records (triage reads the failed-twice components). */
export function investigationStore(): InvestigationStore {
  return store
}

/** #Body / health questions: open + recent investigations for the brain. */
export function investigationDigestFor(channelId: string, text: string): string | null {
  return engineDigestFor(channelId, text, store)
}

/** Boot (cli.ts): close orphaned runs, sweep after a minute, then every 10 min. */
export function startBodyInvestigate(): () => void {
  const inv = bodyInvestigator()
  const closed = inv.recover()
  if (closed.length) companionLog(`[body-investigate] closed ${closed.length} run(s) a restart interrupted`)
  const tick = () => void inv.sweep().catch((err) => companionLog(`[body-investigate] sweep failed: ${(err as Error)?.message ?? err}`))
  const boot = setTimeout(tick, BOOT_SWEEP_DELAY_MS)
  const every = setInterval(tick, SWEEP_MS)
  for (const t of [boot, every]) (t as unknown as { unref?: () => void }).unref?.()
  return () => { clearTimeout(boot); clearInterval(every) }
}
