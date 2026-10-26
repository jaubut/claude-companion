// herdr's JSON API over its unix socket, without the CLI. One request per
// connection: herdr writes one NDJSON reply line and closes (measured on
// 0.9.5; a second request on the same connection is never answered). The CLI
// costs a process per call (`pane read` p50 4.3 ms); the socket p50 is 0.1 ms
// idle and 0.7 ms with Claude streaming, cheap enough to poll a pane's screen
// for the live mirror (lib/pane-mirror.ts).

export const HERDR_SOCKET_PATH = process.env.HERDR_SOCKET_PATH
  || `${process.env.HOME}/.config/herdr/herdr.sock`

export class HerdrSocketError extends Error {
  constructor(public code: string, message: string) { super(message) }
}

let seq = 0

// The `result` of one request, or throws HerdrSocketError (herdr's own error
// code, or socket_closed / timeout / connect_failed).
export function herdrSocketCall(
  method: string,
  params: Record<string, unknown>,
  opts: { socketPath?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const id = `cc${++seq}`
  return new Promise((resolve, reject) => {
    let buf = ""
    let done = false
    const finish = (err: HerdrSocketError | null, result?: Record<string, unknown>) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(result ?? {})
    }
    const timer = setTimeout(() => finish(new HerdrSocketError("timeout", `herdr ${method}: timeout`)), opts.timeoutMs ?? 2_000)
    Bun.connect({
      unix: opts.socketPath ?? HERDR_SOCKET_PATH,
      socket: {
        open(s) { s.write(JSON.stringify({ id, method, params }) + "\n") },
        data(s, d) {
          buf += d.toString()
          const nl = buf.indexOf("\n")
          if (nl < 0) return
          // Settle before end(): Bun runs close() synchronously inside end().
          try {
            const m = JSON.parse(buf.slice(0, nl)) as { result?: Record<string, unknown>; error?: { code?: string; message?: string } }
            if (m.error) finish(new HerdrSocketError(m.error.code ?? "error", m.error.message ?? method))
            else finish(null, m.result)
          } catch {
            finish(new HerdrSocketError("bad_output", `herdr ${method}: unreadable reply`))
          }
          s.end()
        },
        close() { finish(new HerdrSocketError("socket_closed", `herdr ${method}: closed before reply`)) },
        error(_s, e) { finish(new HerdrSocketError("socket_error", e.message)) },
      },
    }).catch((e: Error) => finish(new HerdrSocketError("connect_failed", e.message)))
  })
}
