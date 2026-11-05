#!/usr/bin/env bun
/**
 * Agent-side: ask Jeremie for a secret on the phone. The value is typed into a
 * masked field in the iOS chat and goes straight to the vault — it never
 * passes through this process, so it can't land in the session transcript.
 *
 *   bun scripts/ask-secret.ts NAME --host api.example.com [--host h2] --why "reason" [--session ID]
 *
 * Prints ONE line: `saved NAME (hosts: …) — available in new sessions` (exit 0),
 * `declined` (2) or `expired` (3). Errors: `error <code>` on stderr (1), usage (64).
 * There is no way to pass a value: any extra argument is refused unseen.
 * Server: COMPANION_URL (default http://localhost:$COMPANION_PORT|4245) — the
 * hooks' URL. Local calls need no bearer; a remote URL needs COMPANION_AUTH_TOKEN.
 */

const USAGE = 'usage: ask-secret NAME --host h [--host h2] --why "reason" [--session ID]'
const token = process.env.COMPANION_AUTH_TOKEN?.trim() // only a remote COMPANION_URL needs it
const POLL_WAIT_S = 25

interface Args { name: string; hosts: string[]; why: string; session: string }

function parseArgs(argv: string[]): Args | null {
  const [name = "", ...rest] = argv
  const out: Args = { name, hosts: [], why: "", session: process.env.CLAUDE_SESSION_ID ?? "" }
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]
    const val = rest[i + 1]
    if (val === undefined) return null
    if (flag === "--host") out.hosts.push(val)
    else if (flag === "--why") out.why = val
    else if (flag === "--session") out.session = val
    else return null
  }
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(name) && out.hosts.length > 0 && out.why ? out : null
}

function finish(line: string, code: number): never {
  if (code === 1) process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
  process.exit(code)
}

async function call(base: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "x-companion-device": "ask-secret" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout((POLL_WAIT_S + 10) * 1000),
  })
  const json = await res.json().catch(() => ({})) as Record<string, unknown>
  return { status: res.status, json }
}

async function main(): Promise<never> {
  const args = parseArgs(process.argv.slice(2))
  if (!args) finish(USAGE, 64)
  const base = process.env.COMPANION_URL ?? `http://localhost:${Number(process.env.COMPANION_PORT) || 4245}`

  const created = await call(base, "POST", "/hooks/vault/requests", { name: args.name, hosts: args.hosts, reason: args.why, session_id: args.session })
    .catch(() => ({ status: 0, json: { error: "unreachable" } as Record<string, unknown> }))
  if (created.status !== 200 || typeof created.json.id !== "string") finish(`error ${String(created.json.error ?? `http_${created.status}`)}`, 1)
  const id = created.json.id
  const expires = Date.parse(String(created.json.expires_at))
  const deadline = (Number.isFinite(expires) ? expires : Date.now() + 15 * 60_000) + 5_000

  while (Date.now() < deadline) {
    const r = await call(base, "GET", `/hooks/vault/requests/${id}?wait=${POLL_WAIT_S}`).catch(() => null)
    if (!r) { await Bun.sleep(2_000); continue }
    // 404 = the server restarted and lost the request: same as expired.
    if (r.status === 404) finish("expired", 3)
    if (r.status === 429) { await Bun.sleep(Math.max(1, Number(r.json.retry_after) || 5) * 1000); continue }
    const status = r.json.status
    if (status === "saved") finish(`saved ${args.name} (hosts: ${args.hosts.join(", ")}) — available in new sessions`, 0)
    if (status === "declined") finish("declined", 2)
    if (status === "expired") finish("expired", 3)
    if (r.status !== 200) await Bun.sleep(2_000)
  }
  finish("expired", 3)
}

await main()
