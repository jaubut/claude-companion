import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getPending, resolveApproval } from "../lib/pty-manager"
import { recordAllow, useLearnedAllowDb } from "../lib/learned-allow"
import { getHistoryItem, listHistory, useApprovalHistoryDb, type HistoryItem } from "../lib/approval-history"
import { autoHistoryStats, flushAutoHistory } from "../lib/approval-history-auto"
import { isSuperAuto, setSuperAutoInMemoryForTests } from "../lib/super-auto"
import { clients } from "../state"

// Route-level: every automatic PreToolUse decision (SUPER, auto-judge allow /
// deny, learned, read-only MCP; Claude and Codex) lands in approval_history as
// an auto row, off the hook path; phone escalations are unchanged; the API
// filters / stats and the throttled `approval_history_auto` frame.

type Route = (req: Request, url: URL) => Promise<Response | null>
let handleHookRoute: Route
let handleApiRoute: Route
const superWas = isSuperAuto()
const frames: Array<Record<string, unknown>> = []
const fake = { send: (m: string) => { frames.push(JSON.parse(m)) } } as unknown as Parameters<typeof clients.add>[0]

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "appr-hist-auto-route-"))
  process.env.COMPANION_DB_PATH = join(dir, "test.db")
  useLearnedAllowDb(join(dir, "learned.db"))
  useApprovalHistoryDb(join(dir, "history.db"))
  await import("../wiring/events")
  handleHookRoute = (await import("./hooks")).handleHookRoute
  handleApiRoute = (await import("./api")).handleApiRoute
  clients.add(fake)
  setSuperAutoInMemoryForTests(false)
})
afterAll(() => {
  setSuperAutoInMemoryForTests(superWas)
  clients.delete(fake)
})

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`http://localhost:4245${path}`)
  return [new Request(url.href, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), url]
}
const preTool = (sid: string, tool: string, input: Record<string, unknown>, headers: Record<string, string> = {}) =>
  handleHookRoute(...req("POST", "/hooks/pre-tool-use", { session_id: sid, tool_name: tool, tool_input: input, cwd: `/tmp/${sid}`, tool_use_id: `tu-${sid}` }, headers))
const autoRows = (sid: string): HistoryItem[] => listHistory({ state: "auto", q: `/tmp/${sid}`, limit: 200 }).items
async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = (await handleApiRoute(...req("GET", path)))!
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

test("no per-row frame for auto rows; one throttled approval_history_auto frame", async () => {
  const mark = frames.length
  setSuperAutoInMemoryForTests(true)
  try {
    for (let i = 0; i < 5; i++) await preTool("aa-frame", "Bash", { command: `zz-frame ${i}` })
  } finally { setSuperAutoInMemoryForTests(false) }
  flushAutoHistory()
  // Leading edge, or the trailing frame when another file's flush holds the window.
  for (let i = 0; i < 120 && !frames.slice(mark).some((f) => f.type === "approval_history_auto"); i++) await Bun.sleep(50)
  const auto = frames.slice(mark).filter((f) => f.type === "approval_history_auto")
  expect(auto.length).toBe(1)
  expect(auto[0]!.count as number).toBeGreaterThanOrEqual(5)
  expect(typeof auto[0]!.since).toBe("string")
  expect(frames.slice(mark).some((f) => f.type === "approval_history")).toBe(false)
  // A second burst inside the 5 s window: no frame yet.
  setSuperAutoInMemoryForTests(true)
  try { await preTool("aa-frame2", "Bash", { command: "zz-frame2" }) } finally { setSuperAutoInMemoryForTests(false) }
  flushAutoHistory()
  await Bun.sleep(50)
  expect(frames.slice(mark).filter((f) => f.type === "approval_history_auto").length).toBe(1)
}, 15_000)

test("SUPER allow → auto_allowed/super, written after the response, not before", async () => {
  setSuperAutoInMemoryForTests(true)
  try {
    const out = await (await preTool("aa-super", "Bash", { command: "zz-aa-super --flag" }))!.json() as { hookSpecificOutput: { permissionDecision: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow")
  } finally { setSuperAutoInMemoryForTests(false) }
  expect(autoRows("aa-super")).toEqual([])
  flushAutoHistory()
  const [r] = autoRows("aa-super")
  expect(r).toMatchObject({ state: "auto_allowed", decided_via: "super", tool: "Bash", summary: "zz-aa-super --flag", session_id: "aa-super", cwd: "/tmp/aa-super" })
  expect(r!.resolved_at).toBe(r!.created_at)
  expect(getHistoryItem(r!.id)!.detail).toEqual({ agent: "claude", input: { command: "zz-aa-super --flag" }, reason: "SUPER mode", toolUseId: "tu-aa-super" })
})

test("auto-judge allow / deny → auto_allowed|auto_denied / auto_judge", async () => {
  await preTool("aa-judge", "Bash", { command: "cat /etc/hostname" })
  const deny = await (await preTool("aa-deny", "Bash", { command: "rm -rf /" }))!.json() as { hookSpecificOutput: { permissionDecision: string } }
  expect(deny.hookSpecificOutput.permissionDecision).toBe("deny")
  flushAutoHistory()
  expect(autoRows("aa-judge")).toMatchObject([{ state: "auto_allowed", decided_via: "auto_judge" }])
  const [d] = autoRows("aa-deny")
  expect(d).toMatchObject({ state: "auto_denied", decided_via: "auto_judge" })
  expect(getHistoryItem(d!.id)!.detail).toMatchObject({ reason: "matches the destructive-command denylist" })
})

test("learned allow → learned; read-only MCP → mcp_readonly; Codex agent kept in detail", async () => {
  recordAllow("Bash", { command: "zz-aa-learned run" })
  await preTool("aa-learned", "Bash", { command: "zz-aa-learned run" })
  await preTool("aa-mcp", "mcp__drive__get_file", { id: "1" })
  await preTool("aa-codex", "shell", { command: "ls -la" }, { "x-companion-agent": "codex" })
  flushAutoHistory()
  expect(autoRows("aa-learned")).toMatchObject([{ state: "auto_allowed", decided_via: "learned" }])
  expect(autoRows("aa-mcp")).toMatchObject([{ state: "auto_allowed", decided_via: "mcp_readonly", tool: "mcp__drive__get_file" }])
  const [c] = autoRows("aa-codex")
  expect(c).toMatchObject({ state: "auto_allowed", decided_via: "auto_judge" })
  expect(getHistoryItem(c!.id)!.detail).toMatchObject({ agent: "codex" })
})

test("phone path unchanged: no auto row, pending → allowed/phone with per-row frames", async () => {
  const before = autoHistoryStats().rows + autoHistoryStats().buffered
  const res = preTool("aa-phone", "Bash", { command: "zz-aa-phone --flag" })
  let p: { id: string } | undefined
  for (let i = 0; i < 200 && !p; i++) { p = getPending().find((x) => x.sessionId === "aa-phone"); if (!p) await Bun.sleep(5) }
  expect(resolveApproval(p!.id, "allow")).toBe(true)
  await res
  flushAutoHistory()
  expect(autoHistoryStats().rows).toBe(before)
  expect(autoRows("aa-phone")).toEqual([])
  expect(getHistoryItem(p!.id)).toMatchObject({ state: "allowed", decided_via: "phone" })
  const states = frames.filter((f) => f.type === "approval_history" && (f.item as { id: string }).id === p!.id).map((f) => (f.item as { state: string }).state)
  expect(states).toEqual(["pending", "allowed"])
})

test("100 rapid SUPER hooks: fast responses, no sqlite on the hook path, ≤ a few transactions", async () => {
  flushAutoHistory()
  const s0 = autoHistoryStats()
  const times: number[] = []
  setSuperAutoInMemoryForTests(true)
  try {
    for (let i = 0; i < 100; i++) {
      const t = performance.now()
      await preTool("aa-burst", "Bash", { command: `zz-burst ${i}` })
      times.push(performance.now() - t)
    }
  } finally { setSuperAutoInMemoryForTests(false) }
  times.sort((a, b) => a - b)
  expect(times[94]!).toBeLessThan(25) // p95
  for (let i = 0; i < 100 && autoHistoryStats().buffered > 0; i++) await Bun.sleep(10)
  const s1 = autoHistoryStats()
  expect(s1.rows - s0.rows).toBe(100)
  expect(s1.transactions - s0.transactions).toBeLessThanOrEqual(4)
  expect(autoRows("aa-burst").length).toBe(100)
})

test("GET list: default/all exclude auto; auto, auto_denied, everything; stats", async () => {
  flushAutoHistory()
  const states = async (q: string) => ((await getJson(`/api/approvals/history?limit=200${q}`)).body.items as HistoryItem[]).map((i) => i.state)
  const def = await states("")
  expect(def.length).toBeGreaterThan(0)
  expect(def.some((s) => s.startsWith("auto_"))).toBe(false)
  expect((await states("&state=all")).some((s) => s.startsWith("auto_"))).toBe(false)
  expect((await states("&state=resolved")).some((s) => s.startsWith("auto_"))).toBe(false)
  const auto = await states("&state=auto")
  expect(auto.length).toBeGreaterThan(100)
  expect(auto.every((s) => s === "auto_allowed" || s === "auto_denied")).toBe(true)
  expect(await states("&state=auto_denied&q=aa-deny")).toEqual(["auto_denied"])
  const every = await states("&state=everything&q=aa-")
  expect(every).toContain("allowed")
  expect(every).toContain("auto_allowed")

  const stats = await getJson("/api/approvals/history/stats")
  expect(stats.status).toBe(200)
  const counts = stats.body.counts as Record<string, number>
  expect(Object.keys(counts).sort()).toEqual(["allowed", "answered", "auto_allowed", "auto_denied", "denied", "elsewhere", "expired", "pending"])
  expect(counts.auto_allowed).toBeGreaterThanOrEqual(100)
  expect(counts.auto_denied).toBeGreaterThanOrEqual(1)
  expect(counts.allowed).toBeGreaterThanOrEqual(1)
  const future = await getJson(`/api/approvals/history/stats?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)
  expect(Object.values(future.body.counts as Record<string, number>).every((v) => v === 0)).toBe(true)
  expect((await getJson("/api/approvals/history/stats?since=garbage")).status).toBe(400)
  expect((await getJson("/api/approvals/history?state=autox")).status).toBe(400)
})
