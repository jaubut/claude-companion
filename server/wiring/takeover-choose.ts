import type { TriageAction, SourceItem } from "../lib/triage"
import type { ExecOutcome } from "../lib/triage-engine"
import { type TakeoverHost, entryByName, takeoverHostFor } from "../lib/takeover"
import { TursoUnreachable } from "../lib/turso"
import { type StartInput, type StartResult, type TakeoverDetail, TAKEOVER_HOP, localLog, startTakeover, takeoverDeps } from "./takeover"

// The takeover choose (triage execute) and the peer hop (docs/orchestrator-triage-api.md#takeover):
// repo + host resolution, the local start or a forward to the peer, and the peer's endpoint.
// The run itself is wiring/takeover.ts.

const PEER_TIMEOUT_MS = 15_000
const d = takeoverDeps
const refuse = (error: string, extra?: Record<string, unknown>): StartResult => ({ ok: false, status: 409, error, ...(extra ? { extra } : {}) })

type TakeoverAction = Extract<TriageAction, { kind: "takeover" }>

async function forward(host: TakeoverHost, body: StartInput): Promise<StartResult> {
  const peer = d().peer()
  if (!peer) return refuse("host_unreachable", { host, reason: "no peer configured" })
  try {
    const res = await d().fetchFn(`${peer.base}/api/orchestrator/takeover`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${peer.token}`, "content-type": "application/json", [TAKEOVER_HOP]: "1",
        "idempotency-key": `takeover:${body.taskId}:${body.version}`,
      },
      body: JSON.stringify({ ...body, host }),
    })
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
    const detail = json?.detail as TakeoverDetail | undefined
    if (res.status === 200 && json?.ok === true && typeof detail?.session === "string") return { ok: true, detail }
    if (!json || res.status >= 500 || (res.status >= 300 && res.status < 400)) return refuse("host_unreachable", { host, reason: `http ${res.status}` })
    const { ok: _ok, error, ...extra } = json
    return { ok: false, status: res.status === 422 ? 422 : 409, error: String(error ?? "refused"), extra: { host, ...extra } }
  } catch (err) {
    return refuse("host_unreachable", { host, reason: (err as Error)?.name ?? "error" })
  }
}

/** A card's `takeover` choose: resolve the repo (action, else the typed name), then the host — local or the peer, the other host when the first has no checkout. */
export async function takeoverAction(src: SourceItem, a: TakeoverAction, text: string | null, by: string): Promise<ExecOutcome> {
  if (src.ref.source !== "task" || src.ref.status !== "blocked") return { kind: "error", status: 400, error: "wrong_source" }
  const entries = d().entries()
  const typed = !a.repo && text ? entryByName(text, entries) : null
  const repo = a.repo ?? typed?.name ?? null
  if (!repo) return { kind: "error", status: 422, error: "repo_required", extra: { candidates: a.candidates ?? src.takeover?.candidates ?? [] } }
  const target = src.takeover
  const placed = target?.repo === repo ? { host: target.host, pinned: target.pinned } : takeoverHostFor(entryByName(repo, entries), src.title)
  const hosts: TakeoverHost[] = placed.pinned ? [placed.host] : [placed.host, placed.host === "mac" ? "zettlab" : "mac"]
  const input: StartInput = { taskId: src.ref.taskId, version: src.version, repo, by, logTail: localLog(src.title, src.facts.blocker ?? "") }
  for (const host of hosts) {
    const r = host === d().localHost() ? await startTakeover(input) : await forward(host, input)
    if (r.ok) return { kind: "done", detail: { ...r.detail } }
    if (r.error === "stale") return { kind: "stale", reason: "changed" }
    if (r.error !== "no_checkout") return { kind: "error", status: r.status, error: r.error, ...(r.extra ? { extra: r.extra } : {}) }
  }
  return { kind: "error", status: 409, error: "no_checkout", extra: { repo } }
}

/** POST /api/orchestrator/takeover (peer only): start here, never forward again. */
export async function runPeerTakeover(input: StartInput & { host: TakeoverHost }): Promise<{ status: number; body: Record<string, unknown> }> {
  if (input.host !== d().localHost()) return { status: 409, body: { ok: false, error: "not_owner" } }
  try {
    const r = await startTakeover(input)
    return r.ok ? { status: 200, body: { ok: true, detail: r.detail } } : { status: r.status, body: { ok: false, error: r.error, ...r.extra } }
  } catch (err) {
    if (err instanceof TursoUnreachable) return { status: 503, body: { ok: false, error: "turso_unreachable" } }
    throw err
  }
}
