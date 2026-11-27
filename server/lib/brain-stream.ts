import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { agyFullTranscriptPath, agyTranscriptPath } from "./agy-feed"
import { BRAIN_THREAD, QUIET_REPLY } from "./brain"
import type { Turn } from "./orchestrator-chat"
import { readTailLines } from "./transcript-cursor"
import { defaultKillPid } from "./worker-pid"
import type { SpawnWorkerOpts, SpawnedWorkerHandle } from "./worker-spawn"

export interface SpawnedPersistentWorkerHandle extends SpawnedWorkerHandle {
  writeLine(line: string): boolean
  closeInput(): void
}

export function defaultSpawnPersistentWorker(opts: SpawnWorkerOpts): SpawnedPersistentWorkerHandle {
  const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true })
  let outBuf = "", errBuf = "", closed = false
  child.stdin?.on("error", () => { closed = true })
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    outBuf += chunk; const lines = outBuf.split("\n"); outBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStdoutLine(l)
  })
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    errBuf += chunk; const lines = errBuf.split("\n"); errBuf = lines.pop() ?? ""
    for (const l of lines) if (l.trim()) opts.onStderrLine(l)
  })
  child.on("error", (err) => { closed = true; opts.onStderrLine(err.message); opts.onExit(1, null) })
  child.on("close", (code, sig) => {
    closed = true
    if (outBuf.trim()) opts.onStdoutLine(outBuf)
    if (errBuf.trim()) opts.onStderrLine(errBuf)
    opts.onExit(code, sig)
  })
  return {
    pid: child.pid ?? 0,
    writeLine(line: string): boolean {
      if (closed || !child.stdin || child.stdin.destroyed || !child.stdin.writable) return false
      try { child.stdin.write(line.endsWith("\n") ? line : `${line}\n`, "utf8"); return true }
      catch { closed = true; return false }
    },
    closeInput() { closed = true; try { child.stdin?.end() } catch { /* ignore */ } },
    kill(sig: NodeJS.Signals) {
      closed = true; try { child.stdin?.destroy() } catch { /* ignore */ }
      if (child.pid) defaultKillPid(child.pid, sig)
    },
  }
}

// Live WebSocket delta streaming + stable draftTurnId reconciliation for the Brain thread.
// Every Brain turn mints one stable draftTurnId. Multi-block assistant text chunks (even with
// tool calls in between) accumulate under that single draftTurnId, reconcile in-place into the
// final persisted orchestrator_turns row on completion, or emit an explicit clear signal when
// the final reply is QUIET_REPLY ("noted") or the turn is preempted/interrupted.

export type BrainStreamOp = "delta" | "done" | "clear"
export type BrainStreamClearReason = "quiet_reply" | "preempted" | "interrupted"

export interface BrainStreamFrame {
  type: "brain_stream"
  op: BrainStreamOp
  threadId: typeof BRAIN_THREAD
  turnId: string
  draftTurnId: string
  delta: string
  text: string
  blockIndex: number
  streaming: boolean
  turn?: Turn
  reason?: BrainStreamClearReason
}

export class BrainTurnAccumulator {
  readonly draftTurnId: string
  private blocks: string[] = []
  private afterTool = false
  private streamed = false

  constructor(draftTurnId: string = randomUUID()) {
    this.draftTurnId = draftTurnId
  }

  hasStreamed(): boolean {
    return this.streamed
  }

  currentText(): string {
    return this.blocks.join("\n\n")
  }

  currentBlockIndex(): number {
    return Math.max(0, this.blocks.length - 1)
  }

  /** Mark a tool call boundary between assistant text blocks. */
  noteTool(): void {
    if (this.blocks.length > 0) this.afterTool = true
  }

  /** Reset accumulated blocks (e.g. if warm agy fails mid-turn before completion and falls back to one-shot). */
  resetBlocks(): void {
    this.blocks = []
    this.afterTool = false
  }

  /**
   * Append an incremental token delta (`isDelta: true`) or a full/partial step text block (`isDelta: false`).
   * Returns the delta chunk and full accumulated text across all blocks in this turn, or null if empty/unchanged.
   */
  pushText(rawChunk: string, isDelta = false): { delta: string; text: string; blockIndex: number } | null {
    if (!rawChunk) return null
    if (isDelta) {
      if (this.blocks.length === 0 || this.afterTool) {
        const cleaned = this.blocks.length > 0 ? rawChunk.replace(/^\n+/, "") : rawChunk
        if (!cleaned) return null
        this.blocks.push(cleaned)
        this.afterTool = false
        this.streamed = true
        return {
          delta: this.blocks.length > 1 ? `\n\n${cleaned}` : cleaned,
          text: this.currentText(),
          blockIndex: this.blocks.length - 1,
        }
      }
      this.blocks[this.blocks.length - 1] += rawChunk
      this.streamed = true
      return {
        delta: rawChunk,
        text: this.currentText(),
        blockIndex: this.blocks.length - 1,
      }
    }

    const trimmed = rawChunk.trim()
    if (!trimmed) return null
    if (this.blocks.length === 0 || this.afterTool) {
      // Deduplicate identical trailing block if emitted twice
      if (!this.afterTool && this.blocks.at(-1) === trimmed) return null
      this.blocks.push(trimmed)
      this.afterTool = false
      this.streamed = true
      return {
        delta: this.blocks.length > 1 ? `\n\n${trimmed}` : trimmed,
        text: this.currentText(),
        blockIndex: this.blocks.length - 1,
      }
    }

    const prev = this.blocks[this.blocks.length - 1]!
    if (trimmed === prev) return null
    if (trimmed.startsWith(prev)) {
      const suffix = trimmed.slice(prev.length)
      this.blocks[this.blocks.length - 1] = trimmed
      this.streamed = true
      return {
        delta: suffix,
        text: this.currentText(),
        blockIndex: this.blocks.length - 1,
      }
    }

    // Distinct new block emitted without an intervening tool event
    this.blocks.push(trimmed)
    this.streamed = true
    return {
      delta: `\n\n${trimmed}`,
      text: this.currentText(),
      blockIndex: this.blocks.length - 1,
    }
  }

  /**
   * Compute the final turn text when the turn completes.
   * If the final block or resultText is QUIET_REPLY ("noted"), returns QUIET_REPLY so the turn is suppressed and cleared.
   * If multiple text blocks were streamed across tool calls and resultText only repeated the final block (or was empty),
   * preserves the full multi-block text so the reconciled bubble never loses earlier blocks.
   */
  finalReply(resultText?: string): string {
    const res = (resultText ?? "").trim()
    const lastBlock = (this.blocks.at(-1) ?? "").trim()
    if (res.toLowerCase() === QUIET_REPLY || (!res && lastBlock.toLowerCase() === QUIET_REPLY)) {
      return QUIET_REPLY
    }
    if (this.blocks.length > 1) {
      const joined = this.currentText().trim()
      if (!res || res === lastBlock || joined.endsWith(res)) return joined
    }
    return res || this.currentText().trim()
  }
}

export function buildBrainDeltaFrame(input: {
  draftTurnId: string
  delta: string
  text: string
  blockIndex: number
}): BrainStreamFrame {
  return {
    type: "brain_stream",
    op: "delta",
    threadId: BRAIN_THREAD,
    turnId: input.draftTurnId,
    draftTurnId: input.draftTurnId,
    delta: input.delta,
    text: input.text,
    blockIndex: input.blockIndex,
    streaming: true,
  }
}

export function buildBrainDoneFrame(draftTurnId: string, turn: Turn, blockIndex = 0): BrainStreamFrame {
  return {
    type: "brain_stream",
    op: "done",
    threadId: BRAIN_THREAD,
    turnId: turn.id,
    draftTurnId,
    delta: "",
    text: turn.text,
    blockIndex,
    streaming: false,
    turn,
  }
}

export function buildBrainClearFrame(
  draftTurnId: string,
  reason: BrainStreamClearReason = "quiet_reply",
  blockIndex = 0,
): BrainStreamFrame {
  return {
    type: "brain_stream",
    op: "clear",
    threadId: BRAIN_THREAD,
    turnId: draftTurnId,
    draftTurnId,
    delta: "",
    text: "",
    blockIndex,
    streaming: false,
    reason,
  }
}

/**
 * Pure client/thread state reducer for in-place `draftTurnId` reconciliation.
 * Handles `brain_stream` (`delta` | `done` | `clear`) and `orchestrator` turn frames:
 * - Updates a single in-progress bubble across multiple text blocks and interleaved tool calls.
 * - Swaps/reconciles `draftTurnId` in-place into the final persisted `Turn` row on `done` / `orchestrator` without duplicating.
 * - Removes the draft bubble cleanly on `clear` (e.g. `QUIET_REPLY` `"noted"` or preempted turn).
 */
export function reconcileBrainStream(
  turns: readonly Turn[],
  frame: Record<string, unknown>,
  now = Date.now(),
): Turn[] {
  if (frame.type === "brain_stream") {
    const op = frame.op as BrainStreamOp | undefined
    const draftId = typeof frame.draftTurnId === "string" ? frame.draftTurnId : typeof frame.turnId === "string" ? frame.turnId : ""
    if (!draftId) return [...turns]

    if (op === "clear") {
      return turns.filter((t) => t.id !== draftId && (t as Turn & { draftTurnId?: string }).draftTurnId !== draftId)
    }

    if (op === "delta") {
      const text = typeof frame.text === "string" ? frame.text : typeof frame.delta === "string" ? frame.delta : ""
      if (!text) return [...turns]
      const idx = turns.findIndex((t) => t.id === draftId || (t as Turn & { draftTurnId?: string }).draftTurnId === draftId)
      if (idx >= 0) {
        const next = [...turns]
        next[idx] = { ...next[idx]!, text }
        return next
      }
      return [
        ...turns,
        {
          id: draftId,
          threadId: BRAIN_THREAD,
          role: "orchestrator",
          text,
          taskId: null,
          createdAt: now,
        },
      ]
    }

    if (op === "done") {
      const finalTurn = frame.turn && typeof frame.turn === "object" ? (frame.turn as Turn) : null
      if (!finalTurn) return [...turns]
      if (finalTurn.text.trim().toLowerCase() === QUIET_REPLY) {
        return turns.filter((t) => t.id !== draftId && t.id !== finalTurn.id)
      }
      const idx = turns.findIndex(
        (t) => t.id === draftId || t.id === finalTurn.id || (t as Turn & { draftTurnId?: string }).draftTurnId === draftId,
      )
      if (idx >= 0) {
        const next = [...turns]
        next[idx] = finalTurn
        return next.filter((t, i) => i === idx || (t.id !== finalTurn.id && t.id !== draftId))
      }
      return [...turns, finalTurn]
    }
  }

  if (frame.type === "orchestrator" && frame.turn && typeof frame.turn === "object") {
    const turn = frame.turn as Turn & { draftTurnId?: string }
    const draftId = typeof frame.draftTurnId === "string"
      ? frame.draftTurnId
      : typeof turn.draftTurnId === "string"
      ? turn.draftTurnId
      : turn.id
    if (turn.text.trim().toLowerCase() === QUIET_REPLY) {
      return turns.filter((t) => t.id !== draftId && t.id !== turn.id)
    }
    const idx = turns.findIndex(
      (t) => t.id === turn.id || t.id === draftId || (t as Turn & { draftTurnId?: string }).draftTurnId === draftId,
    )
    if (idx >= 0) {
      const next = [...turns]
      next[idx] = turn
      return next.filter((t, i) => i === idx || (t.id !== turn.id && t.id !== draftId))
    }
    return [...turns, turn]
  }

  return [...turns]
}

/** Extract tool call metadata from a Claude or Antigravity `stream-json` line for `noteActivity`. */
export function extractStreamToolCall(line: string): { phase: "pre" | "post"; tool: string; input: Record<string, unknown>; toolUseId: string } | undefined {
  try {
    const raw = JSON.parse(line) as {
      event?: string
      step_update?: { step_type?: string; state?: string; tool_name?: string; step_index?: number; tool_info?: { name?: string; parameters?: Record<string, unknown> } }
      message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown> }> }
    }
    const tu = Array.isArray(raw.message?.content) ? raw.message.content.find((b) => b?.type === "tool_use" && typeof b.name === "string") : undefined
    if (tu?.name) {
      return { phase: "pre", tool: tu.name, input: (tu.input && typeof tu.input === "object" ? tu.input : {}), toolUseId: tu.id || `tu_${Date.now()}` }
    }
    if (raw.event === "step_update" && raw.step_update?.step_type === "tool" && raw.step_update.state === "ACTIVE") {
      const tool = raw.step_update.tool_name || raw.step_update.tool_info?.name
      const params = raw.step_update.tool_info?.parameters
      if (typeof tool === "string" && tool) {
        return {
          phase: "pre",
          tool,
          input: (params && typeof params === "object" && !Array.isArray(params) ? params : {}),
          toolUseId: `agy_tu_${raw.step_update.step_index ?? Date.now()}`,
        }
      }
    }
  } catch { /* ignore */ }
  return undefined
}

/**
 * When `agy` emits `step_update` with `step_type === "agent_response"` and `state === "DONE"` without inline text,
 * read the corresponding `PLANNER_RESPONSE` step's `content` from `transcript.jsonl` (or `transcript_full.jsonl` if truncated).
 */
export function readAgyStepText(conversationId: string, stepIndex: number, home = process.env.HOME || homedir()): string | null {
  if (!conversationId || stepIndex < 0) return null
  const path = agyTranscriptPath(conversationId, home)
  if (!existsSync(path)) return null
  const extractStepText = (parsed: {
    step_index?: number
    type?: string
    content?: string
    planner_response?: { modified_response?: string; response?: string }
  }): string | undefined => {
    if (parsed.type === "PLANNER_RESPONSE" && typeof parsed.content === "string") return parsed.content
    if (parsed.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
      return parsed.planner_response?.modified_response ?? parsed.planner_response?.response
    }
    return undefined
  }
  const findStep = (file: string, maxBytes: number): { text?: string; truncated_fields?: string[] } | null => {
    if (!existsSync(file)) return null
    const lines = readTailLines(file, maxBytes)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line || !line.includes(`"step_index":${stepIndex}`)) continue
      try {
        const parsed = JSON.parse(line) as {
          step_index?: number
          type?: string
          content?: string
          planner_response?: { modified_response?: string; response?: string }
          truncated_fields?: string[]
        }
        const text = parsed.step_index === stepIndex ? extractStepText(parsed) : undefined
        if (typeof text === "string") return { text, truncated_fields: parsed.truncated_fields }
      } catch { /* ignore */ }
    }
    return null
  }
  let step = findStep(path, 256 * 1024)
  if (!step) return null
  if ((Array.isArray(step.truncated_fields) && step.truncated_fields.includes("content")) || (typeof step.text === "string" && step.text.includes("<truncated "))) {
    const full = findStep(agyFullTranscriptPath(conversationId, home), 1024 * 1024)
    if (full?.text) step = full
  }
  const text = typeof step.text === "string" ? step.text.trim() : ""
  return text || null
}
