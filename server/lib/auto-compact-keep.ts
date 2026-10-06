// Task boundaries + state-aware keep for lib/auto-compact.ts.
//
// SessionScan walks a session transcript once (incrementally, fed by the same
// chunked scan as BackgroundScan) and remembers what this session DID to
// durable state: PRs it touched (`gh pr …`), Turso notes / tasks it wrote,
// tasks it completed, PRs it merged, and the last human prompts. From that:
//   - closedSince(): did a unit of work just close (PR merged, task completed,
//     or a short closing prompt like "nice" / "merci")? → the boundary trigger;
//   - snapshot(): the raw pointers the wiring resolves against gh / Turso /
//     STATE.md, then buildKeep() turns into a one-line `/compact keep: …`.
// Pure; no I/O.

import {
  type Entry, blockText, contentBlocks, entryTime, humanPromptText, isBoundary,
} from "./auto-compact-transcript"

export const COMPACT_TEXT = "/compact keep: current task, open PRs/branches, decisions made, next steps"
export const KEEP_MAX = 1500

export type UnitReason = "pr_merged" | "task_completed" | "closing_prompt"

// ── closing prompt ────────────────────────────────────────────────────────

// Every word must be one of these (so "ok fix it" is not closing).
const CLOSING_WORDS = new Set([
  "nice", "perf", "parfait", "good", "great", "dope", "merci", "ok", "okay", "k",
  "thanks", "thx", "ty", "cool", "super", "top", "bravo", "beau", "job", "work", "one", "done",
])

export function isClosingPrompt(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean)
  return words.length > 0 && words.length <= 3 && words.every((w) => CLOSING_WORDS.has(w))
}

// ── transcript patterns (shapes from real Zettlab sessions, 2026-10) ──────

const GH_PR_RE = /\bgh\s+pr\s+(create|view|merge|close|reopen|edit|checks|ready|comment|diff|review)\b([^;&|\n]*)/g
const PR_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const PR_ARG_NUM_RE = /(?:^|\s)#?(\d{1,6})(?=\s|$)/
const STATE_JSON_RE = /"state"\s*:\s*"(OPEN|MERGED|CLOSED)"/
const STATE_WORD_RE = /\b(MERGED|CLOSED)\b/
const GH_FAIL_RE = /not mergeable|could not|failed|GraphQL:|no pull requests found/i
// dispatch.sh prints "dispatch.sh: <id> → completed"; direct SQL sets done=1.
const TASK_DONE_RESULT_RE = /dispatch\.sh: [0-9a-f]{6,} → completed/
const TASK_DONE_CMD_RE = /UPDATE\s+tasks\s+SET\b[^;]*?\bdone\s*=\s*1\b|\/api\/task\b[\s\S]*"done"\s*:\s*true/i
const NOTE_WRITE_RE = /\b(?:UPDATE\s+(?:notes|tasks)|(?:INSERT|REPLACE)[\w\s]*?INTO\s+(?:notes|tasks))\b|\/api\/(?:note|task)\b|file-dev-task\.sh|dispatch\.sh\s+[0-9a-f]/i
// Note ids as written in SQL args / API bodies — not a vault file path.
const NOTE_ID_RE = /(?<![\w/~.-])(?:(?:projects|resources|areas|clients)\/[\w.-]+|build-artifacts\/[\w.-]+\/[\w.-]+)/g
const REF_CODE_RE = /\b(?!CVE-|GHS)[A-Z]{3}-[A-Z0-9]{4}\b/g

export interface KeepPr { number: number; repo: string; state: string }
export interface SessionSnapshot { prs: KeepPr[]; noteIds: string[]; refCodes: string[] }

interface ToolCall { cmd: string }

// Recently-touched order: re-inserting moves a key to the end.
function touch<V>(m: Map<string, V>, k: string, v: V): void {
  m.delete(k)
  m.set(k, v)
}

export class SessionScan {
  private calls = new Map<string, ToolCall>()
  private prs = new Map<string, KeepPr>() // key = PR number (ponytail: two repos' same number collide; key by repo#n if that bites)
  private noteIds = new Map<string, true>()
  private refCodes = new Map<string, true>()
  private lastEvent: { at: number; kind: UnitReason } | null = null
  private workPromptAt = 0 // last non-closing human prompt
  private closingPromptAt = 0 // last human prompt, when it was a closing one
  private compactAt = 0

  feed(entries: Entry[], seenAt: number): void {
    for (const e of entries) {
      const t = entryTime(e)
      const at = Number.isFinite(t) ? t : seenAt
      if (isBoundary(e)) { this.compactAt = at; continue }
      if (e.isSidechain === true) continue
      const prompt = humanPromptText(e)
      if (prompt !== null) {
        if (isClosingPrompt(prompt)) this.closingPromptAt = at
        else { this.workPromptAt = at; this.closingPromptAt = 0 }
      }
      for (const b of contentBlocks(e)) this.block(b, at)
    }
  }

  // What closed the current unit of work after `since` (ms): a closing prompt
  // that is the latest prompt, else a merge / task completion after the last
  // real prompt and the last compaction. null = nothing closed.
  closedSince(since: number): UnitReason | null {
    const floor = Math.max(since, this.compactAt)
    if (this.closingPromptAt > floor) return "closing_prompt"
    const ev = this.lastEvent
    return ev && ev.at > Math.max(floor, this.workPromptAt) ? ev.kind : null
  }

  snapshot(): SessionSnapshot {
    return {
      prs: [...this.prs.values()].reverse().map((p) => ({ ...p })),
      noteIds: [...this.noteIds.keys()].reverse(),
      refCodes: [...this.refCodes.keys()].reverse(),
    }
  }

  private block(b: Entry, at: number): void {
    if (b.type === "tool_use" && typeof b.id === "string") {
      const cmd = (b.input as Entry | undefined)?.command
      if (b.name === "Bash" && typeof cmd === "string") this.calls.set(b.id, { cmd })
      return
    }
    if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") return
    const call = this.calls.get(b.tool_use_id)
    if (!call) return
    this.calls.delete(b.tool_use_id)
    if (b.is_error === true) return
    this.result(call.cmd, blockText(b), at)
  }

  private result(cmd: string, out: string, at: number): void {
    this.prResult(cmd, out, at)
    if (TASK_DONE_RESULT_RE.test(out) || TASK_DONE_CMD_RE.test(cmd)) this.lastEvent = { at, kind: "task_completed" }
    if (NOTE_WRITE_RE.test(cmd)) {
      for (const m of cmd.matchAll(NOTE_ID_RE)) touch(this.noteIds, m[0].replace(/\.md$/, ""), true)
      const refs = new Set([...cmd.matchAll(REF_CODE_RE)].map((m) => m[0]))
      const outRefs = new Set([...out.matchAll(REF_CODE_RE)].map((m) => m[0]))
      if (outRefs.size <= 2) for (const r of outRefs) refs.add(r) // a listing is not "this session wrote it"
      for (const r of refs) touch(this.refCodes, r, true)
    }
  }

  private prResult(cmd: string, out: string, at: number): void {
    const failed = GH_FAIL_RE.test(out)
    const explicit = out.match(STATE_JSON_RE)?.[1] ?? out.match(STATE_WORD_RE)?.[1]
    for (const m of cmd.matchAll(GH_PR_RE)) {
      const verb = m[1]!
      const args = m[2] ?? ""
      const refs: Array<{ number: number; repo: string }> = []
      for (const u of `${args} ${verb === "create" ? out : ""}`.matchAll(PR_URL_RE)) refs.push({ repo: u[1]!, number: Number(u[2]) })
      const n = refs.length ? null : args.match(PR_ARG_NUM_RE)?.[1]
      if (n) {
        // `gh pr view 14 --json url` names the repo in its output.
        const url = [...out.matchAll(PR_URL_RE)].find((u) => u[2] === n)
        refs.push({ repo: url?.[1] ?? "", number: Number(n) })
      }
      for (const r of refs) {
        const prior = this.prs.get(String(r.number))
        let state = explicit ?? prior?.state ?? "OPEN"
        if (!explicit && !failed && verb === "merge") state = "MERGED"
        if (!explicit && !failed && verb === "close") state = "CLOSED"
        if (state === "MERGED" && prior?.state !== "MERGED") this.lastEvent = { at, kind: "pr_merged" }
        touch(this.prs, String(r.number), { number: r.number, repo: r.repo || prior?.repo || "", state })
      }
    }
  }
}

// ── STATE.md ──────────────────────────────────────────────────────────────

// "Next" lines of a STATE.md: the body of any heading naming next / resume
// (e.g. "## 📌 Resume here (next session)") plus any "Next: …" line.
export function stateNextLines(md: string, max = 5): string[] {
  const out: string[] = []
  let level = 0 // >0 while inside a "next" section of that heading level
  for (const raw of md.split("\n")) {
    const h = raw.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      if (level && h[1]!.length <= level) level = 0
      if (/\bnext\b|resume here/i.test(h[2]!)) level = h[1]!.length
      continue
    }
    const line = raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim()
    if (!line) continue
    if (level || /^\**next(?: steps?)?\**\s*:/i.test(line)) out.push(line.slice(0, 200))
    if (out.length >= max) break
  }
  return out
}

// ── keep text ─────────────────────────────────────────────────────────────

export interface KeepNote { id: string; ref: string; openTasks: string[] }
export interface KeepState { prs: KeepPr[]; notes: KeepNote[]; next: string[]; human: string[] }

const oneLine = (s: string, max: number): string => {
  // Typed into a tmux pane: strip control chars (ESC, ^C…) after the collapse.
  const t = s.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// One line (the inject submits on newline), ≤ max chars. Nothing durable →
// the generic COMPACT_TEXT.
export function buildKeep(s: KeepState | null, max = KEEP_MAX): string {
  if (!s || (!s.prs.length && !s.notes.length && !s.next.length && !s.human.length)) return COMPACT_TEXT
  const parts = ["current task, decisions made"]
  if (s.prs.length) {
    const prs = [...s.prs].sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN")).slice(0, 6)
    parts.push(`PRs: ${prs.map((p) => `${p.repo}#${p.number} ${p.state}`).join(", ")}`)
  }
  for (const n of s.notes.slice(0, 4)) {
    const name = [n.id, n.ref && `(${n.ref})`].filter(Boolean).join(" ")
    const tasks = n.openTasks.slice(0, 5).map((t) => oneLine(t, 80))
    parts.push(`Turso note ${name}${tasks.length ? ` open tasks: ${tasks.join(" | ")}` : ""}`)
  }
  if (s.next.length) parts.push(`STATE.md next: ${s.next.slice(0, 5).map((l) => oneLine(l, 160)).join(" | ")}`)
  if (s.human.length) parts.push(`pending human steps: ${s.human.slice(0, 5).map((l) => oneLine(l, 100)).join(" | ")}`)
  return oneLine(`/compact keep: ${parts.join("; ")}`, max)
}
