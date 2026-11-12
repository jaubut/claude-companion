import { companionLog } from "../lib/log"
import { ESC_SETTLE_MS } from "../lib/command-list"
import type { Dialog } from "../lib/dialogs"
import { choicesFrom, isModelPicker, openRefusal, setKeys, type ModelChoice, type ModelScope } from "../lib/model-control"
import { recordSession, resolveSession, setSessionModel, type Session } from "../lib/sessions"
import { type SessionPane, sessionPaneOf } from "../lib/session-pane"
import { dialogWatcher } from "../wiring/dialogs"
import { checked, jsonObject } from "../lib/json-body"
import { getBrainModel, setBrainModel } from "../wiring/brain"
import { workerSupervisor } from "../wiring/worker-mcp"

interface HeadlessModelEntry {
  id: string
  family: "claude" | "codex" | "gemini"
  text: string
  aliases: string[]
}

const HEADLESS_MODELS: HeadlessModelEntry[] = [
  { id: "auto", family: "claude", text: "Auto (Jev Router) · Opus for planning & complex work, Sonnet for routine", aliases: ["auto", "jev"] },
  { id: "claude-opus-5-5", family: "claude", text: "Opus 5.5 · Most capable for complex work", aliases: ["opus", "claude-opus-5-5", "opus 5.5"] },
  { id: "claude-sonnet-5-5", family: "claude", text: "Sonnet 5.5 · Best for everyday tasks", aliases: ["sonnet", "claude-sonnet-5-5", "sonnet 5.5"] },
  { id: "claude-fable-5-1", family: "claude", text: "Fable 5.1 · Fast & expressive", aliases: ["fable", "claude-fable-5-1", "fable 5.1"] },
  { id: "claude-haiku-4-5", family: "claude", text: "Haiku 4.5 · Fastest for quick answers", aliases: ["haiku", "claude-haiku-4-5", "haiku 4.5"] },
  { id: "claude-sonnet-5", family: "claude", text: "Sonnet 5 · Previous generation Sonnet", aliases: ["claude-sonnet-5", "sonnet 5"] },
  { id: "claude-opus-5", family: "claude", text: "Opus 5 · Previous generation Opus", aliases: ["claude-opus-5", "opus 5"] },
  { id: "gpt-5.4", family: "codex", text: "GPT-5.4 (Codex) · OpenAI flagship coding agent", aliases: ["gpt-5.4", "codex"] },
  { id: "o3", family: "codex", text: "o3 (Codex) · Deep reasoning model", aliases: ["o3"] },
  { id: "Gemini 4 Argon (Medium)", family: "gemini", text: "Gemini 4 Argon (Medium) · Antigravity default", aliases: ["gemini-4-argon-medium", "gemini 4 argon (medium)", "gemini 4 argon"] },
  { id: "Gemini 4 Argon (High)", family: "gemini", text: "Gemini 4 Argon (High) · Deep reasoning", aliases: ["gemini-4-argon-high", "gemini 4 argon (high)"] },
  { id: "Gemini 4 Carbon (High)", family: "gemini", text: "Gemini 4 Carbon (High) · Frontier multimodal", aliases: ["gemini-4-carbon-high", "gemini 4 carbon (high)", "gemini 4 carbon"] },
  { id: "Gemini 3.8 Flash (High)", family: "gemini", text: "Gemini 3.8 Flash (High) · High-speed agentic", aliases: ["gemini-3.8-flash-high", "gemini 3.8 flash (high)", "gemini 3.8 flash"] },
  { id: "gemini-3.1-pro-preview", family: "gemini", text: "Gemini 3.1 Pro · Google flagship multimodal agent", aliases: ["gemini-3.1-pro-preview", "gemini"] },
]

function isHeadlessSession(session: Session | null): boolean {
  if (!session) return false
  if (typeof session.herdrPane === "string" && session.herdrPane.startsWith("headless:")) return true
  if (session.agent === "gemini" || session.agent === "codex") return true
  return false
}

function headlessCatalogFor(session: Session): HeadlessModelEntry[] {
  if (session.taskId === "brain") {
    return HEADLESS_MODELS.filter((m) => m.family === "claude")
  }
  return HEADLESS_MODELS
}

function buildHeadlessChoices(session: Session): ModelChoice[] {
  const catalog = headlessCatalogFor(session)
  const rawCurrent = (session.taskId === "brain" ? (session.model || getBrainModel()) : session.model || "claude-opus-5-5").trim().toLowerCase()
  let matchedIndex = catalog.findIndex((m) => m.id.toLowerCase() === rawCurrent || m.aliases.includes(rawCurrent))
  if (matchedIndex < 0) matchedIndex = 0
  return catalog.map((m, idx) => ({
    index: idx,
    text: m.text,
    current: idx === matchedIndex,
  }))
}

// Model control routes (PRJ-OR1T Phase 14, gap-table A1·A2·A3).
//
// Two calls: `open` puts the picker up and hands back the real list, `set`
// drives it. Both go through the session's pane (tmux, else herdr:
// lib/session-pane.ts) the same way lib/dialogs.ts already does; see lib/model-control.ts for why the picker is driven rather than
// `/model <id>` sent as text.

// How long to wait for the pane to reach the state we asked for, and how often
// to re-read while waiting.
//
// A single fixed sleep was not enough, and prod verify is what caught it: at
// 450ms /api/model/open returned not_a_picker against a session whose picker
// was in fact on screen. The reason is dialog-watch's cheap gate — it only
// captures a pane when Claude Code's ~/.claude/sessions/<pid>.json says
// status "waiting", and that file has its own update cadence. Land the check
// before the file flips and the watcher reports no dialog at all. Polling
// removes the guess: we ask repeatedly until the pane agrees or we give up.
const SETTLE_TIMEOUT_MS = 3_000
const SETTLE_POLL_MS = 250
const KEY_GAP_MS = 40        // same gap /api/dialog/pick uses between keys

// One flow per session at a time. Two phones (or a phone and a retry) driving
// one picker would interleave arrow keys and land on the wrong row — the keys
// are relative to wherever the cursor currently sits.
const inFlight = new Set<string>()

function sendKey(pane: SessionPane, key: string): Promise<boolean> {
  // A named key goes as-is; a single character goes literal, so "s" is typed
  // rather than interpreted. Same split as /api/dialog/key. Both ride the
  // shared per-pane gate (lib/key-gate.ts): /api/model/cancel's Escape holds
  // off every other sender for its chord window, and a cancel arriving just
  // after a phone's Escape waits its turn too.
  const named = /^(Enter|Escape|Up|Down|Left|Right|Tab|Space)$/.test(key)
  return named ? pane.key(key) : pane.literal(key)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Re-read one session's pane until the model picker is present (want=true) or
// gone (want=false), or the timeout runs out. Returns whatever the last read
// saw, so callers report the real state rather than assuming the wait worked.
async function settle(key: string, want: boolean): Promise<Dialog | undefined> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  for (;;) {
    await dialogWatcher.refresh(key)
    const dialog = dialogWatcher.current()[key]
    if (isModelPicker(dialog) === want) return dialog
    if (Date.now() >= deadline) return dialog
    await sleep(SETTLE_POLL_MS)
  }
}

function log(msg: string): void {
  const reset = "\x1b[0m"; const cyan = "\x1b[36m"
  companionLog(`${cyan}model${reset} ${msg}`)
}

export async function handleModelRoute(req: Request, url: URL): Promise<Response | null> {
  // ── Open the picker and return the real model list ──
  // Body: { key }. The list is never cached and never hardcoded: it is
  // whatever Claude Code shows for this account right now (gap-table A3).
  if (url.pathname === "/api/model/open" && req.method === "POST") {
    const body = checked(await jsonObject<{ key?: string }>(req, {}), { key: "string" })
    const key = (body.key ?? "").trim()
    const session = key ? resolveSession(key) : null
    if (key && !session) return Response.json({ ok: false, error: "target_gone" }, { status: 410 })

    if (session && isHeadlessSession(session)) {
      const choices = buildHeadlessChoices(session)
      log(`open (headless) → ${choices.length} models on ${session.label || session.key}`)
      return Response.json({
        ok: true,
        key: session.key,
        choices,
        hints: [
          { key: "Enter", label: "to set as default" },
          { key: "s", label: "to use this session only" },
        ],
      })
    }

    const refusal = openRefusal(session, dialogWatcher.current()[session?.key ?? ""])
    if (refusal) {
      log(`open refused — ${refusal.error} (${session?.label || session?.key || key})`)
      return Response.json({ ok: false, ...refusal }, { status: 409 })
    }
    const pane = sessionPaneOf(session)!

    if (inFlight.has(session!.key)) {
      return Response.json({ ok: false, error: "busy_flow" }, { status: 409 })
    }
    inFlight.add(session!.key)
    try {
      // Already open (the user opened it, or a previous call left it up):
      // don't send /model again, that would type into the picker. Read the
      // pane now rather than trust the watcher's last tick (up to 2 s old):
      // "/model" + Enter typed into a picker that IS open confirms its
      // cursor row and saves it as the default for new sessions.
      await dialogWatcher.refresh(session!.key)
      let dialog = dialogWatcher.current()[session!.key]
      if (dialog && !isModelPicker(dialog)) {
        log(`open refused — other_dialog (${session!.label || session!.key})`)
        return Response.json({ ok: false, error: "other_dialog" }, { status: 409 })
      }
      if (!isModelPicker(dialog)) {
        await sendKey(pane, "/model")  // literal, then Enter
        await sendKey(pane, "Enter")
        dialog = await settle(session!.key, true)
      }
      if (!isModelPicker(dialog)) {
        log(`open failed — no picker on ${session!.label || session!.key}`)
        return Response.json({ ok: false, error: "not_a_picker" }, { status: 409 })
      }
      const choices = choicesFrom(dialog!)
      log(`open → ${choices.length} models on ${session!.label || session!.key}`)
      return Response.json({ ok: true, key: session!.key, choices, hints: dialog!.hints })
    } finally {
      inFlight.delete(session!.key)
    }
  }

  // ── Pick a model ──
  // Body: { key, index, scope }. scope "session" confirms with the picker's
  // "s to use this session only" hint; "default" confirms with Enter, which
  // Claude Code also saves as the new-session default. That distinction is the
  // whole reason this drives the picker instead of sending `/model <id>`.
  if (url.pathname === "/api/model/set" && req.method === "POST") {
    const body = checked(await jsonObject<{ key?: string; index?: number; scope?: string }>(req, {}), { key: "string" })
    const key = (body.key ?? "").trim()
    const index = body.index
    const scope: ModelScope = body.scope === "session" ? "session" : "default"
    if (typeof index !== "number") return Response.json({ ok: false, error: "invalid-args" }, { status: 400 })

    const session = key ? resolveSession(key) : null
    if (session && isHeadlessSession(session)) {
      const catalog = headlessCatalogFor(session)
      if (index < 0 || index >= catalog.length) {
        return Response.json({ ok: false, error: "no_such_model" }, { status: 400 })
      }
      const picked = catalog[index]!
      if (session.taskId === "brain") {
        setBrainModel(picked.id)
      } else if (session.taskId) {
        workerSupervisor.setTaskModel(session.taskId, picked.id)
      }
      setSessionModel(session.key, picked.id)
      recordSession({ ...session, agent: picked.family, model: picked.id }, { sessionIdConfirmed: true })
      const chosen: ModelChoice = { index, text: picked.text, current: true }
      log(`set (headless) → "${picked.id}" scope=${scope} on ${session.label || session.key}`)
      return Response.json({ ok: true, key: session.key, scope, chosen })
    }

    const pane = sessionPaneOf(session)
    if (!session || !pane) return Response.json({ ok: false, error: "no_pane" }, { status: 410 })

    if (inFlight.has(session.key)) {
      return Response.json({ ok: false, error: "busy_flow" }, { status: 409 })
    }
    inFlight.add(session.key)
    try {
      // Re-read the pane rather than trusting the list the client was handed:
      // the user may have moved the cursor, or closed and reopened the picker,
      // since /open. The arrow count is relative to where the cursor IS.
      await dialogWatcher.refresh(session.key)
      const dialog = dialogWatcher.current()[session.key]
      if (!isModelPicker(dialog)) {
        log(`set refused — picker not open on ${session.label || session.key}`)
        return Response.json({ ok: false, error: "not_a_picker" }, { status: 409 })
      }

      const keys = setKeys(dialog!, index, scope)
      if (!Array.isArray(keys)) {
        return Response.json({ ok: false, ...keys }, { status: 400 })
      }
      const chosen = choicesFrom(dialog!)[index]
      for (const k of keys) {
        if (!await sendKey(pane, k)) {
          return Response.json({ ok: false, error: "send_failed" }, { status: 500 })
        }
        await sleep(KEY_GAP_MS)
      }
      // The picker should be gone now. If it is still up after the wait, the
      // confirm did not take — report that instead of claiming a set that did
      // not happen.
      const after = await settle(session.key, false)
      const settled = !isModelPicker(after)
      log(`set → "${chosen?.text ?? index}" scope=${scope} on ${session.label || session.key}${settled ? "" : " (picker still open)"}`)
      return Response.json({
        ok: settled,
        error: settled ? undefined : "not_settled",
        key: session.key,
        scope,
        chosen: chosen ?? null,
        // What the pane shows now. The session's `model` field only catches up
        // on the next answered turn, so this is the immediate confirmation.
        dialog: settled ? undefined : after,
      }, { status: settled ? 200 : 409 })
    } finally {
      inFlight.delete(session.key)
    }
  }

  // ── Close the picker without choosing ──
  // The phone dismissing its sheet must not leave a modal on the pane: while
  // one is up, inject refuses (Phase 13) and the session looks stuck.
  if (url.pathname === "/api/model/cancel" && req.method === "POST") {
    const body = checked(await jsonObject<{ key?: string }>(req, {}), { key: "string" })
    const key = (body.key ?? "").trim()
    const session = key ? resolveSession(key) : null
    if (session && isHeadlessSession(session)) {
      return Response.json({ ok: true, closed: true })
    }

    const pane = sessionPaneOf(session)
    if (!session || !pane) return Response.json({ ok: false, error: "no_pane" }, { status: 410 })
    // Fresh read, same reason as open: a stale "no picker" would leave one up.
    await dialogWatcher.refresh(session.key)
    const dialog = dialogWatcher.current()[session.key]
    if (!isModelPicker(dialog)) return Response.json({ ok: true, closed: false })
    await sendKey(pane, "Escape")
    // Escape is a meta-chord prefix (ESC_SETTLE_MS, lib/command-list.ts): the
    // next byte inside this window is read as opt+<byte>, the Escape never
    // fires, and the picker the caller thinks it just closed is still up. The
    // settle also buys the redraw `settle()` is about to look for — a fixed
    // 40ms gap once reported closed:false on a cancel that had in fact worked.
    await sleep(ESC_SETTLE_MS)
    const after = await settle(session.key, false)
    log(`cancel on ${session.label || session.key}`)
    return Response.json({ ok: true, closed: !isModelPicker(after) })
  }

  return null
}
