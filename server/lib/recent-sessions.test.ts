import { test, expect, beforeAll } from "bun:test"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Recent interactive sessions for the terminal's Recent list / Resume chip.

let mod: typeof import("./recent-sessions")

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "recent-")), "test.db")
  mod = await import("./recent-sessions")
})

const line = (o: Record<string, unknown>) => JSON.stringify(o)
const user = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: "user", message: { role: "user", content: text }, ...extra })

test("parseHead: cwd, entrypoint and the first prompt worth a title; a cut last line is dropped", () => {
  const text = [
    line({ type: "summary" }),
    user("/clear", { cwd: "/Users/j/repo", entrypoint: "cli" }),
    user("add terminal sessions to the app"),
    `{"type":"user","message":{"role":"user","content":"cut mid-rec`,
  ].join("\n")
  expect(mod.parseHead(text)).toEqual({ cwd: "/Users/j/repo", entrypoint: "cli", title: "add terminal sessions to the app" })
})

test("listRecentSessions: interactive only, newest first, junk names skipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "projects-"))
  const proj = join(dir, "-Users-j-repo")
  mkdirSync(proj)
  const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"] as const
  writeFileSync(join(proj, `${ids[0]}.jsonl`), user("older chat about invoices", { cwd: "/Users/j/repo", entrypoint: "cli" }) + "\n")
  writeFileSync(join(proj, `${ids[1]}.jsonl`), user("newer chat about the terminal", { cwd: "/Users/j/repo", entrypoint: "cli" }) + "\n")
  writeFileSync(join(proj, `${ids[2]}.jsonl`), user("a headless dispatch run", { cwd: "/Users/j/repo", entrypoint: "sdk-cli" }) + "\n")
  writeFileSync(join(proj, "notes.jsonl"), "x\n")
  utimesSync(join(proj, `${ids[0]}.jsonl`), 1_000, 1_000)
  utimesSync(join(proj, `${ids[1]}.jsonl`), 2_000, 2_000)
  const r = await mod.listRecentSessions({ projectsDir: dir })
  expect(r.map((s) => s.sessionId)).toEqual([ids[1], ids[0]])
  expect(r[0]).toEqual({ sessionId: ids[1], cwd: "/Users/j/repo", title: "newer chat about the terminal", updatedAt: 2_000_000 })
})

test("listRecentSessions: no projects dir → []", async () => {
  expect(await mod.listRecentSessions({ projectsDir: "/nonexistent/projects" })).toEqual([])
})

test("session id shape: a uuid only", () => {
  expect(mod.SESSION_ID_RE.test("51794d7b-cf0f-4f63-9eaf-7b06cab5047e")).toBe(true)
  expect(mod.SESSION_ID_RE.test("51794d7b-cf0f-4f63-9eaf-7b06cab5047e; rm -rf ~")).toBe(false)
  expect(mod.SESSION_ID_RE.test("--help")).toBe(false)
})
