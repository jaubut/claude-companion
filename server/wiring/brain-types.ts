import type { BrainActivity, BrainState } from "../lib/brain"
import type { ApnsPayload } from "../lib/apns"
import type { Session } from "../lib/sessions"
import type { SpawnResult } from "../lib/spawn-session"
import type { DispatchWiring } from "./dispatch"

export interface BrainStatus { state: BrainState; sessionKey: string | null; since: number; restarts: number; host: string; activity: BrainActivity | null }

export interface ProposeInput { title: string; prompt: string; noteId: string; agent: string | null; reasoning: string; sourceTurnId: string }

export interface BrainDeps {
  now(): number
  alive(): Promise<boolean>
  /** herdr's `brain` agent pane ("" when absent): what to adopt after a Companion restart. */
  agentPane(): Promise<string>
  /** Start the brain: resume that conversation (claude --resume), or a fresh one when null. */
  spawn(resume: string | null): Promise<SpawnResult>
  stopAgent(): Promise<void>
  sessions(): Session[]
  sessionByKey(key: string): Session | null
  /** Set taskId "brain" on a session found in the spawned pane. */
  tagBrain(key: string): boolean
  deliver(text: string, key: string): Promise<Response>
  /** Claude Code's own status for the session ("busy" | "waiting" | "idle" | ""). */
  agentStatus(key: string): Promise<string>
  /** The text the brain wrote after its last prompt, read from its transcript ("" when none). */
  lastReply(s: Session): Promise<string>
  /** Esc into the brain's pane: cancels a running /compact. */
  interrupt(key: string): Promise<void>
  broadcast(frame: Record<string, unknown>): void
  push(payload: ApnsPayload): void
  paused: { read(): boolean; write(on: boolean): void }
  contextPct(key: string): number | null
  compact(key: string, text: string): Promise<boolean>
  dispatch: DispatchWiring
  host: string
  log(msg: string): void
}
