import { test, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchSubmit } from "../lib/submit-confirm"

// /hooks/user-prompt-submit tells the hook whether the prompt is a phone
// inject (a pending watchSubmit matched), and companion-user-prompt.sh turns
// that into Claude Code's additionalContext — and nothing otherwise.

let handleHookRoute: (req: Request, url: URL) => Promise<Response | null>

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-origin-"))
  process.env.COMPANION_DB_PATH = join(dir, "test.db")
  handleHookRoute = (await import("./hooks")).handleHookRoute
})

async function submit(sessionId: string, tty: string): Promise<unknown> {
  const url = new URL("http://localhost:4245/hooks/user-prompt-submit")
  const req = new Request(url.href, {
    method: "POST",
    headers: { "content-type": "application/json", "x-companion-tty": tty },
    body: JSON.stringify({ session_id: sessionId, prompt: "hello there" }),
  })
  const res = await handleHookRoute(req, url)
  return res?.json()
}

test("route: fromPhone=true for the prompt a pending phone inject waits on", async () => {
  const watch = watchSubmit({ sessionId: "origin-a", tty: "/dev/ttys901" })
  try {
    expect(await submit("origin-a", "/dev/ttys901")).toEqual({ fromPhone: true })
    // The inject already got its hook: a later prompt in that window is the terminal's.
    expect(await submit("origin-a", "/dev/ttys901")).toEqual({ fromPhone: false })
  } finally {
    watch.close()
  }
})

test("route: fromPhone=false for a prompt typed at the terminal", async () => {
  expect(await submit("origin-b", "/dev/ttys902")).toEqual({ fromPhone: false })
  const other = watchSubmit({ sessionId: "origin-c", tty: "/dev/ttys903" })
  try {
    expect(await submit("origin-b", "/dev/ttys902")).toEqual({ fromPhone: false })
  } finally {
    other.close()
  }
})

test("route: a slash-command inject never marks a prompt as from the phone", async () => {
  const watch = watchSubmit({ sessionId: "origin-d", tty: "/dev/ttys904" }, { boundary: true })
  try {
    expect(await submit("origin-d", "/dev/ttys904")).toEqual({ fromPhone: false })
  } finally {
    watch.close()
  }
})

// ── The hook script, against a stub server ──

const HOOK = join(import.meta.dir, "..", "..", "hooks", "companion-user-prompt.sh")
let stub: ReturnType<typeof Bun.serve>
let answer: () => Response | Promise<Response> = () => Response.json({ fromPhone: false })
const bodies: unknown[] = []

beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/hooks/user-prompt-submit") return new Response("nope", { status: 404 })
      bodies.push(await req.json())
      return answer()
    },
  })
})
afterAll(() => stub.stop(true))

async function runHook(url: string): Promise<{ code: number; out: string; ms: number }> {
  const t0 = performance.now()
  const p = Bun.spawn(["bash", HOOK], {
    env: { ...process.env as Record<string, string>, COMPANION_URL: url },
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "s", prompt: "hi", hook_event_name: "UserPromptSubmit" })),
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = await new Response(p.stdout).text()
  const code = await p.exited
  return { code, out, ms: performance.now() - t0 }
}

test("hook: prints the additionalContext JSON when the server says fromPhone", async () => {
  answer = () => Response.json({ fromPhone: true })
  const before = bodies.length
  const r = await runHook(`http://127.0.0.1:${stub.port}`)
  expect(r.code).toBe(0)
  expect(bodies.length).toBe(before + 1)
  const parsed = JSON.parse(r.out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
  expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
  expect(parsed.hookSpecificOutput.additionalContext).toContain("iPhone via Companion")
})

test("hook: prints nothing for a terminal-typed prompt", async () => {
  answer = () => Response.json({ fromPhone: false })
  expect(await runHook(`http://127.0.0.1:${stub.port}`)).toMatchObject({ code: 0, out: "" })
})

test("hook: prints nothing on an older server's empty answer or an error", async () => {
  answer = () => Response.json({})
  expect(await runHook(`http://127.0.0.1:${stub.port}`)).toMatchObject({ code: 0, out: "" })
  answer = () => new Response("boom", { status: 500 })
  expect(await runHook(`http://127.0.0.1:${stub.port}`)).toMatchObject({ code: 0, out: "" })
})

test("hook: server down → nothing, exit 0", async () => {
  const dead = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = dead.port
  dead.stop(true)
  expect(await runHook(`http://127.0.0.1:${port}`)).toMatchObject({ code: 0, out: "" })
})

test("hook: a slow server is cut off at ~1 s and prints nothing", async () => {
  answer = () => new Promise((resolve) => setTimeout(() => resolve(Response.json({ fromPhone: true })), 3_000))
  const r = await runHook(`http://127.0.0.1:${stub.port}`)
  expect(r).toMatchObject({ code: 0, out: "" })
  expect(r.ms).toBeLessThan(2_500)
}, 10_000)
