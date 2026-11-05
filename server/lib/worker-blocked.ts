import type { ApnsPayload } from "./apns"
import type { Turn, TurnCard } from "./orchestrator-chat"
import { redactSecrets } from "./secret-redact"

// A herdr dispatch worker stuck on an interactive dialog (permission prompt,
// question). The runner (claude-config tools/dispatch-runner.ts) posts it after
// 30 s; it becomes a brain-thread card with the dialog's options + one push.
// The phone answers once (first answer wins, Idempotency-Key replays); the
// runner polls the alert and types the chosen key into the pane itself. The
// card's state (open → answered | expired) and both replay keys live in the
// turn's card (sqlite), so they survive a restart. The brain reads only `brief`
// (lib/brain.ts brainText: delivery, boot seed and bin/thread), never the whole
// dialog: it is untrusted pane text.
// Contract: docs/worker-blocked-api.md.

/** Only herdr dispatch workers: never cc-*, builder-*, tko-* or anything else. */
export const WORKER_RE = /^dispatch-[0-9a-f]{8}$/
/** Never offered: "Yes, and switch to auto mode" or "Yes, and don't ask again" would lift later prompts too. */
const STANDING_GRANT_RE = /auto[\s-]*mode|(don['’]?t|do not) ask again/i
/** The runner's give-up while an alert is open; past it the card reads expired. */
export const ALERT_TTL_MS = 30 * 60_000
const KEY_RE = /^[0-9A-Za-z]$/
const TASK_RE = /^[\w-]{1,64}$/
const TITLE_MAX = 200
const DIALOG_MAX = 2000
const LABEL_MAX = 80
const OPTIONS_MAX = 9

export interface BlockedInput {
  taskId: string
  title: string
  worker: string
  dialog: string
  /** key = what the runner types in the pane for this option ("1", "3"…). */
  options: { key: string; label: string }[]
}

/** What the brain reads: task, worker and the tool word. Any more of the dialog would be an injection path. */
export function alertBrief(input: BlockedInput): string {
  const head = input.dialog.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
  const tool = /^[A-Za-z][\w-]{0,30}/.exec(head)?.[0] ?? "unknown"
  return `Worker blocked: task ${input.taskId} (${input.worker}) waits on a ${tool} dialog. Jeremie answers it from his phone; never answer it, type into or drive that worker's pane.`
}

/** Push with bounded retry: a transient APNs failure gets 3 more tries (same payload, so the same collapse id). */
export async function pushWithRetry(
  send: (p: ApnsPayload) => Promise<{ sent: number; pruned: number; total: number }>,
  payload: ApnsPayload,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
  delays = [5_000, 30_000, 120_000],
): Promise<boolean> {
  for (let i = 0; ; i++) {
    const r = await send(payload).catch(() => null)
    if (r && (r.sent > 0 || r.total === r.pruned)) return true
    if (i >= delays.length) return false
    await sleep(delays[i]!)
  }
}

export interface WorkerBlockedDeps {
  appendTurn: (text: string, card: TurnCard) => Turn
  getTurn: (id: string) => Turn | null
  setCard: (id: string, patch: Partial<TurnCard>) => Turn | null
  /** The worker_blocked turn whose card carries this runner Idempotency-Key. */
  findByPostKey: (key: string) => Turn | null
  /** Ids of worker_blocked turns whose card is still open. */
  openIds: () => string[]
  broadcast: (frame: Record<string, unknown>) => void
  push: (payload: ApnsPayload) => void
  now?: () => number
}

export interface Result { status: number; body: Record<string, unknown> }

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "")
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Result => ({ status, body: { ok: false, error, ...extra } })

/** Validate the runner's body; a string is the 4xx error code. */
export function parseBlocked(raw: unknown): BlockedInput | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid_body"
  const b = raw as Record<string, unknown>
  const worker = str(b.worker)
  if (!WORKER_RE.test(worker)) return "not_dispatch_worker"
  const taskId = str(b.taskId)
  if (!TASK_RE.test(taskId)) return "taskId_required"
  const title = str(b.title).slice(0, TITLE_MAX)
  const dialog = redactSecrets(str(b.dialog)).slice(0, DIALOG_MAX)
  if (!dialog) return "dialog_required"
  if (!Array.isArray(b.options) || b.options.length > OPTIONS_MAX) return "options_invalid"
  const options: BlockedInput["options"] = []
  for (const o of b.options as unknown[]) {
    const rec = o && typeof o === "object" ? o as Record<string, unknown> : {}
    const key = str(rec.key)
    const label = redactSecrets(str(rec.label)).slice(0, LABEL_MAX)
    if (!KEY_RE.test(key) || !label) return "options_invalid"
    if (!STANDING_GRANT_RE.test(label) && !options.some((x) => x.key === key)) options.push({ key, label })
  }
  if (!options.length) return "options_invalid"
  return { taskId, title, worker, dialog, options }
}

export function createWorkerBlocked(deps: WorkerBlockedDeps) {
  const now = deps.now ?? Date.now

  /** The alert's card, expired first if its TTL passed while open. Null = no such alert. */
  function card(id: string): TurnCard | null {
    const turn = deps.getTurn(id)
    const c = turn?.card
    if (!c || c.kind !== "worker_blocked") return null
    if (c.state === "open" && (c.expiresAt ?? 0) <= now()) return update(id, { state: "expired" })
    return c
  }

  function update(id: string, patch: Partial<TurnCard>): TurnCard | null {
    const turn = deps.setCard(id, patch)
    if (turn) deps.broadcast({ type: "orchestrator", turn })
    return turn?.card ?? null
  }

  function view(id: string, c: TurnCard): Record<string, unknown> {
    const opt = c.options?.find((o) => o.id === c.chosen)
    return { ok: true, id, state: c.state, choice: opt ? { key: opt.id, label: opt.label } : null }
  }

  function create(input: BlockedInput, idemKey: string | null): Result {
    const seen = idemKey ? deps.findByPostKey(idemKey)?.id : undefined
    const prior = seen ? card(seen) : null
    if (seen && prior) return { status: 200, body: { ...view(seen, prior), replay: true } }
    const options = input.options.map((o) => ({ id: o.key, label: o.label }))
    const text = `Worker needs you [${input.taskId.slice(0, 8)}] ${input.worker} — ${input.title}\n${input.dialog}\n${options.map((o) => `${o.id}. ${o.label}`).join("\n")}`
    const turn = deps.appendTurn(text, {
      kind: "worker_blocked", source: "app", taskId: input.taskId, worker: input.worker, title: input.title,
      dialog: input.dialog, options, state: "open", expiresAt: now() + ALERT_TTL_MS,
      brief: alertBrief(input), ...(idemKey ? { postKey: idemKey } : {}),
    })
    deps.broadcast({ type: "orchestrator", turn })
    deps.push({
      title: `Worker needs you: ${input.title || input.worker}`.slice(0, 120),
      body: input.dialog.replace(/\s+/g, " ").slice(0, 180),
      category: "dispatch_task",
      threadId: turn.threadId,
      collapseId: `blocked-${turn.id}`.slice(0, 64),
      interruptionLevel: "time-sensitive",
      userInfo: { kind: "worker_blocked", turnId: turn.id, taskId: input.taskId, channel: turn.threadId },
    })
    return { status: 201, body: view(turn.id, turn.card!) }
  }

  function status(id: string): Result {
    const c = card(id)
    return c ? { status: 200, body: view(id, c) } : fail(404, "no_such_alert")
  }

  /** The phone's answer: one per alert. The same Idempotency-Key replays; any other answer is 409. */
  function choose(id: string, optionId: string, idemKey: string | null): Result {
    const c = card(id)
    if (!c) return fail(404, "no_such_alert")
    if (c.state === "answered") {
      if (idemKey && c.answerKey === idemKey && c.chosen === optionId) return { status: 200, body: { ...view(id, c), replay: true } }
      return fail(409, "already_answered", { choice: view(id, c).choice })
    }
    if (c.state !== "open") return fail(410, "expired")
    if (!c.options?.some((o) => o.id === optionId)) return fail(400, "unknown_option")
    const next = update(id, { state: "answered", chosen: optionId, ...(idemKey ? { answerKey: idemKey } : {}) })
    return { status: 200, body: view(id, next ?? { ...c, state: "answered", chosen: optionId }) }
  }

  /** The runner gave up, or the dialog left the screen: an open card reads expired. */
  function close(id: string): Result {
    const c = card(id)
    if (!c) return fail(404, "no_such_alert")
    const out = c.state === "open" ? update(id, { state: "expired" }) ?? c : c
    return { status: 200, body: view(id, out) }
  }

  /** Expire every open alert past its TTL, read or not (the wiring runs it every minute). */
  function sweep(): void {
    for (const id of deps.openIds()) card(id)
  }

  return { create, status, choose, close, sweep }
}

export type WorkerBlocked = ReturnType<typeof createWorkerBlocked>
