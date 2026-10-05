// Transcript parsing for lib/auto-compact.ts: Claude Code session JSONL →
// context size, compact boundaries, open background tasks, last human prompt.
// Pure functions over parsed entries; no I/O.

// A background launch older than this no longer blocks (its end may have left
// no trace we recognise).
export const BG_MAX_AGE_MS = 2 * 60 * 60_000

export type Entry = Record<string, unknown>

export function parseLines(text: string): Entry[] {
  const out: Entry[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as unknown
      if (e && typeof e === "object") out.push(e as Entry)
    } catch { /* partial / corrupt line */ }
  }
  return out
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

export function entryTime(e: Entry): number {
  const t = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN
  return Number.isFinite(t) ? t : NaN
}

export function isBoundary(e: Entry): boolean {
  return e.type === "system" && e.subtype === "compact_boundary"
}

function usageTotal(e: Entry): number {
  const msg = e.message as Entry | undefined
  const u = msg?.usage as Entry | undefined
  if (!u) return 0
  return num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens)
}

// Context size = the last main-chain assistant turn's prompt size. Sidechain
// (subagent) entries and synthetic zero-usage messages are skipped. Nothing
// after the latest compact_boundary → the post-compact size is unknown → null.
export function contextTokens(entries: Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (isBoundary(e)) return null
    if (e.type !== "assistant" || e.isSidechain === true) continue
    const total = usageTotal(e)
    if (total > 0) return total
  }
  return null
}

// True when `entries` alone settle contextTokens (a usage turn or a boundary
// is in the window) — the tail need not grow.
export function contextSettled(entries: Entry[]): boolean {
  return contextTokens(entries) !== null || entries.some(isBoundary)
}

export interface CompactBoundary {
  uuid: string
  timestamp: string
  preTokens: number
  postTokens: number
  trigger: string
}

export function compactBoundaries(entries: Entry[]): CompactBoundary[] {
  const out: CompactBoundary[] = []
  for (const e of entries) {
    if (!isBoundary(e)) continue
    const meta = (e.compactMetadata ?? {}) as Entry
    out.push({
      uuid: typeof e.uuid === "string" ? e.uuid : "",
      timestamp: typeof e.timestamp === "string" ? e.timestamp : "",
      preTokens: num(meta.preTokens),
      postTokens: num(meta.postTokens),
      trigger: typeof meta.trigger === "string" ? meta.trigger : "",
    })
  }
  return out
}

const NOTIFY_TOOL_USE_RE = /<task-notification>[\s\S]*?<tool-use-id>(toolu_[A-Za-z0-9_-]+)<\/tool-use-id>/g
const LAUNCH_ID_RE = /(?:with ID|agentId|task_id|shell_id)[:=]\s*"?([A-Za-z0-9_-]+)/i
const STOP_TOOL_RE = /^(KillShell|KillBash|TaskStop)$/
// Claude Code's success text: "Successfully stopped task: <id> (…)" /
// "Successfully killed shell: <id>".
const STOP_OK_RE = /\bsuccessfully (stopped|killed)\b/i

function contentBlocks(e: Entry): Entry[] {
  const c = (e.message as Entry | undefined)?.content
  return Array.isArray(c) ? (c as Entry[]) : []
}

function blockText(b: Entry): string {
  if (typeof b.text === "string") return b.text
  if (typeof b.content === "string") return b.content
  if (Array.isArray(b.content)) {
    return (b.content as Entry[]).map((x) => (typeof x.text === "string" ? x.text : "")).join("\n")
  }
  return ""
}

// Every string a <task-notification> can sit in: a queue-operation's
// content, a user message's string content or its text / tool_result blocks.
function entryTexts(e: Entry): string[] {
  const out: string[] = []
  if (typeof e.content === "string") out.push(e.content)
  const c = (e.message as Entry | undefined)?.content
  if (typeof c === "string") out.push(c)
  for (const b of contentBlocks(e)) out.push(blockText(b))
  return out
}

// Background work Claude launched in this session (Bash / Agent with
// run_in_background) that has not reported back. Only launches after the
// latest compact_boundary and younger than BG_MAX_AGE_MS count (a launch with
// no timestamp ages from when it was scanned). Done = a <task-notification>
// naming its tool_use id, or a KillShell / TaskStop / KillBash naming its task
// id whose result CONFIRMS the stop (not is_error, "Successfully
// stopped/killed"). Unknown shapes err towards "running" — the cost is a
// skipped compaction, never a compaction under a live agent.
//
// Incremental: feed() entries in file order, as many times as needed.
export class BackgroundScan {
  private launched = new Map<string, { taskId: string; at: number }>() // tool_use id → task id ("" until the result names it)
  private stopCalls = new Map<string, string>() // stop tool_use id → task id it targets
  private doneToolUse = new Set<string>()
  private stoppedTask = new Set<string>()

  feed(entries: Entry[], seenAt: number): void {
    for (const e of entries) {
      // Earlier history is summarised away and must not keep a task "open".
      if (isBoundary(e)) { this.reset(); continue }
      for (const t of entryTexts(e)) {
        if (t.includes("<task-notification>")) for (const m of t.matchAll(NOTIFY_TOOL_USE_RE)) this.doneToolUse.add(m[1]!)
      }
      if (e.isSidechain === true) continue
      const t = entryTime(e)
      const at = Number.isFinite(t) ? t : seenAt
      for (const b of contentBlocks(e)) this.block(b, at)
    }
  }

  open(now: number): string[] {
    const out: string[] = []
    for (const [toolUse, { taskId, at }] of this.launched) {
      if (now - at > BG_MAX_AGE_MS) continue
      if (this.doneToolUse.has(toolUse)) continue
      if (taskId && this.stoppedTask.has(taskId)) continue
      out.push(taskId || toolUse)
    }
    return out
  }

  private block(b: Entry, at: number): void {
    if (b.type === "tool_use" && typeof b.id === "string") {
      const input = (b.input ?? {}) as Entry
      if (input.run_in_background === true) this.launched.set(b.id, { taskId: "", at })
      if (STOP_TOOL_RE.test(typeof b.name === "string" ? b.name : "")) {
        const k = ["shell_id", "task_id", "bash_id", "id"].find((x) => typeof input[x] === "string")
        if (k) this.stopCalls.set(b.id, input[k] as string)
      }
    } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      const l = this.launched.get(b.tool_use_id)
      if (l) {
        const m = blockText(b).match(LAUNCH_ID_RE)
        if (m) l.taskId = m[1]!
      }
      const target = this.stopCalls.get(b.tool_use_id)
      if (target && b.is_error !== true && STOP_OK_RE.test(blockText(b))) this.stoppedTask.add(target)
    }
  }

  private reset(): void {
    this.launched.clear()
    this.stopCalls.clear()
    this.doneToolUse.clear()
    this.stoppedTask.clear()
  }
}

export function openBackgroundTasks(entries: Entry[], now: number): string[] {
  const scan = new BackgroundScan()
  scan.feed(entries, now)
  return scan.open(now)
}

function isHumanPrompt(e: Entry): boolean {
  if (e.type !== "user" || e.isSidechain === true || e.isMeta === true) return false
  const c = (e.message as Entry | undefined)?.content
  if (typeof c === "string") return !c.includes("<task-notification>")
  if (!Array.isArray(c)) return false
  return (c as Entry[]).some((b) => b.type === "text" && typeof b.text === "string" && !b.text.includes("<task-notification>"))
}

// Last human prompt's time (ms) — the idle-window fallback when the server
// restarted and missed the UserPromptSubmit hook. `fromStart` = the entries
// begin at the top of the file; otherwise a prompt-less tail window means the
// prompt predates it, so its first timestamp is a safe (late) bound.
export function lastHumanPromptAt(entries: Entry[], fromStart = true): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (!isHumanPrompt(e)) continue
    const t = entryTime(e)
    return Number.isFinite(t) ? t : 0
  }
  if (fromStart) return 0
  for (const e of entries) {
    const t = entryTime(e)
    if (Number.isFinite(t)) return t
  }
  return 0
}
