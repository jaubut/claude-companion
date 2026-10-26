import { test, expect } from "bun:test"
import { TERMINAL_ENDED, openTerminal, parseTerminalSize, shellNetworkRefusal, parseControl, terminalAttachArgv, terminalEnv, terminalSize, type PtySpawner } from "./terminal-bridge"
import type { ShellSession } from "./shell-sessions"
import { recordPeer } from "./vault-guard"

// The /api/terminal bridge: phone socket ↔ `tmux attach-session` under a PTY.

const SHELL: ShellSession = { key: "shell:sh-a", name: "sh-a", cwd: "/x", tmuxPane: "%7", tmuxSocket: "/tmp/tmux-501/cc", createdAt: 1, panePid: 0, claudeKey: "" }

test("attach argv: exact-match session on the shell's own tmux server", () => {
  expect(terminalAttachArgv(SHELL)).toEqual(["tmux", "-S", "/tmp/tmux-501/cc", "attach-session", "-t", "=sh-a"])
  expect(terminalAttachArgv({ name: "sh-a", tmuxSocket: "" })).toEqual(["tmux", "attach-session", "-t", "=sh-a"])
})

test("size: clamped integers, junk → phone default", () => {
  expect(terminalSize("80", "24")).toEqual({ cols: 80, rows: 24 })
  expect(terminalSize("2", "9999")).toEqual({ cols: 20, rows: 200 })
  expect(terminalSize(null, "x")).toEqual({ cols: 50, rows: 30 })
  expect(terminalSize("40.5", "-1")).toEqual({ cols: 50, rows: 5 })
})

test("env: xterm-256color, $TMUX dropped so attach is not refused as nested", () => {
  const env = terminalEnv({ TMUX: "/tmp/x,1,0", TMUX_PANE: "%1", HOME: "/h", LANG: "fr_CA.UTF-8" })
  expect(env).toEqual({ HOME: "/h", LANG: "fr_CA.UTF-8", TERM: "xterm-256color" })
})

test("control: only resize frames parse", () => {
  expect(parseControl(`{"type":"resize","cols":100,"rows":40}`)).toEqual({ cols: 100, rows: 40 })
  expect(parseControl(`{"type":"input","data":"ls"}`)).toBeNull()
  expect(parseControl("ls -la")).toBeNull()
})

function fakePty() {
  const writes: Uint8Array[] = []
  const resizes: [number, number][] = []
  let closed = 0
  let exit!: (code: number) => void
  let emit!: (d: Uint8Array) => void
  let argv: string[] = []
  const spawner: PtySpawner = (a, _size, onData) => {
    argv = a
    emit = onData
    return {
      write: (d) => writes.push(typeof d === "string" ? new TextEncoder().encode(d) : d),
      resize: (c, r) => resizes.push([c, r]),
      close: () => { closed++ },
      exited: new Promise<number>((r) => { exit = r }),
    }
  }
  return { spawner, writes, resizes, closed: () => closed, exit: (c: number) => exit(c), emit: (d: Uint8Array) => emit(d), argv: () => argv }
}

function fakeSock() {
  const sent: Uint8Array[] = []
  const ends: [number, string][] = []
  return { sock: { send: (d: Uint8Array) => sent.push(d), end: (c: number, r: string) => ends.push([c, r]) }, sent, ends }
}

test("bridge: output → socket, binary input → PTY, resize frame → resize, other text ignored", () => {
  const p = fakePty()
  const s = fakeSock()
  const t = openTerminal(SHELL, { cols: 50, rows: 30 }, s.sock, p.spawner)
  expect(p.argv()).toEqual(terminalAttachArgv(SHELL))
  p.emit(new TextEncoder().encode("$ "))
  expect(new TextDecoder().decode(s.sent[0])).toBe("$ ")
  t.input(Buffer.from("ls\r"))
  t.input(`{"type":"resize","cols":90,"rows":33}`)
  t.input("rm -rf /")
  expect(p.writes.map((w) => new TextDecoder().decode(w))).toEqual(["ls\r"])
  expect(p.resizes).toEqual([[90, 33]])
})

test("bridge: the attach ends (shell exit) → socket closed 4000 ended, onEnded called", async () => {
  const p = fakePty()
  const s = fakeSock()
  let ended = 0
  openTerminal(SHELL, { cols: 50, rows: 30 }, s.sock, p.spawner, () => { ended++ })
  p.exit(0)
  await Bun.sleep(0)
  expect(s.ends).toEqual([[TERMINAL_ENDED, "ended"]])
  expect(ended).toBe(1)
})

test("bridge: phone closes → PTY closed once (detach only), nothing written after", async () => {
  const p = fakePty()
  const s = fakeSock()
  const t = openTerminal(SHELL, { cols: 50, rows: 30 }, s.sock, p.spawner)
  t.close()
  t.close()
  t.input(Buffer.from("late"))
  p.emit(new TextEncoder().encode("late output"))
  p.exit(0)
  await Bun.sleep(0)
  expect(p.closed()).toBe(1)
  expect(p.writes).toEqual([])
  expect(s.sent).toEqual([])
  expect(s.ends).toEqual([])
})

test("upgrade size: integers in range only, else refused", () => {
  expect(parseTerminalSize("50", "30")).toEqual({ cols: 50, rows: 30 })
  expect(parseTerminalSize("500", "200")).toEqual({ cols: 500, rows: 200 })
  for (const [c, r] of [["19", "30"], ["501", "30"], ["50", "4"], ["50", "201"], ["5e1", "30"], ["-50", "30"], ["50.0", "30"], [null, "30"], ["50", ""], ["99999", "30"]] as const) {
    expect(parseTerminalSize(c, r)).toBeNull()
  }
})

// The vault's network rule (lib/vault-guard.ts clientOrigin) for shells.
function from(peer: string, headers: Record<string, string> = {}): Request {
  const req = new Request("http://host:4245/api/terminal", { headers })
  recordPeer(req, peer)
  return req
}

test("network gate: a LAN peer is refused 403 network_refused, even with a forged XFF", async () => {
  for (const req of [from("192.168.2.40"), from("192.168.2.40", { "x-forwarded-for": "100.101.102.103" })]) {
    const r = shellNetworkRefusal(req)
    expect(r?.status).toBe(403)
    expect(await r?.json()).toEqual({ ok: false, error: "network_refused" })
  }
})

test("network gate: Funnel traffic through tailscale serve is refused", () => {
  expect(shellNetworkRefusal(from("127.0.0.1", { "x-forwarded-for": "100.101.102.103", "tailscale-funnel-request": "?1" }))?.status).toBe(403)
})

test("network gate: tailscale serve (loopback + tailnet XFF), plain loopback and a direct 100.x peer pass", () => {
  expect(shellNetworkRefusal(from("127.0.0.1", { "x-forwarded-for": "100.101.102.103" }))).toBeNull()
  expect(shellNetworkRefusal(from("127.0.0.1"))).toBeNull()
  expect(shellNetworkRefusal(from("100.88.1.2"))).toBeNull()
})

test("network gate: no recorded peer is refused", () => {
  expect(shellNetworkRefusal(new Request("http://host/api/terminal"))?.status).toBe(403)
})
