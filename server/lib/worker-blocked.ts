import type { ApnsPayload } from "./apns"
import type { Turn, TurnCard } from "./orchestrator-chat"
import { redactSecrets } from "./secret-redact"

// A herdr dispatch worker stuck on an interactive dialog (permission prompt,
// question). The runner (claude-config tools/dispatch-runner.ts) posts it after
// 30 s; it becomes a brain-thread card with the dialog's options + one push.
// The phone answers once (first answer wins, Idempotency-Key replays); the
// runner polls the alert and types the chosen key into the pane itself. The
// card's state (open → answered | expired) lives in the turn's card (sqlite),
// so it survives a restart; the replay keys are memory only.
// Contract: docs/worker-blocked-api.md.

/** Only herdr dispatch workers: never cc-*, builder-*, tko-* or anything else. */
export const WORKER_RE = /^dispatch-[0-9a-f]{8}$/
/** Never offered: "Yes, and switch to auto mode" would lift every later prompt too. */
const AUTO_MODE_RE = /auto[\s-]*mode/i
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

export interface WorkerBlockedDeps {
  appendTurn: (text: string, card: TurnCard) => Turn
  getTurn: (id: string) => Turn | null
  setCard: (id: string, patch: Partial<TurnCard>) => Turn | null
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
    if (!AUTO_MODE_RE.test(label) && !options.some((x) => x.key === key)) options.push({ key, label })
  }
  if (!options.length) return "options_invalid"
  return { taskId, title, worker, dialog, options }
}

export function createWorkerBlocked(deps: WorkerBlockedDeps) {
  const now = deps.now ?? Date.now
  const byPostKey = new Map<string, string>()
  const answerKey = new Map<string, { idemKey: string; optionId: string }>()

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
    const seen = idemKey ? byPostKey.get(idemKey) : undefined
    const prior = seen ? card(seen) : null
    if (seen && prior) return { status: 200, body: { ...view(seen, prior), replay: true } }
    const options = input.options.map((o) => ({ id: o.key, label: o.label }))
    const text = `Worker needs you [${input.taskId.slice(0, 8)}] ${input.worker} — ${input.title}\n${input.dialog}\n${options.map((o) => `${o.id}. ${o.label}`).join("\n")}`
    const turn = deps.appendTurn(text, {
      kind: "worker_blocked", source: "app", taskId: input.taskId, worker: input.worker, title: input.title,
      dialog: input.dialog, options, state: "open", expiresAt: now() + ALERT_TTL_MS,
    })
    if (idemKey) byPostKey.set(idemKey, turn.id)
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
      const prev = answerKey.get(id)
      if (idemKey && prev?.idemKey === idemKey && prev.optionId === optionId) return { status: 200, body: { ...view(id, c), replay: true } }
      return fail(409, "already_answered", { choice: view(id, c).choice })
    }
    if (c.state !== "open") return fail(410, "expired")
    if (!c.options?.some((o) => o.id === optionId)) return fail(400, "unknown_option")
    const next = update(id, { state: "answered", chosen: optionId })
    if (idemKey) answerKey.set(id, { idemKey, optionId })
    return { status: 200, body: view(id, next ?? { ...c, state: "answered", chosen: optionId }) }
  }

  /** The runner gave up, or the dialog left the screen: an open card reads expired. */
  function close(id: string): Result {
    const c = card(id)
    if (!c) return fail(404, "no_such_alert")
    const out = c.state === "open" ? update(id, { state: "expired" }) ?? c : c
    return { status: 200, body: view(id, out) }
  }

  return { create, status, choose, close }
}

export type WorkerBlocked = ReturnType<typeof createWorkerBlocked>
