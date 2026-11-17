import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agySummariesDbPath, agyThreadVisible, readRecentAgyConversations } from "./agy-feed"
import { createEndedStore } from "./ended-sessions"
import { type ArchivePolicy, archiveReason, archiveStaleSessions } from "./session-archive"
import { type Session, getSessionByKey, markHeadlessSession, recordSession, removeSessionByKey } from "./sessions"
import { workerAgentStatus } from "./worker-invocation"

const H = 60 * 60 * 1000
const NOW = Date.now()
const POLICY: ArchivePolicy = { idleMs: 24 * H, doneMs: H }
const neverDone = () => null

const keys: string[] = []
const dirs: string[] = []
afterEach(() => {
  for (const k of keys.splice(0)) removeSessionByKey(k)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function row(over: Partial<Session>): Session {
  return {
    key: "claude:sid:x", agent: "claude", label: "", title: "", sidConfirmed: true, agentStatus: "idle", waitingFor: "",
    cwd: "/w", sessionId: "x", termProgram: "", tty: "", iTermSessionId: "", tmuxPane: "", taskId: "",
    waitingSince: 0, waitingKind: "", waitingRef: "", waitingReasons: [], pid: "", model: "",
    firstSeenAt: NOW - 48 * H, lastSeenAt: NOW, lastActiveAt: NOW - 30 * H, ...over,
  }
}

describe("archiveReason", () => {
  test("idle past the window → idle; recent activity, busy or waiting → kept", () => {
    expect(archiveReason(row({}), NOW, POLICY, neverDone)).toBe("idle")
    expect(archiveReason(row({ lastActiveAt: NOW - 2 * H }), NOW, POLICY, neverDone)).toBeNull()
    expect(archiveReason(row({ agentStatus: "busy" }), NOW, POLICY, neverDone)).toBeNull()
    expect(archiveReason(row({ waitingSince: NOW - 30 * H }), NOW, POLICY, neverDone)).toBeNull()
  })

  test("a session started in the last 24 h is never archived, even with a shorter idle window", () => {
    const s = row({ firstSeenAt: NOW - 20 * H, lastActiveAt: NOW - 20 * H })
    expect(archiveReason(s, NOW, { idleMs: 6 * H, doneMs: H }, neverDone)).toBeNull()
  })

  test("Brain, Brain · Boost and leads are pinned", () => {
    for (const taskId of ["brain", "agy-brain", "lead:claude-companion"]) {
      expect(archiveReason(row({ taskId, lastActiveAt: 0 }), NOW, POLICY, neverDone)).toBeNull()
    }
  })

  test("a worker card stays while its task runs, leaves an hour after it finished", () => {
    const w = row({ taskId: "t1", herdrPane: "headless:worker:t1", firstSeenAt: NOW, lastActiveAt: NOW })
    expect(archiveReason(w, NOW, POLICY, () => null)).toBeNull()
    expect(archiveReason(w, NOW, POLICY, () => NOW - 30 * 60_000)).toBeNull()
    expect(archiveReason(w, NOW, POLICY, () => NOW - 2 * H)).toBe("done")
  })
})

test("worker status follows its task: only running reads as working", () => {
  expect(workerAgentStatus("running")).toBe("busy")
  for (const s of ["completed", "failed", "interrupted"] as const) expect(workerAgentStatus(s)).toBe("idle")
})

describe("archiveStaleSessions", () => {
  test("an ended (interactive) row keeps its day; past it, it leaves", async () => {
    const ended = createEndedStore({ herdr: { call: async () => ({ pane: { terminal_id: "t" } }) } as never, now: () => NOW - 2 * H })
    await ended.note({ sessionId: "33333333-3333-3333-3333-333333333333", sidConfirmed: true, agent: "claude", title: "", label: "", cwd: "/w", herdrPane: "w1:p1" }, () => [])
    expect(ended.list()).toHaveLength(1)
    archiveStaleSessions(neverDone, POLICY, NOW, ended)
    expect(ended.list()).toHaveLength(1)
    archiveStaleSessions(neverDone, POLICY, NOW + 23 * H, ended)
    expect(ended.list()).toHaveLength(0)
  })

  test("archived rows stay out on a provisional re-record; new activity or a hook brings them back", () => {
    const meta = { cwd: "/tmp/archive-test", agent: "gemini" as const, sessionId: "arch-1", herdrPane: "headless:agy:arch-1", firstSeenAt: NOW - 48 * H, lastActiveAt: NOW - 30 * H }
    const s = recordSession(meta, { provisional: true })!
    keys.push(s.key)
    const ended = createEndedStore()
    expect(archiveStaleSessions(neverDone, POLICY, NOW, ended)).toBeGreaterThanOrEqual(1)
    expect(getSessionByKey(s.key)).toBeNull()

    expect(recordSession(meta, { provisional: true })).toBeNull() // the discovery tick
    expect(getSessionByKey(s.key)).toBeNull()
    expect(recordSession({ ...meta, lastActiveAt: NOW }, { provisional: true })).not.toBeNull() // agy wrote a new turn
    archiveStaleSessions(neverDone, { idleMs: 0, doneMs: H }, NOW + 25 * H, ended)
    expect(getSessionByKey(s.key)).toBeNull()
    expect(recordSession({ ...meta }, {})).not.toBeNull() // a hook
  })
})

describe("agy print-mode conversations", () => {
  function home(): string {
    const h = mkdtempSync(join(tmpdir(), "agy-archive-"))
    dirs.push(h)
    mkdirSync(join(h, ".gemini", "antigravity-cli"), { recursive: true })
    const db = new Database(agySummariesDbPath(h))
    db.exec(`CREATE TABLE conversation_summaries (conversation_id text, title text, step_count integer, last_modified_time text,
      workspace_uris text, status text, not_fully_idle numeric, killed numeric, last_user_input_step_index integer)`)
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "+00:00")
    const ins = db.prepare("INSERT INTO conversation_summaries VALUES (?, ?, 3, ?, '[\"file:///w\"]', 'CASCADE_RUN_STATUS_IDLE', 0, 0, ?)")
    ins.run("11111111-1111-1111-1111-111111111111", "IMPORTANT: Ignore any files", ts, -1)
    ins.run("22222222-2222-2222-2222-222222222222", "Interactive chat", ts, 7)
    db.close()
    return h
  }

  test("last_user_input_step_index -1 reads as headless", () => {
    const byId = new Map(readRecentAgyConversations(home()).map((c) => [c.id, c.headless]))
    expect(byId.get("11111111-1111-1111-1111-111111111111")).toBe(true)
    expect(byId.get("22222222-2222-2222-2222-222222222222")).toBe(false)
  })

  test("a print-mode conversation is no thread unless the phone opened it; a worker's is never re-keyed", () => {
    expect(agyThreadVisible({ id: "a", headless: true }, undefined)).toBe(false)
    expect(agyThreadVisible({ id: "a", headless: false }, undefined)).toBe(true)
    expect(agyThreadVisible({ id: "a", headless: true }, { herdrPane: "headless:agy:abc" })).toBe(true)
    expect(agyThreadVisible({ id: "a", headless: false }, { herdrPane: "headless:worker:t1" })).toBe(false)
    expect(agyThreadVisible({ id: "a", headless: true }, { herdrPane: "headless:worker:t1" })).toBe(false)
  })

  test("a worker task's conversation stays out after its card is gone, even with user-input steps (resumed)", () => {
    markHeadlessSession("resumed-worker-convo")
    expect(agyThreadVisible({ id: "resumed-worker-convo", headless: false }, undefined)).toBe(false)
  })
})
