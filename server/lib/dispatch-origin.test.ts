import { expect, test } from "bun:test"
import { claimLive } from "./dispatch-live"
import { type FileInput, type WriteCtx, fileTask } from "./dispatch-tasks"
import type { SqlArg } from "./turso"

// The Turso queue guard refuses a `queued` insert unless origin is trusted, so a
// tap/typed filing must write origin "jeremie"; anything else leaves it unset.
function ctx(origin: boolean) {
  const inserts: { sql: string; args: SqlArg[] }[] = []
  const c: WriteCtx = {
    exec: async (sql, args) => { if (sql.startsWith("INSERT OR IGNORE INTO tasks")) inserts.push({ sql, args }); return { rows: [], affected: 1 } },
    cols: { prUrl: true, resultRef: true, ...(origin ? { origin: true } : {}) }, host: "zettlab", channel: null,
  }
  return { c, inserts }
}
const input = (o?: "jeremie"): FileInput => ({ id: "a".repeat(32), noteId: "projects/x", agent: "builder", title: "T", description: "d", ...(o ? { origin: o } : {}) })

test("fileTask and claimLive write origin jeremie when the column exists", async () => {
  for (const file of [fileTask, claimLive]) {
    const { c, inserts } = ctx(true)
    await file(c, input("jeremie"))
    expect(inserts[0]!.sql).toContain(", origin)")
    expect(inserts[0]!.args.at(-1)).toBe("jeremie")
  }
})

test("no trusted origin (auto-dispatch, #Body) or no column → origin not written", async () => {
  for (const [col, o] of [[true, undefined], [false, "jeremie"]] as const) {
    const { c, inserts } = ctx(col)
    await fileTask(c, input(o))
    expect(inserts[0]!.sql).not.toContain("origin")
    expect(inserts[0]!.args).not.toContain("jeremie")
  }
})
