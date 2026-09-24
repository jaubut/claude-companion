import { test, expect, afterAll, afterEach } from "bun:test"
import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ESC_SETTLE_MS } from "./command-list"
import { metaFromHeaders } from "./hook-common"
import { keyGate } from "./key-gate"
import { injectText } from "./keyboard-inject"
import { recordSession, removeSessionByTmuxPane } from "./sessions"
import { capturePane } from "./tmux-pane"
import { paneKey, socketFromTmuxEnv, tmuxArgv } from "./tmux-argv"

// Pane ids are per tmux server: %3 on the durable `cc` socket is a different
// terminal from %3 on the default one. Everything here checks that a pane is
// only ever addressed on the server its hook reported.

afterEach(() => keyGate.reset())

const A = "/tmp/tmux-1000/cc"
const B = "/tmp/tmux-1000/default"

function recorder(fail?: (socket?: string) => boolean) {
  const sent: Array<{ args: readonly string[]; socket?: string; at: number }> = []
  const sendKeys = async (args: readonly string[], _t: number, _s?: AbortSignal, socket?: string) => {
    sent.push({ args, socket, at: performance.now() })
    return fail?.(socket) ? { ok: false, reason: "can't find pane: %0" } : { ok: true, reason: "" }
  }
  return { sent, sendKeys }
}

function captureStderr<T>(fn: () => Promise<T>): Promise<{ out: string; value: T }> {
  const orig = process.stderr.write.bind(process.stderr)
  let out = ""
  process.stderr.write = ((chunk: string) => { out += chunk; return true }) as typeof process.stderr.write
  return fn().then(
    (value) => { process.stderr.write = orig; return { out, value } },
    (err) => { process.stderr.write = orig; throw err },
  )
}

test("argv: -S <socket> when the session has one, plain tmux otherwise", () => {
  expect(tmuxArgv(A, ["send-keys", "-t", "%3", "Enter"])).toEqual(["tmux", "-S", A, "send-keys", "-t", "%3", "Enter"])
  expect(tmuxArgv(undefined, ["send-keys", "-t", "%3", "Enter"])).toEqual(["tmux", "send-keys", "-t", "%3", "Enter"])
  expect(tmuxArgv("", ["list-panes"])).toEqual(["tmux", "list-panes"])
})

test("socket comes from $TMUX's first comma field; junk is dropped", () => {
  expect(socketFromTmuxEnv(`${A},12345,0`)).toBe(A)
  expect(socketFromTmuxEnv("")).toBe("")
  expect(socketFromTmuxEnv("relative/sock,1,0")).toBe("")
  const h = (v: string) => new Headers({ "x-companion-tmux-pane": "%3", "x-companion-tmux-socket": v })
  expect(metaFromHeaders(h(A)).tmuxSocket).toBe(A)
  expect(metaFromHeaders(h("not-a-path")).tmuxSocket).toBe("")
  expect(metaFromHeaders(new Headers({ "x-companion-tmux-pane": "%3" })).tmuxSocket).toBe("")
})

test("key-gate lock is keyed by socket+pane; default-socket panes keep the bare %N key", () => {
  expect(paneKey("%3")).toBe("%3")
  expect(paneKey("%3", A)).not.toBe(paneKey("%3", B))
})

// No tmux subprocess in server/lib may bypass tmuxArgv — a bare "tmux" argv
// would address the default server whatever socket the session is on.
test("no bare tmux spawn left in server/lib", () => {
  const dir = import.meta.dir
  const offenders: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts") || f === "tmux-argv.ts") continue
    readFileSync(join(dir, f), "utf-8").split("\n").forEach((line, i) => {
      if (/\[\s*["'`]tmux["'`]\s*,/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
    })
  }
  expect(offenders).toEqual([])
})

test("two sockets with the same %N: the inject reaches only the session's own server", async () => {
  const r = recorder()
  expect(await injectText("to cc", { tmuxPane: "%0", tmuxSocket: A }, { sendKeys: r.sendKeys })).toBe(true)
  expect(r.sent.map((s) => s.socket)).toEqual([A, A])
  expect(r.sent.map((s) => s.args)).toEqual([["send-keys", "-t", "%0", "-l", "to cc"], ["send-keys", "-t", "%0", "Enter"]])
})

test("a %N missing on its socket is refused — never retried on the default server", async () => {
  const r = recorder((socket) => socket === A)
  const { value, out } = await captureStderr(() =>
    injectText("x", { tmuxPane: "%0", tmuxSocket: A }, { sendKeys: r.sendKeys }))
  expect(value).toBe(false)
  expect(r.sent.every((s) => s.socket === A)).toBe(true)
  expect(out).toContain(`%0 @ ${A}`)
})

test("an Escape window on %0@A does not hold up %0@B", async () => {
  await keyGate.send(paneKey("%0", A), "Escape", async () => {})
  const r = recorder()
  const t0 = performance.now()
  expect(await injectText("b", { tmuxPane: "%0", tmuxSocket: B }, { sendKeys: r.sendKeys })).toBe(true)
  expect(r.sent[0]!.at - t0).toBeLessThan(ESC_SETTLE_MS)
})

test("no socket header → the old behaviour: plain tmux, bare pane key", async () => {
  await keyGate.send("%7", "Escape", async () => {})
  const r = recorder()
  const t0 = performance.now()
  expect(await injectText("old", { tmuxPane: "%7" }, { sendKeys: r.sendKeys })).toBe(true)
  expect(r.sent.map((s) => s.socket)).toEqual([undefined, undefined])
  expect(r.sent[0]!.at - t0).toBeGreaterThanOrEqual(ESC_SETTLE_MS - 5)   // same gate key as before
})

test("companion.log '[delivered (tmux)]' line names the socket", async () => {
  const r = recorder()
  const { out } = await captureStderr(() => injectText("hi", { tmuxPane: "%4", tmuxSocket: A }, { sendKeys: r.sendKeys }))
  expect(out).toMatch(new RegExp(`delivered \\(tmux\\).*→ %4 @ ${A}`))
  const plain = await captureStderr(() => injectText("hi", { tmuxPane: "%4" }, { sendKeys: r.sendKeys }))
  expect(plain.out).toMatch(/delivered \(tmux\).*→ %4\n/)
})

test("session record: pane and socket move together", () => {
  const cwd = "/home/aubut/sock-test"
  const s1 = recordSession({ cwd, tty: "/dev/pts/77", tmuxPane: "%2", tmuxSocket: A })!
  expect(s1.tmuxSocket).toBe(A)
  // Discovery re-records the same pane without a socket: keep it.
  expect(recordSession({ cwd, tty: "/dev/pts/77", tmuxPane: "%2" })!.tmuxSocket).toBe(A)
  // A different pane with no socket is a default-server pane: never inherit.
  expect(recordSession({ cwd, tty: "/dev/pts/77", tmuxPane: "%9" })!.tmuxSocket).toBe("")
  // Removal by pane matches the socket too.
  recordSession({ cwd, tty: "/dev/pts/77", tmuxPane: "%2", tmuxSocket: A })
  expect(removeSessionByTmuxPane("%2", B)).toBe(false)
  expect(removeSessionByTmuxPane("%2", A)).toBe(true)
})

// The real thing, when tmux can run here: two private servers, each with its
// own %0. Skipped where tmux (or unix sockets) are unavailable.
async function tmux(sock: string, ...args: string[]): Promise<number> {
  try {
    return await Bun.spawn(["tmux", "-S", sock, "-f", "/dev/null", ...args], { stdout: "ignore", stderr: "ignore" }).exited
  } catch {
    return -1
  }
}
const probeDir = mkdtempSync(join(tmpdir(), "cc-sock-"))
const tmuxWorks = await (async () => {
  const s = join(probeDir, "probe")
  const ok = (await tmux(s, "new-session", "-d", "cat")) === 0
  if (ok) await tmux(s, "kill-server")
  return ok
})()
afterAll(() => rmSync(probeDir, { recursive: true, force: true }))

test.skipIf(!tmuxWorks)("real tmux: same %0 on two sockets, text lands only on the named one", async () => {
  const sa = join(probeDir, "a"); const sb = join(probeDir, "b")
  try {
    expect(await tmux(sa, "new-session", "-d", "cat")).toBe(0)
    expect(await tmux(sb, "new-session", "-d", "cat")).toBe(0)
    expect(await injectText("hello-from-A", { tmuxPane: "%0", tmuxSocket: sa })).toBe(true)
    // Missing pane on B's server: refused, nothing typed anywhere.
    expect(await injectText("ghost", { tmuxPane: "%5", tmuxSocket: sb })).toBe(false)
    await Bun.sleep(200)
    const a = await capturePane("%0", undefined, { socket: sa })
    const b = await capturePane("%0", undefined, { socket: sb })
    expect(a).toContain("hello-from-A")
    expect(b).not.toContain("hello-from-A")
    expect(b).not.toContain("ghost")
  } finally {
    await tmux(sa, "kill-server"); await tmux(sb, "kill-server")
  }
})
