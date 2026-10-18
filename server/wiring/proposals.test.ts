import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// reviseProposal (moved out of the resolver's live seams, 2026-10-15): the
// rescope path the resolver and the repo-card No share. It must still mark
// the new proposal as Opus-created (else the resolver re-resolves its own
// rescope). Real companion.db (isolated COMPANION_DB_PATH).

process.env.COMPANION_DB_PATH ??= join(mkdtempSync(join(tmpdir(), "cc-proposals-")), "companion.db")
const chat = await import("../lib/orchestrator-chat")
const channels = await import("../lib/orchestrator-channels")
const { reviseProposal } = await import("./proposals")
const threads: string[] = []
// The companion.db is shared with other test files in the run: leave no proposal pending.
afterAll(() => {
  for (const t of chat.listProposals()) if (threads.includes(t.threadId)) chat.setTaskStatus(t.taskId, "rejected")
})

describe("reviseProposal", () => {
  test("rejects the old proposal, files the rescoped one in the same thread, marks it created, posts the turn", () => {
    const thread = channels.createChannel("proposals-revise-test").id
    threads.push(thread)
    const old = chat.createProposal("Build the whole export suite", "/tmp/x", "asked", thread, { noteId: "projects/dash", agent: "builder", title: "Export suite" })
    const marked: string[] = []
    const id = reviseProposal(old.taskId, { title: "CSV only", prompt: "Add a CSV-only export", why: "smaller first" }, (taskId) => { marked.push(taskId) })
    expect(id).not.toBeNull()
    expect(chat.getTask(old.taskId)!.status).toBe("rejected")
    const next = chat.getTask(id!)!
    expect(next).toMatchObject({ status: "proposed", prompt: "Add a CSV-only export", title: "CSV only", cwd: "/tmp/x", threadId: thread, noteId: "projects/dash", agent: "builder" })
    expect(next.reasoning).toBe(`Opus rescoped [${old.taskId}]: smaller first`)
    expect(marked).toEqual([id!])
    expect(chat.getThread(thread).some((t) => t.text.startsWith(`🤖 Opus rescoped [${old.taskId}] → proposal [${id}]: CSV only`))).toBe(true)
  })

  test("a rescope keeps the old title's [repo:<name>] routing marker", () => {
    const thread = channels.createChannel("proposals-revise-marker").id
    threads.push(thread)
    const old = chat.createProposal("Fix it", "/tmp/x", "body", thread, { noteId: "projects/o", agent: "builder", title: "[repo:tls-dashboard-v2] Fix mac:launchd:x: restore it" })
    const id = reviseProposal(old.taskId, { title: "Restore only the plist", prompt: "Restore the plist", why: "smaller" }, () => {})
    expect(chat.getTask(id!)!.title).toBe("[repo:tls-dashboard-v2] Restore only the plist")
    const again = reviseProposal(id!, { title: "[repo:claude-config] Move it", prompt: "Move it", why: "other repo" }, () => {})
    expect(chat.getTask(again!)!.title).toBe("[repo:claude-config] Move it")
  })

  test("a proposal that already moved (or is unknown) is not revised and nothing is marked", () => {
    const thread = channels.createChannel("proposals-revise-moved").id
    threads.push(thread)
    const old = chat.createProposal("Do X", "", "asked", thread)
    chat.setTaskStatus(old.taskId, "rejected")
    const marked: string[] = []
    expect(reviseProposal(old.taskId, { title: "Y", prompt: "Do Y", why: "w" }, (taskId) => { marked.push(taskId) })).toBeNull()
    expect(reviseProposal("nope", { title: "Y", prompt: "Do Y", why: "w" }, (taskId) => { marked.push(taskId) })).toBeNull()
    expect(marked).toEqual([])
  })
})
