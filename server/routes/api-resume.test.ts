import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// POST /api/sessions/resume: only ended sessions the server keeps.

let handleApiRoute: (req: Request, url: URL) => Promise<Response | null>

beforeAll(async () => {
  process.env.COMPANION_DB_PATH = join(mkdtempSync(join(tmpdir(), "api-resume-")), "test.db")
  handleApiRoute = (await import("./api")).handleApiRoute
})

async function resume(body: unknown): Promise<{ status: number; json: unknown }> {
  const req = new Request("http://localhost:4245/api/sessions/resume", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const res = (await handleApiRoute(req, new URL(req.url)))!
  return { status: res.status, json: await res.json() }
}

test("resume: a key the server doesn't hold → 410 target_gone, nothing typed anywhere", async () => {
  expect(await resume({ key: "ended:51794d7b-cf0f-4f63-9eaf-7b06cab5047e" })).toEqual({ status: 410, json: { ok: false, error: "target_gone" } })
  expect(await resume({ key: 42 })).toEqual({ status: 410, json: { ok: false, error: "target_gone" } })
  expect(await resume({})).toEqual({ status: 410, json: { ok: false, error: "target_gone" } })
})
